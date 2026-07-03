/**
 * Session store implementation
 * Uses file system to store session index and transcript records
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { randomUUID } from "crypto";
import { getChildLogger } from "../utils/logger.js";
import { generateId } from "../utils/index.js";
import { expandHomePath, isPathInside } from "../utils/path.js";
import type {
  SessionEntry,
  SessionListItem,
  SessionListOptions,
  TranscriptMessage,
  TranscriptHeader,
} from "./types.js";

const logger = getChildLogger("sessions");

/** Current transcript version */
const TRANSCRIPT_VERSION = 1;

/** Simple write lock implementation */
class WriteLock {
  private locked = false;
  private waitQueue: Array<() => void> = [];

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise((resolve) => {
      this.waitQueue.push(resolve);
    });
  }

  release(): void {
    const next = this.waitQueue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }
}

/** Default store directory */
function getDefaultStorePath(): string {
  return path.join(os.homedir(), ".vex", "sessions");
}

/** Session store class */
export class FileSessionStore {
  private storePath: string;
  private indexFile: string;
  private cache: Map<string, SessionEntry> = new Map();
  /** Maps every recovered transcript's sessionId to its canonical session key. */
  private recoveredKeyBySessionId: Map<string, string> = new Map();
  private cacheTime = 0;
  private cacheTTL = 30_000; // 30-second cache
  private writeLock = new WriteLock();

  constructor(storePath?: string) {
    this.storePath = storePath ? expandHomePath(storePath) : getDefaultStorePath();
    this.indexFile = path.join(this.storePath, "sessions.json");
    this.ensureDirectory();
  }

  /** Ensure directory exists */
  private ensureDirectory(): void {
    if (!fs.existsSync(this.storePath)) {
      fs.mkdirSync(this.storePath, { recursive: true });
      logger.info({ path: this.storePath }, "Created sessions directory");
    }
  }

  /** Load the index */
  private async loadIndex(): Promise<Map<string, SessionEntry>> {
    // Check cache
    if (this.cache.size > 0 && Date.now() - this.cacheTime < this.cacheTTL) {
      return this.cache;
    }

    if (!fs.existsSync(this.indexFile)) {
      const recovered = await this.recoverIndexFromTranscripts();
      if (recovered.size > 0) {
        await this.saveIndex(recovered);
      }
      return recovered;
    }

    try {
      const content = await fs.promises.readFile(this.indexFile, "utf-8");
      const data = JSON.parse(content) as Record<string, SessionEntry>;
      this.cache = new Map(Object.entries(data));
      const recovered = await this.recoverIndexFromTranscripts();
      let changed = false;
      // Purge stale cache keys that carry a sessionId we recovered on disk under a
      // different (canonical) key. This heals legacy indexes written before session
      // keys were classified correctly, without touching the transcript files.
      for (const [existingKey, existingEntry] of this.cache) {
        const canonicalKey = this.recoveredKeyBySessionId.get(existingEntry.sessionId);
        if (canonicalKey && canonicalKey !== existingKey) {
          this.cache.delete(existingKey);
          changed = true;
        }
      }
      for (const [sessionKey, entry] of recovered) {
        for (const [existingKey, existingEntry] of this.cache) {
          if (existingKey !== sessionKey && existingEntry.sessionId === entry.sessionId) {
            this.cache.delete(existingKey);
            changed = true;
          }
        }
        const currentEntry = this.cache.get(sessionKey);
        if (!currentEntry) {
          this.cache.set(sessionKey, entry);
          changed = true;
        } else if (!currentEntry.transcriptFile && entry.transcriptFile) {
          this.cache.set(sessionKey, {
            ...entry,
            ...currentEntry,
            transcriptFile: entry.transcriptFile,
          });
          changed = true;
        }
      }
      if (changed) {
        await this.saveIndex(this.cache);
      }
      this.cacheTime = Date.now();
      return this.cache;
    } catch (error) {
      logger.error({ error }, "Failed to load session index");
      return this.recoverIndexFromTranscripts();
    }
  }

