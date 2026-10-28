import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "pino";
import type { EventBus, SessionEvent, TurnStatus, VexEvent } from "../../core/events.js";
import { WECHAT_SESSION_KEY } from "../../core/sessionKey.js";
import type { ApprovalAnswer, ApprovalManager, ApprovalRequest } from "../../policy/approvals.js";
import { SESSION_EXPIRED_ERRCODE, WeChatApiError, type InboundMessage, type WeChatClient } from "./client.js";
import { extractText, formatApprovalPrompt, parseCommand, splitMessage } from "./messages.js";
import type { WeChatStore } from "./store.js";

export interface WeChatSessions {
  get(key: string): Promise<{ send(text: string, source?: string, existingRequestId?: string): void; stop(): void; readonly busy: boolean }>;
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
  /** Told whether each turn's reply reached the owner. */
  onReplyDelivery?: (ok: boolean, error?: string) => void;
}

const SEEN_LIMIT = 500;

const ANSWER_REPLIES: Record<ApprovalAnswer, (request: ApprovalRequest) => string> = {
  allow: (request) => `Allowed #${request.code} ${request.toolName}: ${request.summary}`,
  allow_session: (request) => `Allowed #${request.code}; ${request.allowScope ?? request.toolName} will not be asked about again in this conversation`,
  deny: (request) => `Denied #${request.code} ${request.toolName}: ${request.summary}`,
};

const MAX_INBOUND_ATTEMPTS = 8;

