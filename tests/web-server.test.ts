/**
 * WebServer bootstrap tests — Express routes, channel lifecycle, dedup,
 * shutdown isolation, and the pure helpers (resolveBindHost,
 * MessageDeduplicator, runShutdownSteps, createKeyedSerializer).
 *
 * The heavy dependencies (ConfigStore, AgentRegistry, Dispatcher,
 * OutboundDeliver, LogStreamer, credential store) are structural mocks; the
 * WebAuthStore + FileSessionStore + ChannelRegistry are real so the route
 * mounting and WebChat channel registration are exercised for real.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import type { AddressInfo } from "net";
import {
  WebServer,
  resolveBindHost,
  MessageDeduplicator,
  runShutdownSteps,
  createKeyedSerializer,
  type WebServerOptions,
} from "../src/web/server.js";
import { WebAuthStore } from "../src/web/routes/auth.js";
import { FileSessionStore } from "../src/sessions/store.js";
import { ChannelRegistryImpl } from "../src/channels/ChannelRegistry.js";
import type { InboundMessageContext, ChannelAdapter, ChannelId, SendResult, ChannelMeta } from "../src/channels/ChannelAdapter.js";

const tempDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vex-web-server-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Structural mocks for the heavy deps
// ---------------------------------------------------------------------------

function makeDummyChannel(id: ChannelId): ChannelAdapter {
  return {
    id,
    meta: { id, name: id, description: "dummy", capabilities: { chatTypes: ["direct"], supportsMedia: false, supportsReply: false, supportsMention: false, supportsReaction: false, supportsThread: false, supportsEdit: false, maxMessageLength: 1000 } } as ChannelMeta,
    initialize: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    sendMessage: vi.fn(async (): Promise<SendResult> => ({ success: true, messageId: "m1" })),
    replyToContext: vi.fn(async (): Promise<SendResult> => ({ success: true, messageId: "m1" })),
    isHealthy: vi.fn(async () => true),
    onMessage: vi.fn(),
  } as ChannelAdapter;
}

function makeOptions(overrides?: Partial<WebServerOptions>): WebServerOptions {
  const auth = new WebAuthStore({ dbPath: path.join(tmpDir(), "auth.sqlite"), enabled: false });
  return {
    version: "1.15.0",
    getProviders: () => [{ id: "minimax", name: "MiniMax", available: true }],
    config: { server: { port: 0, host: "127.0.0.1" }, webAuth: { enabled: false } },
    configPath: path.join(tmpDir(), "config.local.yaml"),
    auth,
    sessionStore: new FileSessionStore(path.join(tmpDir(), "sessions")),
    registry: new ChannelRegistryImpl(),
    configStore: { resolve: vi.fn(async () => ({ userId: "u1", channelId: "webchat" })) } as unknown as WebServerOptions["configStore"],
    agentRegistry: { getOrCreate: vi.fn(), reset: vi.fn(async () => {}), shutdown: vi.fn(async () => {}) } as unknown as WebServerOptions["agentRegistry"],
    dispatcher: { dispatch: vi.fn(async () => {}), dispatchSynthetic: vi.fn(async () => {}) } as unknown as WebServerOptions["dispatcher"],
    outbound: { sendText: vi.fn(async () => ({ success: true })) } as unknown as WebServerOptions["outbound"],
    logStreamer: { subscribe: vi.fn(() => () => {}), unsubscribe: vi.fn(), getBacklog: vi.fn(() => []) } as unknown as WebServerOptions["logStreamer"],
    credentialStore: { list: vi.fn(() => []), getByUserId: vi.fn(() => undefined), save: vi.fn(), delete: vi.fn(() => false) } as unknown as WebServerOptions["credentialStore"],
    getWeixinConfig: () => undefined,
    ...overrides,
  };
}

interface Harness {
  server: WebServer;
  httpServer: http.Server;
  port: number;
  close: () => Promise<void>;
}

async function startServer(options: WebServerOptions): Promise<Harness> {
  const server = new WebServer(options);
  await server.initialize();
  await new Promise<void>((resolve, reject) => {
    server.server.once("error", reject);
    server.server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.server.address() as AddressInfo).port;
  return {
    server,
    httpServer: server.server,
    port,
    close: async () => {
      await server.shutdown();
    },
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("resolveBindHost", () => {
  it("defaults to loopback for unset/blank hosts", () => {
    expect(resolveBindHost()).toBe("127.0.0.1");
    expect(resolveBindHost("  ")).toBe("127.0.0.1");
    expect(resolveBindHost(undefined)).toBe("127.0.0.1");
  });

  it("keeps an explicit host verbatim", () => {
    expect(resolveBindHost("0.0.0.0")).toBe("0.0.0.0");
    expect(resolveBindHost(" example.com ")).toBe("example.com");
  });
});

describe("MessageDeduplicator", () => {
  it("returns false the first time and true on repeat", () => {
    const dedup = new MessageDeduplicator();
    expect(dedup.isDuplicate("key-1")).toBe(false);
    expect(dedup.isDuplicate("key-1")).toBe(true);
    expect(dedup.isDuplicate("key-2")).toBe(false);
  });

  it("treats distinct keys independently", () => {
    const dedup = new MessageDeduplicator();
    dedup.isDuplicate("a");
    dedup.isDuplicate("b");
    expect(dedup.isDuplicate("a")).toBe(true);
    expect(dedup.isDuplicate("b")).toBe(true);
    expect(dedup.isDuplicate("c")).toBe(false);
  });
});

describe("runShutdownSteps", () => {
  it("runs steps in order", async () => {
    const order: string[] = [];
    await runShutdownSteps([
      { label: "a", run: () => { order.push("a"); } },
      { label: "b", run: async () => { order.push("b"); } },
    ]);
    expect(order).toEqual(["a", "b"]);
  });

  it("isolates a failing step so later steps still run", async () => {
    const order: string[] = [];
    await runShutdownSteps([
      { label: "boom", run: () => { throw new Error("nope"); } },
      { label: "after", run: () => { order.push("after"); } },
    ]);
    expect(order).toEqual(["after"]);
  });
});

describe("createKeyedSerializer", () => {
  it("serializes tasks sharing a key and allows parallel different keys", async () => {
    const serialize = createKeyedSerializer();
    const order: string[] = [];
    const mk = (key: string, label: string) => serialize(key, async () => {
      order.push(`${label}:start`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`${label}:end`);
    });

    // Same key: serialized. Kick both off; they must not interleave.
    const p1 = mk("k", "a");
    const p2 = mk("k", "b");
    await Promise.all([p1, p2]);
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });
});

// ---------------------------------------------------------------------------
// WebServer — routes + channel lifecycle
// ---------------------------------------------------------------------------

describe("WebServer", () => {
  it("mounts /health", async () => {
    const h = await startServer(makeOptions());
    const res = await fetch(`http://127.0.0.1:${h.port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
    await h.close();
  });

  it("mounts /api/auth/me (returns null user without a session)", async () => {
    const h = await startServer(makeOptions());
    const res = await fetch(`http://127.0.0.1:${h.port}/api/auth/me`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: unknown };
    expect(body.user).toBeNull();
    await h.close();
  });

  it("returns 404 for unknown routes", async () => {
    const h = await startServer(makeOptions());
    const res = await fetch(`http://127.0.0.1:${h.port}/no-such-route`);
    expect(res.status).toBe(404);
    await h.close();
  });

  it("serves the WebChat page through an injected staticHandler", async () => {
    // Wire the real handleStaticRequest (part 6d) into the bootstrap — the
    // same path cli/ will take. webAuth disabled so "/" is not redirected.
    const { handleStaticRequest } = await import("../src/web/index.js");
    const options = makeOptions();
    const h = await startServer({
      ...options,
      staticHandler: (req, res) =>
        handleStaticRequest(req, res, { config: options.config, auth: options.auth }),
    });
    const res = await fetch(`http://127.0.0.1:${h.port}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("/assets/marked.min.js");
    await h.close();
  });

  it("registers the WebChat channel in the channel registry", async () => {
    const options = makeOptions();
    const h = await startServer(options);
    const channels = options.registry.getAllChannels().map((c) => c.id);
    expect(channels).toContain("webchat");
    await h.close();
  });

  it("initializes the WebChat WS endpoint so /ws accepts connections", async () => {
    const h = await startServer(makeOptions());
    const ws = await new Promise<import("ws").default>((resolve, reject) => {
      const client = new (require("ws"))(`ws://127.0.0.1:${h.port}/ws`) as import("ws").default;
      client.on("open", () => resolve(client));
      client.on("error", reject);
    });
    // A bare connection stays open (no auth rejection when webAuth disabled).
    expect(ws.readyState).toBe(1);
    ws.close();
    await h.close();
  });

  it("reports configured providers and the application version through status.get", async () => {
    const h = await startServer(makeOptions());
    const ws = await new Promise<import("ws").default>((resolve, reject) => {
      const client = new (require("ws"))(`ws://127.0.0.1:${h.port}/ws`) as import("ws").default;
      client.on("open", () => resolve(client));
      client.on("error", reject);
    });
    const response = new Promise<{ payload: { version: string; providers: Array<{ id: string }> } }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for status.get")), 2000);
      ws.on("message", function onMessage(data: Buffer) {
        const frame = JSON.parse(data.toString()) as { type?: string; id?: string };
        if (frame.type === "res" && frame.id === "status-1") {
          clearTimeout(timer);
          ws.off("message", onMessage);
          resolve(frame as { payload: { version: string; providers: Array<{ id: string }> } });
        }
      });
    });
    ws.send(JSON.stringify({ type: "req", id: "status-1", method: "status.get", params: {} }));

    await expect(response).resolves.toMatchObject({
      payload: { version: "1.15.0", providers: [{ id: "minimax" }] },
    });
    ws.close();
    await h.close();
  });

  it("wires a configured titleGenerator through to the WebChat channel", async () => {
    const complete = vi.fn(async () => ({ text: "会话标题" }));
    const options = makeOptions({ titleGenerator: { provider: "deepseek", model: "deepseek-chat", complete } });
    // Route the mocked dispatcher's reply back through the real WebChatChannel,
    // matching how OutboundDeliver → channel.sendMessage works for real.
    (options.dispatcher.dispatch as ReturnType<typeof vi.fn>).mockImplementation(async (ctx: InboundMessageContext) => {
      const channel = options.registry.getChannel("webchat")!;
      await channel.sendMessage({ chatId: ctx.chatId, content: `echo: ${ctx.content}` });
    });
    const h = await startServer(options);
    const ws = await new Promise<import("ws").default>((resolve, reject) => {
      const client = new (require("ws"))(`ws://127.0.0.1:${h.port}/ws`) as import("ws").default;
      client.on("open", () => resolve(client));
      client.on("error", reject);
    });

    ws.send(JSON.stringify({ type: "req", id: "c1", method: "chat.send", params: { message: "记一下待办" } }));

    const titleEvent = await new Promise<{ payload: { label: string } }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for session.title")), 2000);
      ws.on("message", function onMsg(data: Buffer) {
        const frame = JSON.parse(data.toString());
        if (frame?.type === "event" && frame?.event === "session.title") {
          clearTimeout(timer);
          ws.off("message", onMsg);
          resolve(frame);
        }
      });
    });

    expect(titleEvent.payload.label).toBe("会话标题");
    expect(complete).toHaveBeenCalledTimes(1);

    ws.close();
    await h.close();
  });

  it("restores persisted per-user WeChat logins at startup", async () => {
    const credentialStore = {
      list: vi.fn(() => [{ userId: "u1", token: "tok", accountId: "acc", baseUrl: "https://example" }]),
      getByUserId: vi.fn(() => ({ userId: "u1", token: "tok", accountId: "acc", baseUrl: "https://example" })),
      save: vi.fn(),
      delete: vi.fn(() => false),
    };
    const options = makeOptions({
      credentialStore: credentialStore as unknown as WebServerOptions["credentialStore"],
      getWeixinConfig: () => ({ baseUrl: "https://ilink.example", enabled: true }),
    });
    const h = await startServer(options);
    expect(credentialStore.list).toHaveBeenCalled();
    // The per-user channel is registered under the user's key.
    expect(options.registry.getChannelForUser("u1", "weixin")).toBeDefined();
    await h.close();
  });

  it("dedupes duplicate inbound messages before dispatch", async () => {
    const dispatch = vi.fn(async () => {});
    const options = makeOptions({
      dispatcher: { dispatch, dispatchSynthetic: vi.fn(async () => {}) } as unknown as WebServerOptions["dispatcher"],
      getWeixinConfig: () => ({ baseUrl: "https://ilink.example", enabled: true }),
    });
    const h = await startServer(options);

    // Drive the single-user WeChat channel's registered message handler
    // (WebServer.initialize wired it to the dedup + dispatch path).
    const weixinChannel = options.registry.getChannel("weixin");
    const handler = (weixinChannel as unknown as { messageHandler?: (c: InboundMessageContext) => Promise<void> }).messageHandler;
    expect(handler).toBeDefined();
    const ctx: InboundMessageContext = {
      channelId: "weixin" as const,
      messageId: "msg-1",
      chatId: "wx:o9cq",
      chatType: "direct" as const,
      senderId: "o9cq",
      content: "hello",
      timestamp: 1,
    };
    await handler!(ctx);
    await handler!(ctx); // duplicate
    expect(dispatch).toHaveBeenCalledTimes(1);
    await h.close();
  });

  it("drops empty-content inbound messages before dispatch (archive empty-guard parity)", async () => {
    const dispatch = vi.fn(async () => {});
    const options = makeOptions({
      dispatcher: { dispatch, dispatchSynthetic: vi.fn(async () => {}) } as unknown as WebServerOptions["dispatcher"],
      getWeixinConfig: () => ({ baseUrl: "https://ilink.example", enabled: true }),
    });
    const h = await startServer(options);

    // WeChatChannel.extractTextContent can produce "" for unrecognized message
    // item types; the archive's handleMessage dropped those before the agent.
    const weixinChannel = options.registry.getChannel("weixin");
    const handler = (weixinChannel as unknown as { messageHandler?: (c: InboundMessageContext) => Promise<void> }).messageHandler;
    expect(handler).toBeDefined();
    const emptyCtx: InboundMessageContext = {
      channelId: "weixin" as const,
      messageId: "msg-empty",
      chatId: "wx:o9cq",
      chatType: "direct" as const,
      senderId: "o9cq",
      content: "",
      timestamp: 1,
    };
    await handler!(emptyCtx);
    expect(dispatch).not.toHaveBeenCalled();
    await h.close();
  });

  it("shutdown runs the channel + registry teardown steps", async () => {
    const options = makeOptions();
    const agentShutdown = vi.fn(async () => {});
    (options.agentRegistry as unknown as { shutdown: ReturnType<typeof vi.fn> }).shutdown = agentShutdown;
    const h = await startServer(options);
    await h.close();
    expect(agentShutdown).toHaveBeenCalled();
  });
});
