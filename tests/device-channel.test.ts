import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeviceChannel, type DeviceConnection } from "../src/channels/device/channel.js";
import { EventBus, type SessionEvent, type TurnStatus } from "../src/core/events.js";
import { ApprovalManager } from "../src/policy/approvals.js";
import type { DeviceServerMessage } from "../src/protocol/device.js";

class FakeSession {
  readonly sent: { text: string; requestId?: string }[] = [];
  stops = 0;
  send(text: string, _source?: string, requestId?: string): void {
    this.sent.push({ text, requestId });
  }
  stop(): void {
    this.stops++;
  }
}

class FakeConnection implements DeviceConnection {
  readonly messages: DeviceServerMessage[] = [];
  open = true;
  closed: { code: number; reason: string } | undefined;
  send(message: DeviceServerMessage): boolean {
    if (!this.open) return false;
    this.messages.push(message);
    return true;
  }
  close(code: number, reason: string): void {
    this.open = false;
    this.closed = { code, reason };
  }
  of<T extends DeviceServerMessage["type"]>(type: T): Extract<DeviceServerMessage, { type: T }>[] {
    return this.messages.filter((m): m is Extract<DeviceServerMessage, { type: T }> => m.type === type);
  }
}

let bus: EventBus;
let approvals: ApprovalManager;
let session: FakeSession;
let keys: string[];
let channel: DeviceChannel;

beforeEach(() => {
  bus = new EventBus();
  approvals = new ApprovalManager({ onChange: () => bus.emit({ type: "approvals_changed" }) });
  session = new FakeSession();
  keys = [];
  channel = new DeviceChannel({
    sessions: { get: async (key) => { keys.push(key); return session; } },
    approvals,
    bus,
    log: pino({ level: "silent" }),
    outboxLimit: 2,
  });
  channel.start();
});
afterEach(() => {
  channel.stop();
  approvals.dispose();
});

function emit(event: SessionEvent, sessionKey = "device"): void {
  bus.emit({ type: "session", sessionKey, event });
}

/** Runs one turn as the session would: busy, the owner messages entering the transcript, the turn's reply, idle. */
function turn(ids: string[], reply: string, status: TurnStatus = "ok"): void {
  emit({ kind: "busy", busy: true });
  for (const id of ids) emit({ kind: "user_message", text: "q", timestamp: 1, requestId: id });
  emit({ kind: "turn_end", reply, status });
  emit({ kind: "busy", busy: false });
}

