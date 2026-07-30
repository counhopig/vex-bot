/**
 * EventBus tests — class-based pub/sub (no process-global state).
 *
 * The hook system observably shares process-wide lifecycle events, so
 * the module-level convenience `defaultBus` is exposed for app-wide
 * use. But every test gets its own bus instance — that's what makes
 * the class form worth the refactor.
 */

import { describe, it, expect, vi } from "vitest";
import type { HookEvent, MessageReceivedEvent } from "../src/hooks/types.js";

describe("EventBus", () => {
  let EventBus: typeof import("../src/hooks/EventBus.js").EventBus;

  beforeAll(async () => {
    ({ EventBus } = await import("../src/hooks/EventBus.js"));
  });

  function receivedEvent(): MessageReceivedEvent {
    return {
      type: "message_received",
      timestamp: 1000,
      context: {
        channelId: "webchat",
        messageId: "m1",
        chatId: "c1",
        chatType: "direct",
        senderId: "u1",
        content: "hi",
        timestamp: 1000,
      },
    };
  }

  it("starts empty", () => {
    const bus = new EventBus();
    expect(bus.handlerCount()).toBe(0);
    expect(bus.handlerCount("message_received")).toBe(0);
  });

  it("subscribe registers a handler and returns an unsubscribe function", () => {
    const bus = new EventBus();
    const handler = vi.fn();
    const unsub = bus.subscribe("message_received", handler);
    expect(typeof unsub).toBe("function");
    expect(bus.handlerCount("message_received")).toBe(1);
    unsub();
    expect(bus.handlerCount("message_received")).toBe(0);
  });

  it("emit invokes all handlers for the matching event type", async () => {
    const bus = new EventBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe("message_received", a);
    bus.subscribe("message_received", b);
    const ev = receivedEvent();
    await bus.emit(ev);
    expect(a).toHaveBeenCalledWith(ev);
    expect(b).toHaveBeenCalledWith(ev);
  });

  it("emit returns when no handlers are registered", async () => {
    const bus = new EventBus();
    await expect(bus.emit(receivedEvent())).resolves.toBeUndefined();
  });

  it("emit only invokes handlers for the matching type", async () => {
    const bus = new EventBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe("message_received", a);
    bus.subscribe("tool_start", b);
    await bus.emit(receivedEvent());
    expect(a).toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });

  it("isolates errors in one handler from others", async () => {
    const bus = new EventBus();
    const a = vi.fn(() => {
      throw new Error("boom");
    });
    const b = vi.fn();
    bus.subscribe("message_received", a);
    bus.subscribe("message_received", b);
    await expect(bus.emit(receivedEvent())).resolves.toBeUndefined();
    expect(b).toHaveBeenCalled();
  });

  it("subscribe multiple events via object map returns one unsubscribe for all", () => {
    const bus = new EventBus();
    const a = vi.fn();
    const b = vi.fn();
    const unsub = bus.subscribeMany({ message_received: a, tool_start: b });
    expect(bus.handlerCount()).toBe(2);
    unsub();
    expect(bus.handlerCount()).toBe(0);
  });

  it("unsubscribe removes only the specified handler", () => {
    const bus = new EventBus();
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = bus.subscribe("message_received", a);
    bus.subscribe("message_received", b);
    unsubA();
    expect(bus.handlerCount("message_received")).toBe(1);
  });

  it("async handlers are awaited", async () => {
    const bus = new EventBus();
    let resolved = false;
    bus.subscribe("message_received", async () => {
      await new Promise((r) => setTimeout(r, 5));
      resolved = true;
    });
    await bus.emit(receivedEvent());
    expect(resolved).toBe(true);
  });

  it("independent instances do not share handlers", async () => {
    const a = new EventBus();
    const b = new EventBus();
    const handler = vi.fn();
    a.subscribe("message_received", handler);
    await b.emit(receivedEvent());
    expect(handler).not.toHaveBeenCalled();
  });

  it("clear removes every handler", () => {
    const bus = new EventBus();
    bus.subscribe("message_received", vi.fn());
    bus.subscribe("tool_start", vi.fn());
    expect(bus.handlerCount()).toBe(2);
    bus.clear();
    expect(bus.handlerCount()).toBe(0);
  });

  it("emit tolerates a handler returning a non-throwing rejection (sync throw)", async () => {
    const bus = new EventBus();
    const calls: string[] = [];
    bus.subscribe("message_received", () => {
      calls.push("a");
      throw new Error("sync boom");
    });
    bus.subscribe("message_received", () => {
      calls.push("b");
    });
    await bus.emit(receivedEvent());
    expect(calls).toEqual(["a", "b"]);
  });
});

