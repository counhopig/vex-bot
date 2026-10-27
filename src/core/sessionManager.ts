import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { VexPaths } from "../paths.js";
import type { EventBus, VexEvent } from "./events.js";
import type { Session } from "./session.js";
import { WebSessionIndex, type WebSessionMeta } from "./webSessions.js";

import { DEVICE_SESSION_KEY, WECHAT_SESSION_KEY, webSessionId, webSessionKey } from "./sessionKey.js";

export { DEVICE_SESSION_KEY, WECHAT_SESSION_KEY, webSessionKey } from "./sessionKey.js";

export class UnknownSessionError extends Error {}

export interface SessionManagerOptions {
  paths: VexPaths;
  bus: EventBus;
  openSession: (key: string, transcriptPath: string, windowLabel: () => string) => Promise<Session>;
  generateTitle?: (userText: string, assistantText: string) => Promise<string>;
  onError?: (err: unknown) => void;
  /** A WebChat session unused this long is disposed and reopened from its transcript on next use; 0 keeps every session. */
  idleTimeoutMs?: number;
  /** Keeps a session open for an outside reason, such as an approval it is waiting for. */
  retain?: (key: string) => boolean;
  /** Told after a WebChat conversation has been deleted. */
  onDeleted?: (key: string) => void;
  /** The device session's window label; without it the device session does not exist. */
  deviceLabel?: string;
  now?: () => number;
}

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000;

/**
 * One conversation's place in the cache.
 * - `open`: opened or opening; `session` is set once the opening resolves, and only then can it be evicted.
 * - `evicting`: an idle instance being disposed; the next open waits for it so it reads the flushed transcript.
 * - `deleting`: a WebChat conversation being deleted, which nothing may open.
 */
type CacheEntry =
  | { state: "open"; opening: Promise<Session>; session?: Session; lastUsed: number }
  | { state: "evicting"; disposal: Promise<void> }
  | { state: "deleting" };