  /** Rebuild index from transcript headers when sessions.json is absent/corrupt */
  private async recoverIndexFromTranscripts(): Promise<Map<string, SessionEntry>> {
    const index = new Map<string, SessionEntry>();
    this.recoveredKeyBySessionId = new Map();
    const files = await this.findTranscriptFiles();

    for (const file of files) {
      const transcriptPath = path.isAbsolute(file) ? file : path.join(this.storePath, file);
      try {
        const content = await fs.promises.readFile(transcriptPath, "utf-8");
        const lines = content.split("\n").filter((line) => line.trim());
        if (lines.length === 0) continue;

        const header = JSON.parse(lines[0]!) as Partial<TranscriptHeader> & { id?: string };
        if (header.type !== "session") continue;

        const relativePath = path.relative(this.storePath, transcriptPath);
        const pathSessionKey = relativePath.split(path.sep)[0]?.replace(/\.jsonl$/, "");
        const sessionId = header.sessionId ?? header.id;
        // pi-coding-agent's nested logs omit sessionKey and live in a directory whose
        // name is sanitizeSessionKey("<channel>:<sender>") — the ":" separator was
        // replaced with "_". Rebuild the canonical "<channel>:<sender>" key so channel
        // classification and de-duplication against flat records both work.
        const sessionKey = header.sessionKey ?? (pathSessionKey ? this.canonicalizeSanitizedKey(pathSessionKey) : undefined);
        if (!sessionId || !sessionKey) continue;
        this.recoveredKeyBySessionId.set(sessionId, sessionKey);

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
              provider = typeof entry.provider === "string" ? entry.provider : provider;
              model = typeof entry.modelId === "string" ? entry.modelId : model;
              continue;
            }
            const message = this.toTranscriptMessage(entry);
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

        const stat = await fs.promises.stat(transcriptPath);
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

        // A single canonical key can map to several runtime logs (one per process
        // restart). Keep the most recent segment as the representative entry so the
        // list stays consistent with what loadTranscript returns.
        const existing = index.get(sessionKey);
        if (!existing || candidate.updatedAt >= existing.updatedAt) {
          index.set(sessionKey, {
            ...candidate,
            createdAt: existing ? Math.min(existing.createdAt, candidate.createdAt) : candidate.createdAt,
          });
        }
      } catch (error) {
        logger.warn({ error, transcriptPath }, "Failed to recover session transcript");
      }
    }

