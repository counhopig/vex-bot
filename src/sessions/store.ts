/**
 * Session store — WebChat UI session list + per-session transcript persistence.
 *
 * Architecture: class-based, NO process-global singleton. The web/server.ts
 * bootstrap (when built) owns the instance and passes a per-user storePath
 * (`users/{userId}/sessions`). The default path is `~/.vex/sessions/`,
 * matching the archive's behavior for non-WebChat flows.
 *
 * Two persistence layers coexist under the same session directory, with
 * distinct responsibilities:
 *   1. THIS store — flat `<sessionId>.jsonl` files it appends to, the
 *      source of truth for what the WebChat UI renders (session list,
 *      history panel).
 *   2. pi-coding-agent's SessionManager — nested per-session logs it
 *      owns, the source of truth for the LLM conversation context.
 *
 * They stay coherent only because both are keyed off the same sessionKey
 * (channel:sender): restoring a session in the UI just repoints the client
 * at a sessionKey, and pi reloads that key's context on the next turn.
 * The recovery / canonicalization logic below reads pi's nested logs back
 * into the UI list; it never writes into pi's files.
 *
 * Safety:
 *   - Atomic index write (temp + rename); no half-written `sessions.json`.
 *   - Write-lock around read-modify-write so concurrent getOrCreate /
 *     append / delete cannot lose updates or interleave.
 *   - `delete()` actually removes transcript files from disk; it does not
 *     rename them to `.deleted.*` files that would linger forever.
 *   - The custom store path runs through `expandHomePath` so `~/foo`
 *     points at the user's home, not a literal `~` subdir of cwd.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";

import { getChildLogger } from "../utils/logger.js";
import { expandHomePath, isPathInside } from "../utils/path.js";
import type {
  SessionEntry,
  SessionListItem,
  SessionListOptions,
  TranscriptHeader,
  TranscriptMessage,
} from "./types.js";

const logger = getChildLogger("sessions");

/** Current transcript file format version. */
const TRANSCRIPT_VERSION = 1;

/** Default store directory when the caller passes no path. */
export const DEFAULT_SESSION_STORE_PATH = path.join(os.homedir(), ".vex", "sessions");

/**
 * Minimal async mutex. FIFO ordering is not promised — we just need
 * "no two writers interleaving" — but the underlying Promise queue gives
 * us that for free because all acquires happen on the microtask queue.
 */
class WriteLock {
  #locked = false;
  #queue: Array<() => void> = [];

  acquire(): Promise<void> {
    if (!this.#locked) {
      this.#locked = true;
      return Promise.resolve();
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#queue.push(resolve);
    return promise;
  }

  release(): void {
    const next = this.#queue.shift();
    if (next) {
      next();
    } else {
      this.#locked = false;
    }
  }
}

/**
 * File-backed session index + transcript store. No process-global state —
 * every consumer (per-Web-user server bootstrap, CLI diagnostics) instantiates
 * its own. The constructor takes the directory to use; that directory is the
 * boundary that separates one user's sessions from another's.
 */
export class FileSessionStore {
  readonly #storePath: string;
  readonly #indexFile: string;
  #cache: Map<string, SessionEntry> = new Map();
  /** sessionId → canonical sessionKey for the lifetime of a single load. */
  #recoveredKeyBySessionId: Map<string, string> = new Map();
  readonly #writeLock = new WriteLock();

  constructor(storePath?: string) {
    const raw = storePath ?? DEFAULT_SESSION_STORE_PATH;
    this.#storePath = expandHomePath(raw);
    this.#indexFile = path.join(this.#storePath, "sessions.json");
    this.#ensureDirectory();
  }

  /** Underlying on-disk directory (useful for tests + debugging). */
  get storePath(): string {
    return this.#storePath;
  }

  /** Run fn while holding the write lock, so a read-modify-write of the
   *  index (and its paired transcript file write) cannot interleave with
   *  another. */
  async #withLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.#writeLock.acquire();
    try {
      return await fn();
    } finally {
      this.#writeLock.release();
    }
  }