describe("DeviceChannel", () => {
  it("sends to the device session and answers each turn with the session's one reply", async () => {
    const device = new FakeConnection();
    channel.connect(device);
    await channel.receive({ type: "send", id: "a1", text: "今天有什么安排" });
    expect(keys).toEqual(["device"]);
    expect(session.sent).toEqual([{ text: "今天有什么安排", requestId: "a1" }]);
    turn(["a1"], "下午三点开会。");
    expect(device.messages).toEqual([
      { type: "hello", busy: false },
      { type: "busy", busy: true },
      { type: "accepted", id: "a1" },
      { type: "busy", busy: false },
      { type: "reply", ids: ["a1"], text: "下午三点开会。", status: "ok" },
    ]);
  });

  it("ignores other sessions and reports interruption and errors in the reply status", async () => {
    const device = new FakeConnection();
    channel.connect(device);
    emit({ kind: "assistant_message", text: "for WeChat", stopReason: "stop", timestamp: 1 }, "wechat");
    await channel.receive({ type: "send", id: "a1", text: "q" });
    turn(["a1"], "half", "interrupted");
    await channel.receive({ type: "send", id: "a2", text: "q" });
    turn(["a2"], "model unavailable", "error");
    expect(device.of("reply")).toEqual([
      { type: "reply", ids: ["a1"], text: "half", status: "interrupted" },
      { type: "reply", ids: ["a2"], text: "model unavailable", status: "error" },
    ]);
  });

  it("does not hand a resent message to the session twice", async () => {
    const device = new FakeConnection();
    channel.connect(device);
    await channel.receive({ type: "send", id: "a1", text: "q" });
    await channel.receive({ type: "send", id: "a1", text: "q" });
    expect(session.sent).toHaveLength(1);
    turn(["a1"], "ok");
    await channel.receive({ type: "send", id: "a1", text: "q" });
    expect(session.sent).toHaveLength(1);
    expect(device.of("accepted")).toEqual([{ type: "accepted", id: "a1" }, { type: "accepted", id: "a1" }]);
    expect(device.of("reply")).toHaveLength(1);
  });

  it("keeps replies while disconnected, drops the oldest beyond the limit and delivers the rest on reconnect", async () => {
    const first = new FakeConnection();
    const detach = channel.connect(first);
    first.open = false;
    detach();
    for (const id of ["a1", "a2", "a3"]) {
      await channel.receive({ type: "send", id, text: "q" });
      turn([id], `answer ${id}`);
    }
    const second = new FakeConnection();
    channel.connect(second);
    expect(second.messages).toEqual([
      { type: "hello", busy: false },
      { type: "reply", ids: ["a2"], text: "answer a2", status: "ok" },
      { type: "reply", ids: ["a3"], text: "answer a3", status: "ok" },
    ]);
  });

  it("closes the previous connection when a new one arrives", () => {
    const first = new FakeConnection();
    channel.connect(first);
    channel.connect(new FakeConnection());
    expect(first.closed).toEqual({ code: 4000, reason: "Replaced by a newer device connection" });
  });

  it("delivers runtime-started and injected messages as replies without ids", () => {
    const device = new FakeConnection();
    channel.connect(device);
    turn([], "九点了，该看日程了");
    emit({ kind: "assistant_message", text: "heartbeat note", stopReason: "stop", timestamp: 3, injected: true });
    expect(device.of("reply")).toEqual([
      { type: "reply", ids: [], text: "九点了，该看日程了", status: "ok" },
      { type: "reply", ids: [], text: "heartbeat note", status: "ok" },
    ]);
    // A quiet run without a reply ends with no turn_end.
    emit({ kind: "busy", busy: true, quiet: true });
    emit({ kind: "busy", busy: false });
    expect(device.of("reply")).toHaveLength(2);
  });

  it("stops the session and answers queued messages that will never run", async () => {
    const device = new FakeConnection();
    channel.connect(device);
    await channel.receive({ type: "send", id: "a1", text: "q" });
    emit({ kind: "busy", busy: true });
    emit({ kind: "user_message", text: "q", timestamp: 1, requestId: "a1" });
    await channel.receive({ type: "send", id: "a2", text: "steered" });
    await channel.receive({ type: "stop" });
    expect(session.stops).toBe(1);
    expect(device.of("reply")).toEqual([{ type: "reply", ids: ["a2"], text: "", status: "interrupted" }]);
  });

  it("tells a reconnecting device about approvals created while it was away", async () => {
    const first = new FakeConnection();
    const detach = channel.connect(first);
    void approvals.request({ sessionKey: "device", windowLabel: "Desk device", toolName: "bash", args: { command: "date" } });
    bus.emit({ type: "approvals_changed" });
    expect(first.of("needs_approval")).toHaveLength(1);
    first.open = false;
    detach();
    void approvals.request({ sessionKey: "device", windowLabel: "Desk device", toolName: "write", args: { path: "a" } });
    bus.emit({ type: "approvals_changed" });
    const second = new FakeConnection();
    channel.connect(second);
    expect(second.of("needs_approval").map((m) => m.tool)).toEqual(["bash", "write"]);
    bus.emit({ type: "approvals_changed" });
    expect(second.of("needs_approval")).toHaveLength(2);
    for (const request of approvals.pending()) approvals.answer(request.id, "deny");
  });

  it("tells the device about approvals its own session waits for, once each", async () => {
    const device = new FakeConnection();
    channel.connect(device);
    const own = approvals.request({ sessionKey: "device", windowLabel: "Desk device", toolName: "bash", args: { command: "date" } });
    void approvals.request({ sessionKey: "wechat", windowLabel: "WeChat", toolName: "write", args: { path: "a" } });
    bus.emit({ type: "approvals_changed" });
    expect(device.of("needs_approval")).toEqual([{ type: "needs_approval", tool: "bash", summary: expect.any(String) }]);
    approvals.answer(approvals.pending().find((r) => r.sessionKey === "device")!.id, "deny");
    await expect(own).resolves.toMatchObject({ allowed: false });
  });
});