describe("convenience emit* functions", () => {
  let EventBus: typeof import("../src/hooks/EventBus.js").EventBus;
  let defaultBus: typeof import("../src/hooks/EventBus.js").defaultBus;
  let emitMessageReceived: typeof import("../src/hooks/index.js").emitMessageReceived;
  let emitMessageSending: typeof import("../src/hooks/index.js").emitMessageSending;
  let emitMessageSent: typeof import("../src/hooks/index.js").emitMessageSent;
  let emitAgentStart: typeof import("../src/hooks/index.js").emitAgentStart;
  let emitAgentEnd: typeof import("../src/hooks/index.js").emitAgentEnd;
  let emitToolStart: typeof import("../src/hooks/index.js").emitToolStart;
  let emitToolEnd: typeof import("../src/hooks/index.js").emitToolEnd;
  let emitError: typeof import("../src/hooks/index.js").emitError;

  beforeAll(async () => {
    ({ EventBus, defaultBus } = await import("../src/hooks/EventBus.js"));
    ({
      emitMessageReceived,
      emitMessageSending,
      emitMessageSent,
      emitAgentStart,
      emitAgentEnd,
      emitToolStart,
      emitToolEnd,
      emitError,
    } = await import("../src/hooks/index.js"));
  });

  it("defaultBus is a shared EventBus instance", () => {
    expect(defaultBus).toBeInstanceOf(EventBus);
  });

  it("emitMessageReceived sends to subscribers", () => {
    const h = vi.fn();
    const unsub = defaultBus.subscribe("message_received", h);
    try {
      emitMessageReceived({
        channelId: "webchat",
        messageId: "m1",
        chatId: "c1",
        chatType: "direct",
        senderId: "u1",
        content: "hi",
        timestamp: 1000,
      });
      expect(h).toHaveBeenCalled();
    } finally {
      unsub();
    }
  });

  it("emitMessageSending / Sent send correct fields", () => {
    const h = vi.fn();
    const u1 = defaultBus.subscribe("message_sending", h);
    const u2 = defaultBus.subscribe("message_sent", h);
    try {
      emitMessageSending({ channelId: "wc", chatId: "c", content: "x" });
      expect(h.mock.calls[0]?.[0].channelId).toBe("wc");
      expect(h.mock.calls[0]?.[0].content).toBe("x");
      emitMessageSent({ channelId: "wc", chatId: "c", success: true });
      expect(h.mock.calls[1]?.[0].success).toBe(true);
    } finally {
      u1();
      u2();
    }
  });

  it("emitAgentStart / End send provider/model", () => {
    const h = vi.fn();
    const u1 = defaultBus.subscribe("agent_start", h);
    const u2 = defaultBus.subscribe("agent_end", h);
    try {
      emitAgentStart({ provider: "openai", model: "gpt-4", messages: [] });
      expect(h.mock.calls[0]?.[0].provider).toBe("openai");
      emitAgentEnd({ provider: "openai", model: "gpt-4", response: "ok", durationMs: 100 });
      expect(h.mock.calls[1]?.[0].response).toBe("ok");
    } finally {
      u1();
      u2();
    }
  });

  it("emitToolStart / End send toolName + result", () => {
    const h = vi.fn();
    const u1 = defaultBus.subscribe("tool_start", h);
    const u2 = defaultBus.subscribe("tool_end", h);
    try {
      emitToolStart({ toolName: "bash", toolCallId: "id", arguments: { cmd: "ls" } });
      expect(h.mock.calls[0]?.[0].toolName).toBe("bash");
      emitToolEnd({ toolName: "bash", toolCallId: "id", result: { ok: 1 }, isError: false, durationMs: 10 });
      expect(h.mock.calls[1]?.[0].isError).toBe(false);
    } finally {
      u1();
      u2();
    }
  });

  it("emitError sends error and optional context", () => {
    const h = vi.fn();
    const u = defaultBus.subscribe("error", h);
    try {
      emitError(new Error("boom"), "during dispatch");
      expect(h.mock.calls[0]?.[0].error.message).toBe("boom");
      expect(h.mock.calls[0]?.[0].context).toBe("during dispatch");
    } finally {
      u();
    }
  });
});