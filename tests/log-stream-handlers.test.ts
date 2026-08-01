/**
 * WS method handler tests — logs.subscribe / logs.unsubscribe.
 *
 * These are handler factories injected into WebChatChannel.handlers. The
 * LogStreamer is a concrete class; we pass a structural mock cast to it so
 * the test focuses on the admin gate, subscribe/unsubscribe lifecycle, and
 * disconnect cleanup.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogStreamHandlers } from "../src/web/routes/log-stream-handlers.js";
import type { WsClientView } from "../src/channels/webchat/WebChatChannel.js";
import type { LogStreamer, BackendLogEntry } from "../src/web/routes/log-stream.js";

function makeLogStreamer(): LogStreamer & { listeners: Set<(e: BackendLogEntry) => void>; emit: (e: BackendLogEntry) => void } {
  const listeners = new Set<(e: BackendLogEntry) => void>();
  const backlog: BackendLogEntry[] = [{ time: 1, level: "info", module: "gateway", msg: "boot" }];
  const streamer = {
    subscribe: vi.fn((listener: (e: BackendLogEntry) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    getBacklog: vi.fn(() => backlog),
    listeners,
    emit: (entry: BackendLogEntry) => {
      for (const l of listeners) l(entry);
    },
  };
  return streamer as unknown as LogStreamer & {
    listeners: Set<(e: BackendLogEntry) => void>;
    emit: (e: BackendLogEntry) => void;
  };
}

function makeView(overrides?: Partial<WsClientView>): WsClientView & { events: unknown[]; cleanups: (() => void)[] } {
  const events: unknown[] = [];
  const cleanups: (() => void)[] = [];
  return {
    id: "client-1",
    user: null,
    sessionKey: null,
    sessionId: null,
    sendEvent: (event, payload) => events.push({ event, payload }),
    onDisconnect: (fn) => cleanups.push(fn),
    events,
    cleanups,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("logs handlers", () => {
  it("allows subscribe in single-user mode (webAuth disabled)", () => {
    const streamer = makeLogStreamer();
    const handlers = createLogStreamHandlers({ logStreamer: streamer, webAuthEnabled: false });
    const view = makeView();

    const result = handlers["logs.subscribe"](view, {}) as { entries: BackendLogEntry[] };
    expect(streamer.subscribe).toHaveBeenCalledTimes(1);
    expect(result.entries).toEqual([{ time: 1, level: "info", module: "gateway", msg: "boot" }]);
  });

  it("gates subscribe behind admin when webAuth is enabled", () => {
    const streamer = makeLogStreamer();
    const handlers = createLogStreamHandlers({ logStreamer: streamer, webAuthEnabled: true });

    const nonAdmin = makeView({ user: { id: "u1", username: "u", role: "user", createdAt: 1, hasWeixin: false } });
    expect(() => handlers["logs.subscribe"](nonAdmin, {})).toThrow(/Admin privileges required/);

    const admin = makeView({ user: { id: "u2", username: "a", role: "admin", createdAt: 1, hasWeixin: false } });
    expect(handlers["logs.subscribe"](admin, {})).toBeDefined();
  });

  it("streams log.entry events to the subscribed client", () => {
    const streamer = makeLogStreamer();
    const handlers = createLogStreamHandlers({ logStreamer: streamer, webAuthEnabled: false });
    const view = makeView();

    handlers["logs.subscribe"](view, {});
    streamer.emit({ time: 2, level: "warn", module: "gateway", msg: "boom" });

    expect(view.events).toEqual([
      { event: "log.entry", payload: { time: 2, level: "warn", module: "gateway", msg: "boom" } },
    ]);
  });

  it("unsubscribe removes the listener and stops future events", () => {
    const streamer = makeLogStreamer();
    const handlers = createLogStreamHandlers({ logStreamer: streamer, webAuthEnabled: false });
    const view = makeView();

    handlers["logs.subscribe"](view, {});
    expect(streamer.listeners.size).toBe(1);

    const result = handlers["logs.unsubscribe"](view, {});
    expect(result).toEqual({ ok: true });
    expect(streamer.listeners.size).toBe(0);

    streamer.emit({ time: 3, level: "info", msg: "ignored" });
    expect(view.events).toEqual([]);
  });

  it("registers a disconnect cleanup that unsubscribes", () => {
    const streamer = makeLogStreamer();
    const handlers = createLogStreamHandlers({ logStreamer: streamer, webAuthEnabled: false });
    const view = makeView();

    handlers["logs.subscribe"](view, {});
    expect(view.cleanups.length).toBe(1);

    view.cleanups[0]!();
    expect(streamer.listeners.size).toBe(0);
  });
});
