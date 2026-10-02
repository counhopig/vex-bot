import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { VexPaths } from "../paths.js";
import type { EventBus, VexEvent } from "./events.js";
import type { Session } from "./session.js";
import { WebSessionIndex, type WebSessionMeta } from "./webSessions.js";

export const WECHAT_SESSION_KEY = "wechat";
const WEB_PREFIX = "web:";

export function webSessionKey(id: string): string {
  return `${WEB_PREFIX}${id}`;
}

export class UnknownSessionError extends Error {}

export interface SessionManagerOptions {
  paths: VexPaths;
  bus: EventBus;
  openSession: (key: string, transcriptPath: string, windowLabel: () => string) => Promise<Session>;
  generateTitle?: (userText: string, assistantText: string) => Promise<string>;
  onError?: (err: unknown) => void;
}

export class SessionManager {
  private readonly sessions = new Map<string, Promise<Session>>();
  private readonly deleting = new Set<string>();
  private readonly index: WebSessionIndex;
  private readonly untitledFirstMessage = new Map<string, string>();
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly opts: SessionManagerOptions) {
    this.index = new WebSessionIndex(join(opts.paths.webSessions, "index.json"), opts.paths.webSessions);
  }

  async init(): Promise<void> {
    await this.index.load();
    this.unsubscribe = this.opts.bus.on((event) => this.onEvent(event));
  }

  get(key: string): Promise<Session> {
    if (this.deleting.has(key)) return Promise.reject(new UnknownSessionError(`没有这个会话：${key}`));
    const existing = this.sessions.get(key);
    if (existing) return this.availableSession(key, existing);
    let transcriptPath: string;
    try {
      transcriptPath = this.transcriptPath(key);
    } catch (err) {
      return Promise.reject(err);
    }
    const opening = this.opts.openSession(key, transcriptPath, () => this.windowLabel(key));
    this.sessions.set(key, opening);
    opening.catch(() => this.sessions.delete(key));
    return this.availableSession(key, opening);
  }

  assertAvailable(key: string): void {
    if (this.deleting.has(key)) throw new UnknownSessionError(`没有这个会话：${key}`);
    this.transcriptPath(key);
  }

  windowLabel(key: string): string {
    if (key === WECHAT_SESSION_KEY) return "微信";
    const meta = this.index.get(key.slice(WEB_PREFIX.length));
    return `网页会话「${meta?.title ?? "未命名"}」`;
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
    if (!updated) throw new UnknownSessionError(`没有这个网页会话：${id}`);
    this.untitledFirstMessage.delete(id);
    this.opts.bus.emit({ type: "sessions_changed" });
  }

  async deleteWeb(id: string): Promise<void> {
    const key = webSessionKey(id);
    if (!this.index.get(id) || this.deleting.has(key)) throw new UnknownSessionError(`没有这个网页会话：${id}`);
    const transcriptPath = this.transcriptPath(key);
    this.deleting.add(key);
    const loaded = this.sessions.get(key);
    this.sessions.delete(key);
    let restoreLoaded = false;
    try {
      const session = await loaded?.catch(() => undefined);
      if (session) {
        try {
          await session.dispose();
        } catch (err) {
          restoreLoaded = true;
          throw err;
        }
      }
      await rm(transcriptPath, { force: true });
      await this.index.remove(id);
      this.untitledFirstMessage.delete(id);
      this.opts.bus.emit({ type: "sessions_changed" });
    } finally {
      if (restoreLoaded && loaded && this.index.get(id)) this.sessions.set(key, loaded);
      this.deleting.delete(key);
    }
  }

  async shutdown(): Promise<void> {
    this.unsubscribe?.();
    const settled = await Promise.allSettled([...this.sessions.values()]);
    const open = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    for (const session of open) session.stop();
    await Promise.allSettled(open.map((s) => s.whenIdle()));
  }

  private transcriptPath(key: string): string {
    if (key === WECHAT_SESSION_KEY) return join(this.opts.paths.sessions, "wechat.jsonl");
    if (key.startsWith(WEB_PREFIX)) {
      const id = key.slice(WEB_PREFIX.length);
      if (this.index.get(id)) return join(this.opts.paths.webSessions, `${id}.jsonl`);
    }
    throw new UnknownSessionError(`没有这个会话：${key}`);
  }

  private availableSession(key: string, opening: Promise<Session>): Promise<Session> {
    return opening.then((session) => {
      this.assertAvailable(key);
      return session;
    });
  }

  private onEvent(event: VexEvent): void {
    if (event.type !== "session" || !event.sessionKey.startsWith(WEB_PREFIX)) return;
    const id = event.sessionKey.slice(WEB_PREFIX.length);
    if (this.deleting.has(event.sessionKey)) return;
    const meta = this.index.get(id);
    if (!meta) return;
    const e = event.event;
    if (e.kind === "user_message") {
      if (!meta.titled && !this.untitledFirstMessage.has(id)) this.untitledFirstMessage.set(id, e.text);
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
      if (this.deleting.has(webSessionKey(id))) return;
      const current = this.index.get(id);
      if (!current || current.titled) return;
      await this.index.update(id, { title, titled: true });
      this.opts.bus.emit({ type: "sessions_changed" });
    } catch (err) {
      this.opts.onError?.(err);
    }
  }
}