export class SessionManager {
  private readonly entries = new Map<string, CacheEntry>();
  private sweeper: ReturnType<typeof setInterval> | undefined;
  private readonly index: WebSessionIndex;
  private readonly untitledFirstMessage = new Map<string, string>();
  private closing = false;
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly opts: SessionManagerOptions) {
    this.index = new WebSessionIndex(join(opts.paths.webSessions, "index.json"), opts.paths.webSessions);
  }

  async init(): Promise<void> {
    await this.index.load();
    this.unsubscribe = this.opts.bus.on((event) => this.onEvent(event));
    const idle = this.idleTimeoutMs;
    if (idle > 0) {
      this.sweeper = setInterval(() => { void this.evictIdle().catch((err: unknown) => this.opts.onError?.(err)); }, Math.min(60_000, idle));
      this.sweeper.unref();
    }
  }

  get(key: string): Promise<Session> {
    if (this.closing) return Promise.reject(new Error("vexd is shutting down and cannot open a conversation."));
    const existing = this.entries.get(key);
    if (existing?.state === "deleting") return Promise.reject(new UnknownSessionError(`No such conversation: ${key}`));
    if (existing?.state === "open") {
      existing.lastUsed = this.now();
      return this.availableSession(key, existing.opening);
    }
    let transcriptPath: string;
    try {
      transcriptPath = this.transcriptPath(key);
    } catch (err) {
      return Promise.reject(err);
    }
    const opening = existing?.state === "evicting"
      ? existing.disposal.then(() => this.opts.openSession(key, this.transcriptPath(key), () => this.windowLabel(key)))
      : this.opts.openSession(key, transcriptPath, () => this.windowLabel(key));
    this.cache(key, opening);
    return this.availableSession(key, opening);
  }

  /**
   * Disposes WebChat sessions unused for the idle timeout. Only a fully idle session with nothing
   * retaining it is evicted; it leaves the cache before disposal starts, so a new request opens a
   * fresh instance from the transcript once the old one has flushed. WeChat is never evicted.
   */
  async evictIdle(): Promise<string[]> {
    const idle = this.idleTimeoutMs;
    if (idle <= 0 || this.closing) return [];
    const now = this.now();
    const evicted: string[] = [];
    const disposals: Promise<void>[] = [];
    for (const [key, entry] of this.entries) {
      if (entry.state !== "open" || !entry.session || webSessionId(key) === undefined) continue;
      if (now - entry.lastUsed < idle || !entry.session.idle || this.opts.retain?.(key)) continue;
      const evicting: CacheEntry = { state: "evicting", disposal: entry.session.dispose().catch((err: unknown) => this.opts.onError?.(err)) };
      this.entries.set(key, evicting);
      void evicting.disposal.then(() => { if (this.entries.get(key) === evicting) this.entries.delete(key); });
      disposals.push(evicting.disposal);
      evicted.push(key);
    }
    await Promise.all(disposals);
    return evicted;
  }

  assertAvailable(key: string): void {
    if (this.isDeleting(key)) throw new UnknownSessionError(`No such conversation: ${key}`);
    this.transcriptPath(key);
  }

  windowLabel(key: string): string {
    if (key === WECHAT_SESSION_KEY) return "WeChat";
    if (key === DEVICE_SESSION_KEY && this.opts.deviceLabel) return this.opts.deviceLabel;
    const meta = this.index.get(webSessionId(key) ?? "");
    return `WebChat conversation "${meta?.title ?? "untitled"}"`;
  }

  listWeb(): WebSessionMeta[] {
    return this.index.list();
  }

  async createWeb(): Promise<WebSessionMeta> {
    const meta = await this.index.create(Date.now());
    this.opts.bus.emit({ type: "sessions_changed" });
    return meta;
  }

  async renameWeb(id: string, title: string): Promise<void> {
    const updated = await this.index.update(id, { title: title.trim().slice(0, 100), titled: true });
    if (!updated) throw new UnknownSessionError(`No such WebChat conversation: ${id}`);
    this.untitledFirstMessage.delete(id);
    this.opts.bus.emit({ type: "sessions_changed" });
  }

  async deleteWeb(id: string): Promise<void> {
    const key = webSessionKey(id);
    const previous = this.entries.get(key);
    if (!this.index.get(id) || previous?.state === "deleting") throw new UnknownSessionError(`No such WebChat conversation: ${id}`);
    const transcriptPath = this.transcriptPath(key);
    const deleting: CacheEntry = { state: "deleting" };
    this.entries.set(key, deleting);
    const loaded = previous?.state === "open" ? previous.opening : undefined;
    let restoreLoaded = false;
    try {
      // An evicted instance may still be writing its transcript; let it finish before removing the file.
      if (previous?.state === "evicting") await previous.disposal;
      const session = await loaded?.catch(() => undefined);
      if (session) {
        try {
          await session.dispose();
        } catch (err) {
          restoreLoaded = true;
          throw err;
        }
      }
      // Move the transcript aside first, so a failed index save can put it back; only
      // after the index no longer lists the conversation is the transcript removed.
      const removed = `${transcriptPath}.deleted`;
      const moved = await rename(transcriptPath, removed).then(() => true, (err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") return false;
        throw err;
      });
      try {
        await this.index.remove(id);
      } catch (err) {
        if (moved) await rename(removed, transcriptPath);
        throw err;
      }
      if (moved) await rm(removed, { force: true }).catch((err: unknown) => this.opts.onError?.(err));
      this.untitledFirstMessage.delete(id);
      this.opts.onDeleted?.(key);
      this.opts.bus.emit({ type: "sessions_changed" });
    } finally {
      if (this.entries.get(key) === deleting) this.entries.delete(key);
      if (restoreLoaded && loaded && this.index.get(id)) this.cache(key, loaded);
    }
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    this.unsubscribe?.();
    if (this.sweeper) clearInterval(this.sweeper);
    const entries = [...this.entries.values()];
    await Promise.allSettled(entries.flatMap((entry) => entry.state === "evicting" ? [entry.disposal] : []));
    const settled = await Promise.allSettled(entries.flatMap((entry) => entry.state === "open" ? [entry.opening] : []));
    const open = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    for (const session of open) session.stop();
    await Promise.allSettled(open.map((s) => s.dispose()));
  }

  private transcriptPath(key: string): string {
    if (key === WECHAT_SESSION_KEY) return join(this.opts.paths.sessions, "wechat.jsonl");
    if (key === DEVICE_SESSION_KEY && this.opts.deviceLabel) return join(this.opts.paths.sessions, "device.jsonl");
    const id = webSessionId(key);
    if (id !== undefined && this.index.get(id)) return join(this.opts.paths.webSessions, `${id}.jsonl`);
    throw new UnknownSessionError(`No such conversation: ${key}`);
  }

  /** Caches an opening; the entry learns its instance on success and leaves the cache on failure. */
  private cache(key: string, opening: Promise<Session>): void {
    const entry: CacheEntry = { state: "open", opening, lastUsed: this.now() };
    this.entries.set(key, entry);
    opening.then((session) => { if (this.entries.get(key) === entry) entry.session = session; }, () => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
  }

  /** Resolves to the current instance; one evicted or replaced meanwhile is never handed out. */
  private availableSession(key: string, opening: Promise<Session>): Promise<Session> {
    return opening.then((session) => {
      this.assertAvailable(key);
      const current = this.entries.get(key);
      if (current?.state !== "open" || current.opening !== opening) return this.get(key);
      return session;
    });
  }

  private isDeleting(key: string): boolean { return this.entries.get(key)?.state === "deleting"; }

  private get idleTimeoutMs(): number { return this.opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS; }

  private now(): number { return (this.opts.now ?? Date.now)(); }

  private onEvent(event: VexEvent): void {
    if (event.type !== "session") return;
    const id = webSessionId(event.sessionKey);
    if (id === undefined) return;
    // Activity, including a scheduled delivery, counts as use.
    const entry = this.entries.get(event.sessionKey);
    if (entry?.state === "open") entry.lastUsed = this.now();
    if (entry?.state === "deleting") return;
    const meta = this.index.get(id);
    if (!meta) return;
    const e = event.event;
    if (e.kind === "user_message") {
      if (!e.source && !meta.titled && !this.untitledFirstMessage.has(id)) this.untitledFirstMessage.set(id, e.text);
      this.index
        .update(id, { updatedAt: e.timestamp })
        .then(() => this.opts.bus.emit({ type: "sessions_changed" }))
        .catch((err: unknown) => this.opts.onError?.(err));
    } else if (e.kind === "assistant_message" && e.stopReason !== "aborted" && e.text) {
      const userText = this.untitledFirstMessage.get(id);
      if (userText === undefined || !this.opts.generateTitle) return;
      this.untitledFirstMessage.delete(id);
      void this.applyTitle(id, userText, e.text);
    }
  }

  private async applyTitle(id: string, userText: string, assistantText: string): Promise<void> {
    try {
      const title = await this.opts.generateTitle!(userText, assistantText);
      if (this.isDeleting(webSessionKey(id))) return;
      const updated = await this.index.setTitleIfUntitled(id, title);
      if (updated) this.opts.bus.emit({ type: "sessions_changed" });
    } catch (err) {
      this.opts.onError?.(err);
    }
  }
}