  #ensureDirectory(): void {
    if (!fs.existsSync(this.#storePath)) {
      fs.mkdirSync(this.#storePath, { recursive: true });
      logger.info({ path: this.#storePath }, "Created sessions directory");
    }
  }

  /** Load the in-memory index. Cold load runs the recovery scanner; subsequent
   *  calls serve the cache directly. The 30s-TTL re-scan that used to
   *  re-tokenize every user's full transcript on a timer is gone — the
   *  in-process cache is authoritative after the first load. */
  async #loadIndex(): Promise<Map<string, SessionEntry>> {
    if (this.#cache.size > 0) return this.#cache;

    if (!fs.existsSync(this.#indexFile)) {
      const recovered = await this.#recoverIndexFromTranscripts();
      if (recovered.size > 0) {
        await this.#saveIndexUnlocked(recovered);
      }
      this.#cache = recovered;
      return this.#cache;
    }

    try {
      const content = await fs.promises.readFile(this.#indexFile, "utf-8");
      const data = JSON.parse(content) as Record<string, SessionEntry>;
      this.#cache = new Map(Object.entries(data));

      const recovered = await this.#recoverIndexFromTranscripts();

      // Heal legacy indexes written before session keys were classified
      // correctly: drop cache rows whose sessionId now resolves to a
      // different (canonical) key. Transcript files are not touched.
      let changed = false;
      for (const [existingKey, existingEntry] of this.#cache) {
        const canonicalKey = this.#recoveredKeyBySessionId.get(existingEntry.sessionId);
        if (canonicalKey && canonicalKey !== existingKey) {
          this.#cache.delete(existingKey);
          changed = true;
        }
      }
      for (const [sessionKey, entry] of recovered) {
        for (const [existingKey, existingEntry] of this.#cache) {
          if (existingKey !== sessionKey && existingEntry.sessionId === entry.sessionId) {
            this.#cache.delete(existingKey);
            changed = true;
          }
        }
        const current = this.#cache.get(sessionKey);
        if (!current) {
          this.#cache.set(sessionKey, entry);
          changed = true;
        } else if (!current.transcriptFile && entry.transcriptFile) {
          this.#cache.set(sessionKey, {
            ...entry,
            ...current,
            transcriptFile: entry.transcriptFile,
          });
          changed = true;
        }
      }
      if (changed) await this.#saveIndexUnlocked(this.#cache);
      return this.#cache;
    } catch (error) {
      logger.error({ error }, "Failed to load session index");
      const recovered = await this.#recoverIndexFromTranscripts();
      this.#cache = recovered;
      return this.#cache;
    }
  }

  /** Rebuild the index from on-disk transcripts when `sessions.json` is
   *  missing or corrupt. Pure read — never writes transcript files. */
  async #recoverIndexFromTranscripts(): Promise<Map<string, SessionEntry>> {
    const index = new Map<string, SessionEntry>();
    this.#recoveredKeyBySessionId = new Map();
    const files = await this.#findTranscriptFiles();

    for (const file of files) {
      const transcriptPath = path.isAbsolute(file) ? file : path.join(this.#storePath, file);
      let content: string;
      try {
        content = await fs.promises.readFile(transcriptPath, "utf-8");
      } catch (error) {
        logger.warn({ error, transcriptPath }, "Failed to read transcript during recovery");
        continue;
      }
      const lines = content.split("\n").filter((line) => line.trim());
      if (lines.length === 0) continue;

      let header: Partial<TranscriptHeader> & { id?: string };
      try {
        header = JSON.parse(lines[0]!) as Partial<TranscriptHeader> & { id?: string };
      } catch {
        continue;
      }
      if (header.type !== "session") continue;

      const relativePath = path.relative(this.#storePath, transcriptPath);
      const pathSessionKey = relativePath.split(path.sep)[0]?.replace(/\.jsonl$/, "");
      const sessionId = header.sessionId ?? header.id;
      // pi-coding-agent's nested logs omit sessionKey and live in a directory
      // whose name is sanitizeSessionKey("<channel>:<sender>") — the ":"
      // separator was replaced with "_". Rebuild the canonical key so channel
      // classification and de-duplication against flat records both work.
      const sessionKey =
        header.sessionKey ??
        (pathSessionKey ? this.#canonicalizeSanitizedKey(pathSessionKey) : undefined);
      if (!sessionId || !sessionKey) continue;
      this.#recoveredKeyBySessionId.set(sessionId, sessionKey);

      let messageCount = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      let totalTokens = 0;
      let model: string | undefined;
      let provider: string | undefined;

      for (const line of lines.slice(1)) {
        try {
          const entry = JSON.parse(line) as Record<string, unknown>;
          if (entry.type === "model_change") {
            if (typeof entry.provider === "string") provider = entry.provider;
            if (typeof entry.modelId === "string") model = entry.modelId;
            continue;
          }
          const message = this.#toTranscriptMessage(entry);
          if (!message.role) continue;
          messageCount++;
          inputTokens += message.usage?.promptTokens ?? 0;
          outputTokens += message.usage?.completionTokens ?? 0;
          totalTokens += message.usage?.totalTokens ?? 0;
          if (message.model) model = message.model;
          if (message.provider) provider = message.provider;
        } catch {
          // Ignore malformed transcript lines during best-effort recovery.
        }
      }

      let stat;
      try {
        stat = await fs.promises.stat(transcriptPath);
      } catch {
        continue;
      }
      const createdAt = Date.parse(header.timestamp ?? "") || stat.birthtimeMs || stat.ctimeMs;
      const candidate: SessionEntry = {
        sessionId,
        sessionKey,
        createdAt,
        updatedAt: stat.mtimeMs,
        transcriptFile: transcriptPath,
        channel: sessionKey.split(":")[0],
        messageCount,
        inputTokens,
        outputTokens,
        totalTokens,
        model,
        provider,
      };

      // One canonical key can map to several runtime logs (one per process
      // restart). Keep the most recent segment as the representative entry
      // so the list stays consistent with what loadTranscript returns.
      const existing = index.get(sessionKey);
      if (!existing || candidate.updatedAt >= existing.updatedAt) {
        index.set(sessionKey, {
          ...candidate,
          createdAt: existing
            ? Math.min(existing.createdAt, candidate.createdAt)
            : candidate.createdAt,
        });
      }
    }

    if (index.size > 0) {
      logger.info(
        { count: index.size, path: this.#storePath },
        "Recovered session index from transcripts",
      );
    }
    return index;
  }

  /**
   * Rebuild a canonical "<channel>:<sender>" session key from an AgentRuntime
   * directory name produced by sanitizeSessionKey (which replaces the ":"
   * separator with "_"). Channel ids never contain "_", so the first "_" is
   * always the original separator, making this reversal lossless for the
   * channel prefix.
   */
  #canonicalizeSanitizedKey(sanitizedKey: string): string {
    const separator = sanitizedKey.indexOf("_");
    if (separator <= 0) return sanitizedKey;
    const channel = sanitizedKey.slice(0, separator);
    const rest = sanitizedKey.slice(separator + 1);
    return `${channel}:${rest}`;
  }

  /** Find JSONL transcript files recursively. AgentRuntime stores each session
   *  in a directory, so plain readdir is not enough. */
  async #findTranscriptFiles(): Promise<string[]> {
    const files: string[] = [];
    const visit = async (dir: string): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch (error) {
        logger.error({ error, path: dir }, "Failed to scan session transcripts");
        return;
      }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await visit(fullPath);
        } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          files.push(fullPath);
        }
      }
    };
    await visit(this.#storePath);
    return files;
  }

  async #findTranscriptPathBySessionId(sessionId: string): Promise<string | undefined> {
    const files = await this.#findTranscriptFiles();
    for (const file of files) {
      try {
        const firstLine = (await fs.promises.readFile(file, "utf-8")).split("\n")[0];
        if (!firstLine?.trim()) continue;
        const header = JSON.parse(firstLine) as Partial<TranscriptHeader> & { id?: string };
        if (header.type === "session" && (header.sessionId ?? header.id) === sessionId) {
          return file;
        }
      } catch {
        // Ignore malformed headers while searching for a delete target.
      }
    }
    return undefined;
  }

