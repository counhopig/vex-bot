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
  private cacheTime = 0;
  private cacheTTL = 30_000; // 30-second cache
  private writeLock = new WriteLock();

  constructor(storePath?: string) {
    this.storePath = storePath ?? getDefaultStorePath();
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
      return new Map();
    }

    try {
      const content = await fs.promises.readFile(this.indexFile, "utf-8");
      const data = JSON.parse(content) as Record<string, SessionEntry>;
      this.cache = new Map(Object.entries(data));
      this.cacheTime = Date.now();
      return this.cache;
    } catch (error) {
      logger.error({ error }, "Failed to load session index");
      return new Map();
    }
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
      // Delete transcript file
      const transcriptPath = this.getTranscriptPath(entry.sessionId);
      if (fs.existsSync(transcriptPath)) {
        // Archive instead of deleting
        const archivePath = `${transcriptPath}.deleted.${Date.now()}`;
        await fs.promises.rename(transcriptPath, archivePath);
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
    const transcriptPath = this.getTranscriptPath(sessionId);
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
          messages.push(entry as TranscriptMessage);
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
