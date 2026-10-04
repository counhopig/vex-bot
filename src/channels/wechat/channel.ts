import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "pino";
import type { EventBus, SessionEvent, VexEvent } from "../../core/events.js";
import { WECHAT_SESSION_KEY } from "../../core/sessionManager.js";
import type { ApprovalAnswer, ApprovalManager } from "../../policy/approvals.js";
import { SESSION_EXPIRED_ERRCODE, WeChatApiError, type InboundMessage, type WeChatClient } from "./client.js";
import { extractText, formatApprovalPrompt, parseCommand, splitMessage } from "./messages.js";
import type { WeChatStore } from "./store.js";

export interface WeChatSessions {
  get(key: string): Promise<{ send(text: string): void; stop(): void; readonly busy: boolean }>;
}

export interface WeChatChannelOptions {
  client: Pick<WeChatClient, "getUpdates" | "sendText">;
  store: WeChatStore;
  ownerId: string;
  sessions: WeChatSessions;
  approvals: ApprovalManager;
  bus: EventBus;
  log: Logger;
  idleDelayMs?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  processingNoticeMs?: number;
  timeZone?: string;
}

interface Turn {
  texts: string[];
  aborted: boolean;
  timer: ReturnType<typeof setTimeout>;
}

const SEEN_LIMIT = 500;

const ANSWER_REPLIES: Record<ApprovalAnswer, (tool: string) => string> = {
  allow: (tool) => `Allowed: ${tool}`,
  allow_session: (tool) => `Allowed; ${tool} will not be asked about again in this conversation`,
  deny: (tool) => `Denied: ${tool}`,
};

export class WeChatChannel {
  private readonly abort = new AbortController();
  private readonly seen = new Set<string>();
  private readonly announced = new Set<string>();
  private contextToken: string | undefined;
  private syncBuf: string | undefined;
  private turn: Turn | undefined;
  private outbox: Promise<void> = Promise.resolve();
  private loop: Promise<void> | undefined;
  private unsubscribe: (() => void) | undefined;
  private sessionExpired = false;
  private lastReply: Promise<boolean> = Promise.resolve(false);

  constructor(private readonly opts: WeChatChannelOptions) {}

  get expired(): boolean {
    return this.sessionExpired;
  }

  get available(): boolean { return !this.sessionExpired && !this.abort.signal.aborted && !!this.contextToken; }

  replyDelivered(): Promise<boolean> { return this.lastReply; }

  async start(): Promise<void> {
    const state = await this.opts.store.loadState();
    this.contextToken = state.contextToken;
    this.syncBuf = state.syncBuf;
    this.unsubscribe = this.opts.bus.on((event) => this.onBusEvent(event));
    this.loop = this.pollLoop();
  }

  async stop(): Promise<void> {
    this.abort.abort();
    this.unsubscribe?.();
    if (this.turn) clearTimeout(this.turn.timer);
    this.turn = undefined;
    await this.loop;
    await this.outbox;
  }

  /** Resolves once every queued outgoing message has been attempted. */
  drained(): Promise<void> {
    return this.outbox;
  }

  private async pollLoop(): Promise<void> {
    const initialBackoff = this.opts.initialBackoffMs ?? 1000;
    const maxBackoff = this.opts.maxBackoffMs ?? 60_000;
    let backoff = initialBackoff;
    while (!this.abort.signal.aborted) {
      try {
        const { messages, syncBuf } = await this.opts.client.getUpdates(this.syncBuf ?? "", this.abort.signal);
        backoff = initialBackoff;
        for (const message of messages) {
          if (this.abort.signal.aborted) return;
          try {
            await this.handleInbound(message);
          } catch (err) {
            this.opts.log.warn({ err }, "failed to handle wechat message");
          }
        }
        if (syncBuf && syncBuf !== this.syncBuf) {
          this.syncBuf = syncBuf;
          await this.saveState();
        }
        if (messages.length === 0) await this.sleep(this.opts.idleDelayMs ?? 1000);
      } catch (err) {
        if (this.abort.signal.aborted) return;
        // A long poll that times out client-side simply had no messages.
        if (err instanceof Error && err.name === "TimeoutError") continue;
        if (err instanceof WeChatApiError && err.errcode === SESSION_EXPIRED_ERRCODE) {
          this.sessionExpired = true;
          this.syncBuf = undefined;
          await this.saveState();
          this.opts.log.error("The WeChat login has expired; run vex wechat login to sign in again, then restart vexd");
          return;
        }
        this.opts.log.warn({ err }, "wechat poll failed");
        await this.sleep(backoff);
        backoff = Math.min(backoff * 2, maxBackoff);
      }
    }
  }

