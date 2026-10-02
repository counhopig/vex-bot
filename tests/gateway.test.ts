import { readFile, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall, type FauxProviderHandle, type FauxResponseStep } from "@earendil-works/pi-ai";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { saveConfigText } from "../src/config/load.js";
import { EventBus } from "../src/core/events.js";
import { Session } from "../src/core/session.js";
import { SessionManager } from "../src/core/sessionManager.js";
import { WebAuth } from "../src/gateway/auth.js";
import { Gateway } from "../src/gateway/server.js";
import { resolvePaths, type VexPaths } from "../src/paths.js";
import { ApprovalManager } from "../src/policy/approvals.js";
import { createToolGate } from "../src/policy/gate.js";
import { ToolPolicy } from "../src/policy/policy.js";
import type { ServerMessage } from "../src/protocol/messages.js";
import { createCoreTools } from "../src/tools/registry.js";
import { TestClient } from "./helpers/client.js";
import { createFaux, fauxStreamFn } from "./helpers/faux.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

const staticDir = fileURLToPath(new URL("../src/web/static/", import.meta.url));

let dir: string;
let paths: VexPaths;
let faux: FauxProviderHandle;
let gateway: Gateway | undefined;
let sessions: SessionManager | undefined;
let clients: TestClient[];

beforeEach(async () => {
  dir = await makeTmpDir();
  paths = resolvePaths(dir);
  clients = [];
});
afterEach(async () => {
  for (const c of clients) c.close();
  await sessions?.shutdown();
  await gateway?.stop();
  gateway = undefined;
  sessions = undefined;
  await removeTmpDir(dir);
});

async function start(opts: { token?: string; responses?: FauxResponseStep[] } = {}): Promise<string> {
  faux = createFaux();
  faux.setResponses(opts.responses ?? []);
  const bus = new EventBus();
  const approvals = new ApprovalManager({ onChange: () => bus.emit({ type: "approvals_changed" }) });
  const policy = new ToolPolicy({ workspace: dir, overrides: {} });
  const tools = createCoreTools({ workspace: dir, bashEnvPassthrough: [] });
  sessions = new SessionManager({
    paths,
    bus,
    openSession: (key, transcriptPath, windowLabel) =>
      Session.open({
        key,
        transcriptPath,
        model: faux.getModel(),
        tools,
        streamFn: fauxStreamFn(faux),
        getApiKey: () => "k",
        buildSystemPrompt: async () => "SYSTEM",
        beforeToolCall: createToolGate({ policy, approvals, sessionKey: key, windowLabel }),
        emit: (event) => bus.emit({ type: "session", sessionKey: key, event }),
      }),
  });
  await sessions.init();
  gateway = new Gateway({
    host: "127.0.0.1",
    port: 0,
    auth: new WebAuth(opts.token),
    sessions,
    approvals,
    bus,
    config: { read: () => readFile(paths.config, "utf8"), save: (text) => saveConfigText(paths, text) },
    staticDir,
    log: pino({ level: "silent" }),
  });
  const { port } = await gateway.start();
  return `127.0.0.1:${port}`;
}

async function connect(host: string, options: { cookie?: string; origin?: string; host?: string } = {}): Promise<TestClient> {
  const client = await TestClient.connect(`ws://${host}/ws`, options);
  clients.push(client);
  return client;
}

const isType = <T extends ServerMessage["type"]>(type: T) => (m: ServerMessage): m is Extract<ServerMessage, { type: T }> => m.type === type;

function requestWithHost(host: string, path: string, options: { method?: string; body?: string; headers?: Record<string, string> } = {}): Promise<number> {
  const port = Number(host.slice(host.lastIndexOf(":") + 1));
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: "127.0.0.1",
      port,
      path,
      method: options.method ?? "GET",
      headers: { ...options.headers, host: "evil.example" },
    }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