export class WeChatChannel {
  private readonly abort = new AbortController();
  private readonly seen = new Set<string>();
  private readonly pending = new Map<string, InboundMessage>();
  private readonly dispatched = new Set<string>();
  private readonly failures = new Map<string, { attempts: number; retryAt: number }>();
  private inboxVersion = 0;
  private savedInboxVersion = 0;
  private stateWrites: Promise<void> = Promise.resolve();
  private readonly announced = new Set<string>();
  private contextToken: string | undefined;
  private syncBuf: string | undefined;
  // Sends "Working on it…" when a turn runs long.
  private processingTimer: ReturnType<typeof setTimeout> | undefined;
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
    for (const id of state.seenIds ?? []) this.seen.add(id);
    for (const message of state.pendingMessages ?? []) this.pending.set(message.messageId, message);
    this.unsubscribe = this.opts.bus.on((event) => this.onBusEvent(event));
    this.loop = this.pollLoop();
  }

  async stop(): Promise<void> {
    this.abort.abort();
    this.unsubscribe?.();
    this.clearProcessingNotice();
    await this.loop;
    await this.outbox;
    await this.stateWrites;
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
        await this.dispatchPending();
        const { messages, syncBuf } = await this.opts.client.getUpdates(this.syncBuf ?? "", this.abort.signal);
        backoff = initialBackoff;
        let added = 0;
        for (const message of messages) {
          if (message.fromUserId === this.opts.ownerId && !this.seen.has(message.messageId) && !this.pending.has(message.messageId)) {
            this.pending.set(message.messageId, message);
            this.inboxVersion++;
            added++;
          }
        }
        // The inbox and cursor share one atomic snapshot, before any message is dispatched.
        const previous = this.syncBuf;
        if (syncBuf) this.syncBuf = syncBuf;
        try { if (added || this.syncBuf !== previous) await this.saveState(); }
        catch (error) { this.syncBuf = previous; throw error; }
        await this.dispatchPending();
        if (messages.length === 0) await this.sleep(this.opts.idleDelayMs ?? 1000);
      } catch (err) {
        if (this.abort.signal.aborted) return;
        // A long poll that times out client-side simply had no messages.
        if (err instanceof Error && err.name === "TimeoutError") continue;
        if (err instanceof WeChatApiError && err.errcode === SESSION_EXPIRED_ERRCODE) {
          this.sessionExpired = true;
          this.syncBuf = undefined;
          await this.saveState().catch(() => {});
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
      this.answerApproval(command.answer, command.code);
      return;
    }
    const session = await this.opts.sessions.get(WECHAT_SESSION_KEY);
    if (command.kind === "stop") {
      if (session.busy) {
        session.stop();
        // Stopping discards every queued message the transcript has not accepted yet.
        for (const id of [...this.dispatched]) this.acknowledge(id);
      } else this.send("Nothing is running right now.");
      return;
    }
    this.dispatched.add(message.messageId);
    try { session.send(command.text, undefined, message.messageId); }
    catch (error) { this.dispatched.delete(message.messageId); throw error; }
  }

  /**
   * Dispatches the saved inbox in arrival order. A failing message holds back later ones and is
   * retried with exponential backoff until it succeeds or is dropped after its last attempt.
   */
  private async dispatchPending(): Promise<void> {
    if (this.savedInboxVersion !== this.inboxVersion) await this.saveState();
    for (const message of [...this.pending.values()]) {
      if (this.abort.signal.aborted) return;
      if (this.dispatched.has(message.messageId)) continue;
      const failure = this.failures.get(message.messageId);
      if (failure && Date.now() < failure.retryAt) return;
      try {
        await this.handleInbound(message);
        this.failures.delete(message.messageId);
        if (!this.dispatched.has(message.messageId)) {
          this.acknowledge(message.messageId);
          await this.saveState();
        }
      } catch (err) {
        const attempts = (failure?.attempts ?? 0) + 1;
        if (attempts < MAX_INBOUND_ATTEMPTS) {
          const base = this.opts.initialBackoffMs ?? 1000;
          this.failures.set(message.messageId, { attempts, retryAt: Date.now() + Math.min(base * 2 ** (attempts - 1), this.opts.maxBackoffMs ?? 60_000) });
          this.opts.log.warn({ err, attempts }, "failed to handle wechat message; retained in inbox");
          return;
        }
        this.opts.log.error({ err, attempts }, "dropping a wechat message that failed repeatedly");
        this.acknowledge(message.messageId);
        await this.saveState().catch(() => {});
      }
    }
  }

  private acknowledge(id: string): void {
    this.failures.delete(id);
    this.pending.delete(id);
    this.dispatched.delete(id);
    this.seen.add(id);
    if (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.values().next().value as string);
  }

  private async saveState(): Promise<void> {
    const version = this.inboxVersion;
    const state = {
      ...(this.contextToken ? { contextToken: this.contextToken } : {}),
      ...(this.syncBuf ? { syncBuf: this.syncBuf } : {}),
      ...(this.pending.size ? { pendingMessages: [...this.pending.values()] } : {}),
      ...(this.seen.size ? { seenIds: [...this.seen] } : {}),
    };
    const write = this.stateWrites.then(() => this.opts.store.saveState(state));
    this.stateWrites = write.catch((err: unknown) => this.opts.log.warn({ err }, "failed to save wechat state"));
    await write;
    this.savedInboxVersion = Math.max(this.savedInboxVersion, version);
  }

  /**
   * Answers the request the owner named. A bare `/y` is accepted only while a single request is
   * pending, so it can never land on a request other than the one its prompt was about.
   */
  private answerApproval(answer: ApprovalAnswer, code: number | undefined): void {
    const pending = this.opts.approvals.pending();
    const request = code === undefined ? (pending.length === 1 ? pending[0] : undefined) : pending.find((item) => item.code === code);
    if (!request) {
      if (code !== undefined) this.send(`There is no pending request #${code}; it may have been answered or expired.`);
      else if (pending.length === 0) this.send("There are no pending requests.");
      else this.send([`${pending.length} requests are pending; reply with the number, such as /y ${pending[0]!.code}:`, ...pending.map((item) => `#${item.code} ${item.toolName}: ${item.summary}`)].join("\n"));
      return;
    }
    this.opts.approvals.answer(request.id, answer);
    // "Always allow" for a call that offers none answers it once.
    const effective = answer === "allow_session" && request.allowScope === undefined ? "allow" : answer;
    this.send(ANSWER_REPLIES[effective](request));
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
      case "user_message":
        if (event.requestId && this.pending.has(event.requestId)) {
          this.acknowledge(event.requestId);
          void this.saveState().catch(() => {});
        }
        return;
      case "busy":
        if (event.busy) this.beginTurn(event.quiet);
        else this.clearProcessingNotice();
        return;
      case "turn_end":
        this.deliverTurn(event.reply, event.status);
        return;
      case "assistant_message":
        // Runtime notifications arrive on their own; a turn's own messages come with turn_end.
        if (event.injected && event.text) this.send(event.text);
        return;
      default:
        return;
    }
  }

  private beginTurn(silent = false): void {
    this.lastReply = Promise.resolve(false);
    this.clearProcessingNotice();
    if (silent) return;
    const timer = setTimeout(() => {
      if (this.processingTimer === timer) this.send("Working on it…");
    }, this.opts.processingNoticeMs ?? 15_000);
    this.processingTimer = timer;
  }

  private clearProcessingNotice(): void {
    if (this.processingTimer) clearTimeout(this.processingTimer);
    this.processingTimer = undefined;
  }

  private deliverTurn(reply: string, status: TurnStatus): void {
    this.clearProcessingNotice();
    const report = this.opts.onReplyDelivery;
    if (status === "interrupted") this.send(reply ? `${reply}\n(interrupted)` : "Interrupted.", report);
    else if (reply) this.lastReply = this.send(reply, report);
  }

  private send(text: string, report?: (ok: boolean, error?: string) => void): Promise<boolean> {
    const chunks = splitMessage(text);
    const sending = this.outbox.then(async () => {
      const contextToken = this.contextToken;
      if (!contextToken) {
        this.opts.log.warn("no wechat context token yet; the owner has to message the bot first");
        report?.(false, "No WeChat context token yet; the owner has to message the bot first.");
        return false;
      }
      for (const chunk of chunks) {
        try {
          await this.opts.client.sendText(this.opts.ownerId, contextToken, chunk, this.abort.signal);
        } catch (err) {
          this.opts.log.warn({ err }, "failed to send wechat message");
          report?.(false, err instanceof Error ? err.message : String(err));
          return false;
        }
      }
      this.opts.log.info({ chars: text.length, parts: chunks.length }, "wechat message sent");
      report?.(true);
      return true;
    });
    this.outbox = sending.then(() => {});
    return sending;
  }

  private async sleep(ms: number): Promise<void> {
    await delay(ms, undefined, { signal: this.abort.signal }).catch(() => {});
  }
}