    if (index.size > 0) {
      logger.info({ count: index.size, path: this.storePath }, "Recovered session index from transcripts");
    }
    return index;
  }

  /**
   * Rebuild a canonical "<channel>:<sender>" session key from an AgentRuntime
   * directory name produced by sanitizeSessionKey (which replaces the ":" separator
   * with "_"). Channel ids never contain "_", so the first "_" is always the original
   * separator, making this reversal lossless for the channel prefix.
   */
  private canonicalizeSanitizedKey(sanitizedKey: string): string {
    const separator = sanitizedKey.indexOf("_");
    if (separator <= 0) return sanitizedKey;
    const channel = sanitizedKey.slice(0, separator);
    const rest = sanitizedKey.slice(separator + 1);
    return `${channel}:${rest}`;
  }

  /** Find JSONL transcript files recursively because AgentRuntime stores each session in a directory. */
  private async findTranscriptFiles(): Promise<string[]> {
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

    await visit(this.storePath);
    return files;
  }

  private async findTranscriptPathBySessionId(sessionId: string): Promise<string | undefined> {
    const files = await this.findTranscriptFiles();
    for (const file of files) {
      try {
        const firstLine = (await fs.promises.readFile(file, "utf-8")).split("\n")[0];
        if (!firstLine?.trim()) continue;
        const header = JSON.parse(firstLine) as Partial<TranscriptHeader> & { id?: string };
        if (header.type === "session" && (header.sessionId ?? header.id) === sessionId) {
          return file;
        }
      } catch {
        // Ignore malformed transcript headers while searching for a delete target.
      }
    }
    return undefined;
  }

  /** Convert Vex transcript rows or pi-coding-agent event rows into displayable transcript messages. */
  private toTranscriptMessage(entry: Record<string, unknown>): TranscriptMessage {
    if (typeof entry.role === "string") {
      return entry as unknown as TranscriptMessage;
    }

    if (entry.type === "message" && typeof entry.message === "object" && entry.message !== null) {
      const message = entry.message as Record<string, unknown>;
      const role = message.role === "toolResult" ? "tool" : message.role;
      const usage = message.usage as Record<string, unknown> | undefined;
      return {
        id: typeof entry.id === "string" ? entry.id : undefined,
        role: role === "user" || role === "assistant" || role === "system" || role === "tool" ? role : "system",
        content: this.extractMessageText(message.content),
        timestamp: Date.parse(typeof entry.timestamp === "string" ? entry.timestamp : "") || Date.now(),
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

  private extractMessageText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        const part = item as Record<string, unknown>;
        if (typeof part.text === "string") return part.text;
        if (typeof part.thinking === "string") return "";
        if (typeof part.name === "string" && part.type === "toolCall") return `[tool call: ${part.name}]`;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  /** Save the index */
  private async saveIndex(index: Map<string, SessionEntry>): Promise<void> {
    await this.writeLock.acquire();
    try {
      const data = Object.fromEntries(index);
      const content = JSON.stringify(data, null, 2);
      const tmpFile = `${this.indexFile}.${randomUUID()}.tmp`;

      await fs.promises.writeFile(tmpFile, content, "utf-8");
      await fs.promises.rename(tmpFile, this.indexFile);

      this.cache = index;
      this.cacheTime = Date.now();
    } finally {
      this.writeLock.release();
    }
  }

  /** List all sessions */
  async list(options?: SessionListOptions): Promise<SessionListItem[]> {
    const index = await this.loadIndex();
    let entries = Array.from(index.values());

    // Filter by active time
    if (options?.activeMinutes) {
      const cutoff = Date.now() - options.activeMinutes * 60 * 1000;
      entries = entries.filter((e) => e.updatedAt >= cutoff);
    }

    // Search filter
    if (options?.search) {
      const search = options.search.toLowerCase();
      entries = entries.filter(
        (e) =>
          e.sessionKey.toLowerCase().includes(search) ||
          e.label?.toLowerCase().includes(search)
      );
    }

    // Sort by update time (newest first)
    entries.sort((a, b) => b.updatedAt - a.updatedAt);

    // Limit results
    if (options?.limit) {
      entries = entries.slice(0, options.limit);
    }

    return entries.map((e) => ({
      sessionKey: e.sessionKey,
      sessionId: e.sessionId,
      label: e.label,
      updatedAt: e.updatedAt,
      messageCount: e.messageCount,
      totalTokens: e.totalTokens,
      model: e.model,
    }));
  }

  /** Get a session */
  async get(sessionKey: string): Promise<SessionEntry | null> {
    const index = await this.loadIndex();
    return index.get(sessionKey) ?? null;
  }

  /** Create or update a session */
  async upsert(entry: SessionEntry): Promise<void> {
    const index = await this.loadIndex();
    index.set(entry.sessionKey, entry);
    await this.saveIndex(index);
    logger.debug({ sessionKey: entry.sessionKey }, "Session upserted");
  }

  /** Delete a session */
  async delete(sessionKey: string): Promise<void> {
    const index = await this.loadIndex();
    const entry = index.get(sessionKey);

    if (entry) {
      const transcriptPaths = new Set<string>();
      if (entry.transcriptFile && isPathInside(this.storePath, entry.transcriptFile)) {
        transcriptPaths.add(entry.transcriptFile);
      }
      transcriptPaths.add(this.getTranscriptPath(entry.sessionId));
      const recoveredTranscriptPath = await this.findTranscriptPathBySessionId(entry.sessionId);
      if (recoveredTranscriptPath) {
        transcriptPaths.add(recoveredTranscriptPath);
      }

      for (const transcriptPath of transcriptPaths) {
        if (fs.existsSync(transcriptPath)) {
          const archivePath = `${transcriptPath}.deleted.${Date.now()}`;
          await fs.promises.rename(transcriptPath, archivePath);
        }
      }

      index.delete(sessionKey);
      await this.saveIndex(index);
      logger.info({ sessionKey }, "Session deleted");
    }
  }

  /** Reset a session (create new session) */
  async reset(sessionKey: string): Promise<SessionEntry> {
    const index = await this.loadIndex();
    const existing = index.get(sessionKey);
    const now = Date.now();

    // Extract channel prefix from old sessionKey (e.g. "webchat:")
    const channelPrefix = sessionKey.includes(":") ? sessionKey.split(":")[0] + ":" : "";

    // Generate new sessionKey
    const newSessionKey = `${channelPrefix}${generateId("session")}`;

    // Create new session
    const newEntry: SessionEntry = {
      sessionId: randomUUID(),
      sessionKey: newSessionKey,
      label: undefined,  // New session does not inherit label
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

    // Keep old session (don't delete)
    // Add new session to index
    index.set(newSessionKey, newEntry);
    await this.saveIndex(index);

    logger.info({ oldSessionKey: sessionKey, newSessionKey, sessionId: newEntry.sessionId }, "New session created");
    return newEntry;
  }

  /** Get or create a session */
  async getOrCreate(sessionKey: string): Promise<SessionEntry> {
    const existing = await this.get(sessionKey);
    if (existing) {
      return existing;
    }

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

  /** Get transcript file path */
  getTranscriptPath(sessionId: string): string {
    return path.join(this.storePath, `${sessionId}.jsonl`);
  }

  /** Load transcript records */
  async loadTranscript(sessionId: string): Promise<TranscriptMessage[]> {
    const transcriptPath = await this.resolveTranscriptPath(sessionId);
    if (!fs.existsSync(transcriptPath)) {
      return [];
    }

    try {
      const content = await fs.promises.readFile(transcriptPath, "utf-8");
      const lines = content.trim().split("\n");
      const messages: TranscriptMessage[] = [];

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          // Skip header lines
          if (entry.type === "session") continue;
          const message = this.toTranscriptMessage(entry as Record<string, unknown>);
          if (message.content !== "" || message.role !== "system") {
            messages.push(message);
          }
        } catch {
          // Ignore parse errors
        }
      }

      return messages;
    } catch (error) {
      logger.error({ error, sessionId }, "Failed to load transcript");
      return [];
    }
  }

  private async resolveTranscriptPath(sessionId: string): Promise<string> {
    const directPath = this.getTranscriptPath(sessionId);
    if (fs.existsSync(directPath)) return directPath;

    const index = await this.loadIndex();
    for (const entry of index.values()) {
      if (entry.sessionId === sessionId && entry.transcriptFile && fs.existsSync(entry.transcriptFile)) {
        return entry.transcriptFile;
      }
    }

    return directPath;
  }

  /** Append a transcript message */
  async appendTranscript(
    sessionId: string,
    sessionKey: string,
    message: TranscriptMessage
  ): Promise<void> {
    const transcriptPath = this.getTranscriptPath(sessionId);
    const isNew = !fs.existsSync(transcriptPath);

    // If it's a new file, write header first
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

    // Append the message
    await fs.promises.appendFile(transcriptPath, JSON.stringify(message) + "\n");

    // Update session index
    const entry = await this.get(sessionKey);
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
      await this.upsert(entry);
    }
  }

  /** Clear transcript */
  async clearTranscript(sessionId: string): Promise<void> {
    const transcriptPath = this.getTranscriptPath(sessionId);
    if (fs.existsSync(transcriptPath)) {
      await fs.promises.unlink(transcriptPath);
    }
  }
}

/** Global session store instance */
let globalStore: FileSessionStore | null = null;

/** Get the global session store */
export function getSessionStore(): FileSessionStore {
  if (!globalStore) {
    globalStore = new FileSessionStore();
  }
  return globalStore;
}

/** Initialize the session store */
export function initSessionStore(storePath?: string): FileSessionStore {
  globalStore = new FileSessionStore(storePath);
  return globalStore;
}