describe("Gateway HTTP", () => {
  it("serves the app without a token", async () => {
    const host = await start();
    const res = await fetch(`http://${host}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>Vex</title>");
    expect((await fetch(`http://${host}/app.js`)).headers.get("content-type")).toContain("javascript");
    expect((await fetch(`http://${host}/nope`)).status).toBe(404);
  });

  it("requires loopback Host headers without a token", async () => {
    const host = await start();
    expect(await requestWithHost(host, "/")).toBe(403);
    expect(await requestWithHost(host, "/api/login", {
      method: "POST",
      body: JSON.stringify({ token: "anything" }),
    })).toBe(403);
    await expect(connect(host, { host: "evil.example" })).rejects.toThrow();
    expect((await fetch(`http://${host}/`)).status).toBe(200);
  });

  it("guards pages and the socket with the token", async () => {
    const host = await start({ token: "secret" });
    const redirect = await fetch(`http://${host}/`, { redirect: "manual" });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("/login");
    expect((await fetch(`http://${host}/login`)).status).toBe(200);
    expect((await fetch(`http://${host}/style.css`)).status).toBe(200);
    expect((await fetch(`http://${host}/app.js`)).status).toBe(401);

    const wrong = await fetch(`http://${host}/api/login`, { method: "POST", body: JSON.stringify({ token: "nope" }) });
    expect(wrong.status).toBe(401);
    expect((await fetch(`http://${host}/api/login`, { method: "POST", body: JSON.stringify({ token: "secret" }) })).status).toBe(429);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const right = await fetch(`http://${host}/api/login`, { method: "POST", body: JSON.stringify({ token: "secret" }) });
    expect(right.status).toBe(204);
    const cookie = right.headers.get("set-cookie")!.split(";")[0]!;

    expect((await fetch(`http://${host}/`, { headers: { cookie } })).status).toBe(200);
    expect(await requestWithHost(host, "/", { headers: { cookie } })).toBe(200);
    await expect(connect(host)).rejects.toThrow();
    const client = await connect(host, { cookie, host: "remote.example" });
    await client.waitFor(isType("sessions"));
  });

  it("allows only one failed login attempt during each lockout window", async () => {
    const host = await start({ token: "secret" });
    const attempts = await Promise.all(Array.from({ length: 5 }, () =>
      fetch(`http://${host}/api/login`, { method: "POST", body: JSON.stringify({ token: "wrong" }) }),
    ));
    expect(attempts.map((response) => response.status).sort()).toEqual([401, 429, 429, 429, 429]);
  });

  it("rejects cross-origin sockets", async () => {
    const host = await start();
    await expect(connect(host, { origin: "http://evil.example" })).rejects.toThrow();
    const client = await connect(host, { origin: `http://${host}` });
    await client.waitFor(isType("sessions"));
  });

  it("does not crash on a malformed WebSocket upgrade URL", async () => {
    const host = await start();
    const socket = new WebSocket(`ws://${host}//`);
    await new Promise<void>((resolve) => {
      socket.once("error", () => resolve());
      socket.once("close", () => resolve());
      socket.once("unexpected-response", (_request, response) => {
        response.resume();
        resolve();
      });
    });
    expect((await fetch(`http://${host}/`)).status).toBe(200);
  });

  it("closes WebSocket clients that exceed the 4 MiB payload limit", async () => {
    const host = await start();
    const client = await connect(host);
    const closed = new Promise<number>((resolve) => client.onceClose(resolve));
    client.sendRaw("x".repeat(4 * 1024 * 1024 + 1));
    expect(await closed).toBe(1009);
  });
});

describe("Gateway chat", () => {
  it("creates a session and streams a conversation", async () => {
    const host = await start({ responses: [fauxAssistantMessage("你好呀")] });
    const client = await connect(host);
    await client.waitFor(isType("sessions"));
    await client.waitFor(isType("approvals"));

    client.send({ type: "create_session" });
    const created = await client.waitFor(isType("session_created"));
    if (created.type !== "session_created") throw new Error("unreachable");
    const sessionId = created.session.id;

    client.send({ type: "open", sessionId });
    await client.waitFor((m) => m.type === "history" && m.sessionId === sessionId && m.items.length === 0 && !m.busy);

    client.send({ type: "send", sessionId, text: "你好" });
    await client.waitFor((m) => m.type === "event" && m.event.kind === "user_message" && m.event.text === "你好");
    await client.waitFor((m) => m.type === "event" && m.event.kind === "text_delta");
    await client.waitFor((m) => m.type === "event" && m.event.kind === "assistant_message" && m.event.text === "你好呀");
    await client.waitFor((m) => m.type === "event" && m.event.kind === "busy" && !m.event.busy);

    const other = await connect(host);
    other.send({ type: "open", sessionId });
    await other.waitFor((m) => m.type === "history" && m.items.map((i) => i.kind).join(",") === "user,assistant");
  });

  it("routes approvals through the socket", async () => {
    const host = await start({
      responses: [
        fauxAssistantMessage(fauxToolCall("bash", { command: "echo hi" }, { id: "c1" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("跑完了"),
      ],
    });
    const client = await connect(host);
    client.send({ type: "create_session" });
    const created = await client.waitFor(isType("session_created"));
    if (created.type !== "session_created") throw new Error("unreachable");
    client.send({ type: "send", sessionId: created.session.id, text: "跑一下" });

    const asked = await client.waitFor((m) => m.type === "approvals" && m.pending.length === 1);
    if (asked.type !== "approvals") throw new Error("unreachable");
    expect(asked.pending[0]).toMatchObject({ toolName: "bash", summary: "echo hi", windowLabel: "网页会话「新对话」" });

    client.send({ type: "approve", id: asked.pending[0]!.id, answer: "allow" });
    await client.waitFor((m) => m.type === "event" && m.event.kind === "tool_end" && !m.event.isError);
    await client.waitFor((m) => m.type === "event" && m.event.kind === "assistant_message" && m.event.text === "跑完了");
    expect(client.messages.filter(isType("approvals")).at(-1)?.pending).toEqual([]);
  });

  it("reads and validates the config", async () => {
    const host = await start();
    await writeFile(paths.config, "model: { provider: deepseek, id: deepseek-v4-pro }\n", "utf8");
    const client = await connect(host);
    client.send({ type: "get_config" });
    await client.waitFor((m) => m.type === "config" && m.text.includes("deepseek-v4-pro"));

    client.send({ type: "save_config", text: "model: 1\n" });
    await client.waitFor((m) => m.type === "config_saved" && !m.ok && /校验失败/.test(m.error ?? ""));

    client.send({ type: "save_config", text: "model: { provider: deepseek, id: deepseek-flash }\n" });
    await client.waitFor((m) => m.type === "config_saved" && m.ok);
    expect(await readFile(paths.config, "utf8")).toContain("deepseek-flash");
  });

  it("reports bad requests", async () => {
    const host = await start();
    const client = await connect(host);
    client.send({ type: "open", sessionId: "missing" });
    await client.waitFor((m) => m.type === "error" && m.message.includes("没有这个会话"));
  });
});