  /** Convert either a TranscriptMessage row or a pi-coding-agent event row
   *  into a normalized TranscriptMessage. */
  #toTranscriptMessage(entry: Record<string, unknown>): TranscriptMessage {
    if (typeof entry.role === "string") {
      return entry as unknown as TranscriptMessage;
    }

    if (
      entry.type === "message" &&
      typeof entry.message === "object" &&
      entry.message !== null
    ) {
      const message = entry.message as Record<string, unknown>;
      const role = message.role === "toolResult" ? "tool" : message.role;
      const usage = message.usage as Record<string, unknown> | undefined;
      return {
        id: typeof entry.id === "string" ? entry.id : undefined,
        role:
          role === "user" || role === "assistant" || role === "system" || role === "tool"
            ? role
            : "system",
        content: this.#extractMessageText(message.content),
        timestamp:
          Date.parse(typeof entry.timestamp === "string" ? entry.timestamp : "") || Date.now(),
        usage: usage
          ? {
              promptTokens: typeof usage.input === "number" ? usage.input : undefined,
              completionTokens: typeof usage.output === "number" ? usage.output : undefined,
              totalTokens: typeof usage.totalTokens === "number" ? usage.totalTokens : undefined,
            }
          : undefined,
        model: typeof message.model === "string" ? message.model : undefined,
        provider: typeof message.provider === "string" ? message.provider : undefined,
      };
    }