  private async handleInbound(message: InboundMessage): Promise<void> {
    if (message.fromUserId !== this.opts.ownerId) {
      this.opts.log.debug({ from: message.fromUserId }, "ignored wechat message from non-owner");
      return;
    }
    if (this.seen.has(message.messageId)) return;
    this.seen.add(message.messageId);
    if (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.values().next().value as string);

    if (message.contextToken && message.contextToken !== this.contextToken) {
      this.contextToken = message.contextToken;
      await this.saveState();
    }

    const text = extractText(message.items);
    if (!text) {
      this.opts.log.debug({ items: message.items.length }, "wechat message without text ignored");
      return;
    }
    const command = parseCommand(text);
    this.opts.log.info({ chars: text.length, command: command.kind === "chat" ? undefined : command.kind }, "wechat message received");
    if (command.kind === "approve") {
      this.answerOldest(command.answer);
      return;
    }
    const session = await this.opts.sessions.get(WECHAT_SESSION_KEY);
    if (command.kind === "stop") {
      if (session.busy) session.stop();
      else this.send("Nothing is running right now.");
      return;
    }
    session.send(command.text);
  }

  private async saveState(): Promise<void> {
    const state = {
      ...(this.contextToken ? { contextToken: this.contextToken } : {}),
      ...(this.syncBuf ? { syncBuf: this.syncBuf } : {}),
    };
    await this.opts.store.saveState(state).catch((err: unknown) => this.opts.log.warn({ err }, "failed to save wechat state"));
  }

  private answerOldest(answer: ApprovalAnswer): void {
    const oldest = this.opts.approvals.pending()[0];
    if (!oldest) {
      this.send("There are no pending requests.");
      return;
    }
    this.opts.approvals.answer(oldest.id, answer);
    this.send(ANSWER_REPLIES[answer](oldest.toolName));
  }

  private onBusEvent(event: VexEvent): void {
    if (event.type === "approvals_changed") {
      this.announceApprovals();
    } else if (event.type === "session" && event.sessionKey === WECHAT_SESSION_KEY) {
      this.onSessionEvent(event.event);
    }
  }

  private announceApprovals(): void {
    const pending = this.opts.approvals.pending();
    const ids = new Set(pending.map((p) => p.id));
    for (const id of this.announced) if (!ids.has(id)) this.announced.delete(id);
    for (const request of pending) {
      if (this.announced.has(request.id)) continue;
      this.announced.add(request.id);
      this.send(formatApprovalPrompt(request, pending.length, this.opts.timeZone));
    }
  }

  private onSessionEvent(event: SessionEvent): void {
    switch (event.kind) {
      case "busy":
        if (event.busy) this.beginTurn(event.source === "proactive chat");
        else this.endTurn(event.discardReply);
        return;
      case "assistant_message":
        if (event.injected) { if (event.text) this.send(event.text); return; }
        if (!this.turn) {
          if (event.text) this.send(event.text);
          return;
        }
        if (event.text) this.turn.texts.push(event.text);
        if (event.stopReason === "aborted") this.turn.aborted = true;
        return;
      case "error":
        if (this.turn) this.turn.texts.push(event.message);
        else this.send(event.message);
        return;
      default:
        return;
    }
  }

  private beginTurn(silent = false): void {
    this.lastReply = Promise.resolve(false);
    if (this.turn) clearTimeout(this.turn.timer);
    const timer = setTimeout(() => {
      if (!silent && this.turn?.timer === timer) this.send("Working on it…");
    }, this.opts.processingNoticeMs ?? 15_000);
    this.turn = { texts: [], aborted: false, timer };
  }

  private endTurn(discard = false): void {
    const turn = this.turn;
    if (!turn) return;
    clearTimeout(turn.timer);
    this.turn = undefined;
    if (discard) return;
    const reply = turn.texts.join("\n\n");
    if (turn.aborted) this.send(reply ? `${reply}\n(interrupted)` : "Interrupted.");
    else if (reply) this.lastReply = this.send(reply);
  }

  private send(text: string): Promise<boolean> {
    const chunks = splitMessage(text);
    const sending = this.outbox.then(async () => {
      const contextToken = this.contextToken;
      if (!contextToken) {
        this.opts.log.warn("no wechat context token yet; the owner has to message the bot first");
        return false;
      }
      for (const chunk of chunks) {
        try {
          await this.opts.client.sendText(this.opts.ownerId, contextToken, chunk, this.abort.signal);
        } catch (err) {
          this.opts.log.warn({ err }, "failed to send wechat message");
          return false;
        }
      }
      this.opts.log.info({ chars: text.length, parts: chunks.length }, "wechat message sent");
      return true;
    });
    this.outbox = sending.then(() => {});
    return sending;
  }

  private async sleep(ms: number): Promise<void> {
    await delay(ms, undefined, { signal: this.abort.signal }).catch(() => {});
  }
}
