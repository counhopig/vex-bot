/**
 * WS method handler tests — sessions.* (list/history/delete/reset/restore).
 *
 * These are pure handler factories injected into WebChatChannel.handlers:
 * `(client: WsClientView, params) => Promise<unknown>`. They need no real
 * WebSocket — the client view is a plain object. Ported from the archive's
 * WsServer.handleSessions* methods, adapted to the injected-store design.
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createSessionHandlers } from "../src/web/routes/sessions.js";
import { FileSessionStore } from "../src/sessions/store.js";
import type { WsClientView } from "../src/channels/webchat/WebChatChannel.js";

const tempDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vex-sess-routes-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeStore(): FileSessionStore {
  return new FileSessionStore(path.join(tmpDir(), "sessions"));
}

function makeView(overrides?: Partial<WsClientView>): WsClientView {
  const events: Array<{ event: string; payload?: unknown }> = [];
  return {
    id: "client-1",
    user: null,
    sessionKey: null,
    sessionId: null,
    sendEvent: (event, payload) => events.push({ event, payload }),
    onDisconnect: () => {},
    events,
    ...overrides,
  } as WsClientView & { events: typeof events };
}

describe("sessions handlers", () => {
  it("sessions.list returns webchat-scoped sessions with optional limit", async () => {
    const store = makeStore();
    await store.getOrCreate("webchat:user1:sess-a");
    await store.getOrCreate("webchat:user1:sess-b");
    await store.getOrCreate("weixin:o9cq:sess-c");
    const handlers = createSessionHandlers({ sessionStore: store });

    const result = (await handlers["sessions.list"](makeView(), {})) as {
      sessions: Array<{ sessionKey: string }>;
    };
    expect(result.sessions.map((s) => s.sessionKey).sort()).toEqual([
      "webchat:user1:sess-a",
      "webchat:user1:sess-b",
    ]);
  });

  it("sessions.list filters by authenticated user prefix", async () => {
    const store = makeStore();
    await store.getOrCreate("webchat:user1:sess-a");
    await store.getOrCreate("webchat:user2:sess-b");
    const handlers = createSessionHandlers({ sessionStore: store });

    const result = (await handlers["sessions.list"](
      makeView({ user: { id: "user2", username: "u", role: "user", createdAt: 1, hasWeixin: false } }),
      {},
    )) as { sessions: Array<{ sessionKey: string }> };
    expect(result.sessions.map((s) => s.sessionKey)).toEqual(["webchat:user2:sess-b"]);
  });

  it("sessions.history returns the transcript for an owned session", async () => {
    const store = makeStore();
    const sess = await store.getOrCreate("webchat:user1:sess-a");
    await store.appendTranscript(sess.sessionId, sess.sessionKey, {
      role: "user",
      content: "hi",
      timestamp: 1,
    });
    const handlers = createSessionHandlers({ sessionStore: store });

    const result = (await handlers["sessions.history"](
      makeView({ user: { id: "user1", username: "u", role: "user", createdAt: 1, hasWeixin: false } }),
      { sessionKey: "webchat:user1:sess-a" },
    )) as { sessionKey: string; messages: Array<{ role: string }> };
    expect(result.sessionKey).toBe("webchat:user1:sess-a");
    expect(result.messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("sessions.history rejects a session owned by another user", async () => {
    const store = makeStore();
    await store.getOrCreate("webchat:user1:sess-a");
    const handlers = createSessionHandlers({ sessionStore: store });

    await expect(
      handlers["sessions.history"](
        makeView({ user: { id: "user2", username: "u", role: "user", createdAt: 1, hasWeixin: false } }),
        { sessionKey: "webchat:user1:sess-a" },
      ),
    ).rejects.toThrow(/Session not found/);
  });

  it("sessions.delete removes an owned session", async () => {
    const store = makeStore();
    const sess = await store.getOrCreate("webchat:user1:sess-a");
    await store.appendTranscript(sess.sessionId, sess.sessionKey, {
      role: "user",
      content: "x",
      timestamp: 1,
    });
    const handlers = createSessionHandlers({ sessionStore: store });

    const result = await handlers["sessions.delete"](
      makeView({ user: { id: "user1", username: "u", role: "user", createdAt: 1, hasWeixin: false } }),
      { sessionKey: "webchat:user1:sess-a" },
    );
    expect(result).toEqual({ success: true });
    expect(await store.get("webchat:user1:sess-a")).toBeNull();
  });

  it("sessions.reset returns a fresh session key under the same namespace", async () => {
    const store = makeStore();
    await store.getOrCreate("webchat:user1:sess-a");
    const handlers = createSessionHandlers({ sessionStore: store });

    const result = (await handlers["sessions.reset"](
      makeView({ user: { id: "user1", username: "u", role: "user", createdAt: 1, hasWeixin: false } }),
      { sessionKey: "webchat:user1:sess-a" },
    )) as { success: boolean; sessionKey: string };
    expect(result.success).toBe(true);
    expect(result.sessionKey).toMatch(/^webchat:user1:/);
    expect(result.sessionKey).not.toBe("webchat:user1:sess-a");
  });

  it("sessions.restore rebinds the client and returns the transcript", async () => {
    const store = makeStore();
    const sess = await store.getOrCreate("webchat:user1:sess-a");
    await store.appendTranscript(sess.sessionId, sess.sessionKey, {
      role: "assistant",
      content: "hello",
      timestamp: 1,
    });
    const handlers = createSessionHandlers({ sessionStore: store });

    const view = makeView({
      user: { id: "user1", username: "u", role: "user", createdAt: 1, hasWeixin: false },
    });
    const result = (await handlers["sessions.restore"](view, {
      sessionKey: "webchat:user1:sess-a",
    })) as { sessionKey: string; sessionId: string; messages: Array<{ role: string }> };

    expect(result.sessionKey).toBe("webchat:user1:sess-a");
    expect(view.sessionKey).toBe("webchat:user1:sess-a"); // client rebound
    expect(view.sessionId).toBe(sess.sessionId);
    expect(result.messages.map((m) => m.role)).toEqual(["assistant"]);
  });

  it("rejects an unknown method key", async () => {
    const store = makeStore();
    const handlers = createSessionHandlers({ sessionStore: store });
    expect(handlers["sessions.nope"]).toBeUndefined();
  });

  it("chat.clear resets the client's bound session and rebinds it", async () => {
    const store = makeStore();
    const sess = await store.getOrCreate("webchat:user1:sess-a");
    const handlers = createSessionHandlers({ sessionStore: store });
    const view = makeView({
      user: { id: "user1", username: "u", role: "user", createdAt: 1, hasWeixin: false },
      sessionKey: "webchat:user1:sess-a",
      sessionId: sess.sessionId,
    });

    const result = (await handlers["chat.clear"](view, {})) as {
      success: boolean;
      sessionKey: string;
      sessionId: string;
    };
    expect(result.success).toBe(true);
    expect(result.sessionKey).toMatch(/^webchat:user1:/);
    expect(result.sessionKey).not.toBe("webchat:user1:sess-a");
    // Client rebound to the fresh session.
    expect(view.sessionKey).toBe(result.sessionKey);
    expect(view.sessionId).toBe(result.sessionId);
  });

  it("chat.clear rejects a client with no active session", async () => {
    const store = makeStore();
    const handlers = createSessionHandlers({ sessionStore: store });
    const view = makeView({
      user: { id: "user1", username: "u", role: "user", createdAt: 1, hasWeixin: false },
      sessionKey: null,
      sessionId: null,
    });

    await expect(handlers["chat.clear"](view, {})).rejects.toThrow(/No active session/);
  });
});
