import type { Logger } from "pino";
import type { EventBus, SessionEvent, VexEvent } from "../../core/events.js";
import { DEVICE_SESSION_KEY } from "../../core/sessionManager.js";
import type { ApprovalManager } from "../../policy/approvals.js";
import type { DeviceClientMessage, DeviceServerMessage, ReplyStatus } from "../../protocol/device.js";

export interface DeviceSessions {
  get(key: string): Promise<{ send(text: string, source?: string, requestId?: string): void; stop(): void }>;
}

/** One live device socket; `send` reports whether the message left, so a reply can wait for reconnection. */
export interface DeviceConnection {
  send(message: DeviceServerMessage): boolean;
  close(code: number, reason: string): void;
}

export interface DeviceChannelOptions {
  sessions: DeviceSessions;
  approvals: Pick<ApprovalManager, "pending">;
  bus: EventBus;
  log: Logger;
  outboxLimit?: number;
}

interface Turn {
  ids: string[];
  texts: string[];
  status: ReplyStatus;
}

const SEEN_LIMIT = 500;
const DEFAULT_OUTBOX_LIMIT = 20;

/**
 * Carries one device's messages to the fixed device session and assembles each turn into one reply,
 * as the WeChat channel does. The device can send and stop, never approve or reach other sessions.
 */
export class DeviceChannel {
  private connection: DeviceConnection | undefined;
  private readonly outbox: DeviceServerMessage[] = [];
  private readonly seen = new Set<string>();
  // Handed to the session but not yet in its transcript.
  private readonly waiting = new Set<string>();
  private readonly announced = new Set<string>();
  private turn: Turn | undefined;
  private busy = false;
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly opts: DeviceChannelOptions) {}

  start(): void {
    this.unsubscribe = this.opts.bus.on((event) => this.onBusEvent(event));
  }

  stop(): void {
    this.unsubscribe?.();
    this.connection?.close(1001, "vexd is stopping");
    this.connection = undefined;
  }

  /** Attaches a connection, replacing any earlier one; the returned function detaches it. */
  connect(connection: DeviceConnection): () => void {
    const previous = this.connection;
    this.connection = connection;
    previous?.close(4000, "Replaced by a newer device connection");
    this.opts.log.info("device connected");
    connection.send({ type: "hello", busy: this.busy });
    while (this.outbox.length && connection.send(this.outbox[0]!)) this.outbox.shift();
    return () => {
      if (this.connection !== connection) return;
      this.connection = undefined;
      this.opts.log.info("device disconnected");
    };
  }

  async receive(message: DeviceClientMessage): Promise<void> {
    const session = await this.opts.sessions.get(DEVICE_SESSION_KEY);
    if (message.type === "stop") {
      session.stop();
      // Stopping discards queued messages the transcript has not taken; answer them so the device stops waiting.
      const dropped = [...this.waiting];
      this.waiting.clear();
      if (dropped.length) this.reply({ type: "reply", ids: dropped, text: "", status: "interrupted" });
      return;
    }
    if (this.seen.has(message.id)) {
      // A resend after a lost acknowledgement; the reply arrives once, when its turn ends.
      if (!this.waiting.has(message.id)) this.live({ type: "accepted", id: message.id });
      return;
    }
    this.remember(message.id);
    this.waiting.add(message.id);
    try {
      session.send(message.text, undefined, message.id);
    } catch (err) {
      this.seen.delete(message.id);
      this.waiting.delete(message.id);
      throw err;
    }
    this.opts.log.info({ chars: message.text.length }, "device message received");
  }

  private onBusEvent(event: VexEvent): void {
    if (event.type === "approvals_changed") this.announceApprovals();
    else if (event.type === "session" && event.sessionKey === DEVICE_SESSION_KEY) this.onSessionEvent(event.event);
  }

  private announceApprovals(): void {
    const pending = this.opts.approvals.pending().filter((request) => request.sessionKey === DEVICE_SESSION_KEY);
    const ids = new Set(pending.map((request) => request.id));
    for (const id of this.announced) if (!ids.has(id)) this.announced.delete(id);
    for (const request of pending) {
      if (this.announced.has(request.id)) continue;
      this.announced.add(request.id);
      this.live({ type: "needs_approval", tool: request.toolName, summary: request.summary });
    }
  }

  private onSessionEvent(event: SessionEvent): void {
    switch (event.kind) {
      case "user_message":
        if (!event.requestId || !this.waiting.delete(event.requestId)) return;
        this.turn?.ids.push(event.requestId);
        this.live({ type: "accepted", id: event.requestId });
        return;
      case "busy":
        this.busy = event.busy;
        this.live({ type: "busy", busy: event.busy });
        if (event.busy) this.turn = { ids: [], texts: [], status: "ok" };
        else this.endTurn(event.discardReply);
        return;
      case "assistant_message":
        if (event.injected || !this.turn) {
          if (event.text) this.reply({ type: "reply", ids: [], text: event.text, status: "ok" });
          return;
        }
        // Text written alongside tool calls narrates the work; the device gets the reply that ends the turn.
        if (event.text && event.stopReason !== "toolUse") this.turn.texts.push(event.text);
        if (event.stopReason === "aborted") this.turn.status = "interrupted";
        return;
      case "error":
        if (!this.turn) {
          this.reply({ type: "reply", ids: [], text: event.message, status: "error" });
          return;
        }
        this.turn.texts.push(event.message);
        this.turn.status = "error";
        return;
      default:
        return;
    }
  }

  private endTurn(discard = false): void {
    const turn = this.turn;
    this.turn = undefined;
    if (!turn || discard) return;
    const text = turn.texts.join("\n\n");
    if (!text && !turn.ids.length && turn.status === "ok") return;
    this.reply({ type: "reply", ids: turn.ids, text, status: turn.status });
  }

  /** Sent now, or kept for the next connection; the oldest is dropped beyond the limit. */
  private reply(message: DeviceServerMessage): void {
    if (this.connection?.send(message)) return;
    this.outbox.push(message);
    const limit = this.opts.outboxLimit ?? DEFAULT_OUTBOX_LIMIT;
    if (this.outbox.length > limit) {
      this.outbox.splice(0, this.outbox.length - limit);
      this.opts.log.warn({ limit }, "device outbox full; dropped the oldest reply");
    }
  }

  private live(message: DeviceServerMessage): void {
    this.connection?.send(message);
  }

  private remember(id: string): void {
    this.seen.add(id);
    if (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.values().next().value as string);
  }
}