    return {
      role: "system",
      content: "",
      timestamp: Date.now(),
    };
  }

  #extractMessageText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        const part = item as Record<string, unknown>;
        if (typeof part.text === "string") return part.text;
        if (typeof part.thinking === "string") return "";
        if (typeof part.name === "string" && part.type === "toolCall") {
          return `[tool call: ${part.name}]`;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  /** Persist the index atomically. Unlocked by design: callers that mutate
   *  the index run the whole read-modify-write inside #withLock(), so
   *  acquiring the lock here too would deadlock. The cold-load save path
   *  is a one-shot and also runs without the lock. */
  async #saveIndexUnlocked(index: Map<string, SessionEntry>): Promise<void> {
    const data = Object.fromEntries(index);
    const content = JSON.stringify(data, null, 2);
    const tmpFile = `${this.#indexFile}.${randomUUID()}.tmp`;

    await fs.promises.writeFile(tmpFile, content, "utf-8");
    await fs.promises.rename(tmpFile, this.#indexFile);
  }

  async list(options?: SessionListOptions): Promise<SessionListItem[]> {
    const index = await this.#loadIndex();
    let entries = Array.from(index.values());

    if (options?.activeMinutes) {
      const cutoff = Date.now() - options.activeMinutes * 60 * 1000;
      entries = entries.filter((e) => e.updatedAt >= cutoff);
    }
    if (options?.search) {
      const search = options.search.toLowerCase();
      entries = entries.filter(
        (e) =>
          e.sessionKey.toLowerCase().includes(search) ||
          (e.label?.toLowerCase().includes(search) ?? false),
      );
    }
    entries.sort((a, b) => b.updatedAt - a.updatedAt);
    if (options?.limit) entries = entries.slice(0, options.limit);

    return entries.map((e) => ({
      sessionKey: e.sessionKey,
      sessionId: e.sessionId,
      label: e.label,
      updatedAt: e.updatedAt,
      messageCount: e.messageCount,
      totalTokens: e.totalTokens,
      model: e.model,
      provider: e.provider,
    }));
  }

  async get(sessionKey: string): Promise<SessionEntry | null> {
    const index = await this.#loadIndex();
    return index.get(sessionKey) ?? null;
  }

  async upsert(entry: SessionEntry): Promise<void> {
    await this.#withLock(async () => {
      const index = await this.#loadIndex();
      index.set(entry.sessionKey, entry);
      await this.#saveIndexUnlocked(index);
    });
    logger.debug({ sessionKey: entry.sessionKey }, "Session upserted");
  }

  async delete(sessionKey: string): Promise<void> {
    await this.#withLock(async () => {
      const index = await this.#loadIndex();
      const entry = index.get(sessionKey);
      if (!entry) return;

      const transcriptPaths = new Set<string>();
      if (entry.transcriptFile && isPathInside(this.#storePath, entry.transcriptFile)) {
        transcriptPaths.add(entry.transcriptFile);
      }
      transcriptPaths.add(this.getTranscriptPath(entry.sessionId));
      const recoveredPath = await this.#findTranscriptPathBySessionId(entry.sessionId);
      if (recoveredPath) transcriptPaths.add(recoveredPath);

      for (const tp of transcriptPaths) {
        if (fs.existsSync(tp)) {
          await fs.promises.unlink(tp);
        }
      }

      index.delete(sessionKey);
      await this.#saveIndexUnlocked(index);
      logger.info({ sessionKey }, "Session deleted");
    });
  }

  /** Reset creates a new session in the same namespace (channel prefix kept). */
  async reset(sessionKey: string): Promise<SessionEntry> {
    return this.#withLock(async () => {
      const index = await this.#loadIndex();
      const existing = index.get(sessionKey);
      const now = Date.now();

      const namespaceEnd = sessionKey.lastIndexOf(":");
      const namespacePrefix = namespaceEnd >= 0 ? sessionKey.slice(0, namespaceEnd + 1) : "";
      const newSessionKey = `${namespacePrefix}${randomUUID()}`;

      const newEntry: SessionEntry = {
        sessionId: randomUUID(),
        sessionKey: newSessionKey,
        createdAt: now,
        updatedAt: now,
        channel: existing?.channel,
        model: existing?.model,
        provider: existing?.provider,
        messageCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      };

      index.set(newSessionKey, newEntry);
      await this.#saveIndexUnlocked(index);
      logger.info(
        { oldSessionKey: sessionKey, newSessionKey, sessionId: newEntry.sessionId },
        "Session reset",
      );
      return newEntry;
    });
  }

  async getOrCreate(sessionKey: string): Promise<SessionEntry> {
    const existing = await this.get(sessionKey);
    if (existing) return existing;

    const now = Date.now();
    const entry: SessionEntry = {
      sessionId: randomUUID(),
      sessionKey,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
    };
    await this.upsert(entry);
    return entry;
  }

  async setLabel(sessionKey: string, label: string): Promise<void> {
    await this.#withLock(async () => {
      const index = await this.#loadIndex();
      const entry = index.get(sessionKey);
      if (!entry) return;
      entry.label = label;
      await this.#saveIndexUnlocked(index);
    });
    logger.debug({ sessionKey, label }, "Session label set");
  }

  /** Compute the canonical flat transcript path for a sessionId. */
  getTranscriptPath(sessionId: string): string {
    return path.join(this.#storePath, `${sessionId}.jsonl`);
  }

  async loadTranscript(sessionId: string): Promise<TranscriptMessage[]> {
    const transcriptPath = await this.#resolveTranscriptPath(sessionId);
    if (!fs.existsSync(transcriptPath)) return [];
    try {
      const content = await fs.promises.readFile(transcriptPath, "utf-8");
      const lines = content.split("\n");
      const messages: TranscriptMessage[] = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as Record<string, unknown>;
          if (entry.type === "session") continue;
          const message = this.#toTranscriptMessage(entry);
          if (message.content !== "" || message.role !== "system") {
            messages.push(message);
          }
        } catch {
          // Ignore parse errors.
        }
      }
      return messages;
    } catch (error) {
      logger.error({ error, sessionId }, "Failed to load transcript");
      return [];
    }
  }

  async #resolveTranscriptPath(sessionId: string): Promise<string> {
    const direct = this.getTranscriptPath(sessionId);
    if (fs.existsSync(direct)) return direct;
    const index = await this.#loadIndex();
    for (const entry of index.values()) {
      if (
        entry.sessionId === sessionId &&
        entry.transcriptFile &&
        fs.existsSync(entry.transcriptFile)
      ) {
        return entry.transcriptFile;
      }
    }
    return direct;
  }

  /** Append a message. The file append and the index count update are one
   *  read-modify-write: serialize them so concurrent appends can't race
   *  the isNew check (duplicate headers) or lose a messageCount increment. */
  async appendTranscript(
    sessionId: string,
    sessionKey: string,
    message: TranscriptMessage,
  ): Promise<void> {
    await this.#withLock(async () => {
      const transcriptPath = this.getTranscriptPath(sessionId);
      const isNew = !fs.existsSync(transcriptPath);

      if (isNew) {
        const header: TranscriptHeader = {
          type: "session",
          version: TRANSCRIPT_VERSION,
          sessionId,
          sessionKey,
          timestamp: new Date().toISOString(),
          cwd: process.cwd(),
        };
        await fs.promises.appendFile(transcriptPath, JSON.stringify(header) + "\n");
      }

      await fs.promises.appendFile(transcriptPath, JSON.stringify(message) + "\n");

      const index = await this.#loadIndex();
      const entry = index.get(sessionKey);
      if (entry) {
        entry.updatedAt = Date.now();
        entry.messageCount = (entry.messageCount ?? 0) + 1;
        if (message.usage) {
          entry.inputTokens = (entry.inputTokens ?? 0) + (message.usage.promptTokens ?? 0);
          entry.outputTokens = (entry.outputTokens ?? 0) + (message.usage.completionTokens ?? 0);
          entry.totalTokens = (entry.totalTokens ?? 0) + (message.usage.totalTokens ?? 0);
        }
        if (message.model) entry.model = message.model;
        if (message.provider) entry.provider = message.provider;
        await this.#saveIndexUnlocked(index);
      }
    });
  }
}
