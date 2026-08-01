/**
 * WebChatChannel tests — WS transport, frame protocol, auth, heartbeat,
 * and the chat.send dispatch path.
 *
 * The archive's websocket.ts (1145 LOC) is split here into the channel
 * (transport + protocol translation) + injected route handlers. This file
 * covers the channel itself:
 *  - frame parsing / validation (pure helpers)
 *  - connection auth (webAuth disabled → everyone in; enabled → cookie-gated)
 *  - heartbeat timeout
 *  - chat.send constructs an InboundMessageContext and dispatches it
 *  - response delivery via sendMessage → chat.delta {done:true} on the
 *    owning connection
 *  - session scoping helpers (filterWebChatSessions, canAccessBackendLogs)
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import WebSocket from "ws";
import type { AddressInfo } from "net";
import {
  WebChatChannel,
  parseRequestFrame,
  parseParams,
  getRequestId,
  filterWebChatSessions,
  canAccessBackendLogs,
  type WebChatChannelOptions,
} from "../src/channels/webchat/WebChatChannel.js";
import { WebAuthStore } from "../src/web/routes/auth.js";
import { FileSessionStore } from "../src/sessions/store.js";
import type { SessionListItem } from "../src/sessions/types.js";
import type { InboundMessageContext } from "../src/channels/ChannelAdapter.js";
import { z } from "zod";

const tempDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vex-webchat-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

interface Harness {
  channel: WebChatChannel;
  dispatch: ReturnType<typeof vi.fn>;
  auth: WebAuthStore;
  sessionStore: FileSessionStore;
  server: http.Server;
  port: number;
  close: () => Promise<void>;
}

function makeHarness(overrides?: Partial<WebChatChannelOptions>): Harness {
  const server = http.createServer();
  const auth = new WebAuthStore({
    dbPath: path.join(tmpDir(), "auth.sqlite"),
    enabled: false,
  });
  const sessionStore = new FileSessionStore(path.join(tmpDir(), "sessions"));
  let channel!: WebChatChannel;
  const dispatch = vi.fn(async (ctx: InboundMessageContext) => {
    // Simulate the Dispatcher → Outbound path: deliver a reply back through
    // the same channel's sendMessage.
    await channel.sendMessage({ chatId: ctx.chatId, content: `echo: ${ctx.content}` });
  });
  channel = new WebChatChannel({
    server,
    auth,
    sessionStore,
    dispatch,
    ...overrides,
  });
  return {
    channel,
    dispatch,
    auth,
    sessionStore,
    server,
    port: 0,
    close: async () => {
      await channel.shutdown();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

async function start(h: Harness): Promise<void> {
  await h.channel.initialize();
  await new Promise((resolve) => h.server.listen(0, "127.0.0.1", resolve));
  h.port = (h.server.address() as AddressInfo).port;
}

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function nextMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve) => {
    ws.on("message", (data) => resolve(JSON.parse(data.toString())));
  });
}

function waitForDelta(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for chat.delta")), 2000);
    ws.on("message", function onMsg(data) {
      const frame = JSON.parse(data.toString());
      if (frame?.type === "event" && frame?.event === "chat.delta" && frame?.payload?.done) {
        clearTimeout(timer);
        ws.off("message", onMsg);
        resolve(frame);
      }
    });
  });
}

describe("frame helpers", () => {
  it("parseRequestFrame accepts a valid request frame", () => {
    const frame = parseRequestFrame(
      JSON.stringify({ type: "req", id: "abc", method: "ping", params: {} }),
    );
    expect(frame).toEqual({ type: "req", id: "abc", method: "ping", params: {} });
  });

  it("parseRequestFrame rejects a malformed frame", () => {
    expect(() => parseRequestFrame(JSON.stringify({ type: "event" }))).toThrow(
      /Invalid request frame/,
    );
    expect(() => parseRequestFrame("not json")).toThrow();
  });

  it("parseParams validates through a zod schema", () => {
    const schema = z.object({ message: z.string().min(1) });
    expect(parseParams(schema, { message: "hi" })).toEqual({ message: "hi" });
    expect(() => parseParams(schema, { message: "" })).toThrow(/Invalid params/);
  });

  it("getRequestId extracts the id or returns undefined", () => {
    expect(getRequestId(JSON.stringify({ id: "x" }))).toBe("x");
    expect(getRequestId("not json")).toBeUndefined();
    expect(getRequestId(JSON.stringify({ nope: 1 }))).toBeUndefined();
  });
});

describe("session scoping helpers", () => {
  it("filterWebChatSessions only keeps webchat: sessions and honors the limit", () => {
    const sessions: SessionListItem[] = [
      { sessionKey: "webchat:user1:sess-a", sessionId: "a", updatedAt: 1 },
      { sessionKey: "weixin:user2:sess-b", sessionId: "b", updatedAt: 2 },
      { sessionKey: "webchat:user1:sess-c", sessionId: "c", updatedAt: 3 },
    ];
    expect(filterWebChatSessions(sessions).map((s) => s.sessionKey)).toEqual([
      "webchat:user1:sess-a",
      "webchat:user1:sess-c",
    ]);
    expect(filterWebChatSessions(sessions, 1).map((s) => s.sessionKey)).toEqual([
      "webchat:user1:sess-a",
    ]);
    expect(
      filterWebChatSessions(sessions, undefined, "user1").map((s) => s.sessionKey),
    ).toEqual(["webchat:user1:sess-a", "webchat:user1:sess-c"]);
  });

  it("canAccessBackendLogs gates on webAuth + admin role", () => {
    expect(canAccessBackendLogs(false)).toBe(true); // single-user mode: operator
    expect(canAccessBackendLogs(true, "admin")).toBe(true);
    expect(canAccessBackendLogs(true, "user")).toBe(false);
    expect(canAccessBackendLogs(true)).toBe(false);
  });
});

describe("WebChatChannel", () => {
  it("rejects connections when webAuth is enabled and no cookie is present", async () => {
    const h = makeHarness({
      auth: new WebAuthStore({
        dbPath: path.join(tmpDir(), "auth.sqlite"),
        enabled: true,
      }),
    });
    await start(h);

    await expect(
      new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${h.port}/ws`);
        ws.on("close", (code) => (code === 1008 ? resolve() : reject(new Error(`code=${code}`))));
        ws.on("error", (err) => reject(err));
      }),
    ).resolves.toBeUndefined();

    await h.close();
  });

  it("responds to ping with pong", async () => {
    const h = makeHarness();
    await start(h);
    const ws = await connect(h.port);

    ws.send(JSON.stringify({ type: "req", id: "p1", method: "ping", params: {} }));
    const res = await nextMessage(ws);
    expect(res).toMatchObject({ type: "res", id: "p1", ok: true, payload: { pong: expect.any(Number) } });

    ws.close();
    await h.close();
  });

  it("chat.send carries the authenticated user's webUserId top-level so Dispatcher resolves per-user config/agent", async () => {
    const auth = new WebAuthStore({ dbPath: path.join(tmpDir(), "auth.sqlite"), enabled: true });
    await auth.createUser("alice", "password123");
    const { session } = await auth.login("alice", "password123");

    const h = makeHarness({ auth });
    await start(h);

    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${h.port}/ws`, { headers: { cookie: `vexsid=${session.id}` } });
      client.on("open", () => resolve(client));
      client.on("error", reject);
    });

    ws.send(JSON.stringify({ type: "req", id: "c1", method: "chat.send", params: { message: "hi" } }));
    await waitForDelta(ws);

    expect(h.dispatch).toHaveBeenCalledTimes(1);
    const ctx = h.dispatch.mock.calls[0][0] as InboundMessageContext;
    // The top-level webUserId (not just raw.__webUserId) is what
    // Dispatcher.resolveUserId reads — without it the user's config/persona
    // settings never apply and each tab mints its own Agent.
    expect(ctx.webUserId).toBe(session.userId);
    expect((ctx.raw as { __webUserId?: string } | undefined)?.__webUserId).toBe(session.userId);

    ws.close();
    await h.close();
  });

  it("chat.send dispatches an InboundMessageContext and delivers a chat.delta", async () => {
    const h = makeHarness();
    await start(h);
    const ws = await connect(h.port);

    ws.send(JSON.stringify({ type: "req", id: "c1", method: "chat.send", params: { message: "你好" } }));
    const delta = (await waitForDelta(ws)) as {
      payload: { done: boolean; delta: string; sessionId: string };
    };

    expect(h.dispatch).toHaveBeenCalledTimes(1);
    const ctx = h.dispatch.mock.calls[0][0] as InboundMessageContext;
    expect(ctx.channelId).toBe("webchat");
    expect(ctx.content).toBe("你好");
    expect(ctx.chatId).toMatch(/^webchat:/);
    expect(delta.payload.done).toBe(true);
    expect(delta.payload.delta).toBe("echo: 你好");

    ws.close();
    await h.close();
  });

  it("returns an error response for an unknown method", async () => {
    const h = makeHarness();
    await start(h);
    const ws = await connect(h.port);

    ws.send(JSON.stringify({ type: "req", id: "u1", method: "nope.missing", params: {} }));
    const res = await nextMessage(ws);
    expect(res).toMatchObject({ type: "res", id: "u1", ok: false });
    expect((res as any).error?.message).toContain("Unknown method");

    ws.close();
    await h.close();
  });

  it("appends the exchange to the session transcript", async () => {
    const h = makeHarness();
    await start(h);
    const ws = await connect(h.port);

    ws.send(JSON.stringify({ type: "req", id: "c2", method: "chat.send", params: { message: "记下来" } }));
    await waitForDelta(ws);
    await new Promise((r) => setTimeout(r, 50));

    const sessions = await h.sessionStore.list();
    expect(sessions.length).toBe(1);
    expect(sessions[0]!.sessionKey).toMatch(/^webchat:/);
    const transcript = await h.sessionStore.loadTranscript(sessions[0]!.sessionId);
    expect(transcript.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(transcript[0]!.content).toBe("记下来");
    expect(transcript[1]!.content).toBe("echo: 记下来");

    ws.close();
    await h.close();
  });

  it("chat.cancel reports cancelled:false when nothing is in flight", async () => {
    const h = makeHarness();
    await start(h);
    const ws = await connect(h.port);

    ws.send(JSON.stringify({ type: "req", id: "x1", method: "chat.cancel", params: {} }));
    const res = await nextMessage(ws);
    expect(res).toMatchObject({ type: "res", id: "x1", ok: true, payload: { cancelled: false } });

    ws.close();
    await h.close();
  });

  it("isHealthy is true while initialized", async () => {
    const h = makeHarness();
    expect(await h.channel.isHealthy()).toBe(false);
    await start(h);
    expect(await h.channel.isHealthy()).toBe(true);
    await h.close();
  });
});
