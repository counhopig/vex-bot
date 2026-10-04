import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type FauxProviderHandle } from "@earendil-works/pi-ai";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VexConfig } from "../src/config/schema.js";
import { startDaemon, type Daemon } from "../src/daemon.js";
import { createLogger } from "../src/logger.js";
import { resolvePaths, type VexPaths } from "../src/paths.js";
import { createModelRegistry } from "../src/providers/models.js";
import { TestClient } from "./helpers/client.js";
import { createFaux, fauxModels } from "./helpers/faux.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

let dir: string;
let paths: VexPaths;
let faux: FauxProviderHandle;
let daemon: Daemon | undefined;
let client: TestClient | undefined;
let lines: Record<string, unknown>[];

beforeEach(async () => {
  dir = await makeTmpDir();
  paths = resolvePaths(dir);
  faux = createFaux();
  lines = [];
});
afterEach(async () => {
  client?.close();
  await daemon?.stop();
  daemon = undefined;
  await removeTmpDir(dir);
});

const capture = () => pino({ level: "debug" }, { write: (line: string) => { lines.push(JSON.parse(line)); } });
const messages = () => lines.map((line) => line.msg);

function config(): VexConfig {
  return {
    model: { provider: faux.getModel().provider, id: faux.getModel().id },
    backgroundModel: { provider: faux.getModel().provider, id: faux.getModel().id },
    providers: {},
    web: { host: "127.0.0.1", port: 0 },
    workspace: join(dir, "workspace"),
    toolPolicy: {},
    bashEnvPassthrough: [],
    wechat: { enabled: false, baseUrl: "http://127.0.0.1:1" },
    stt: { baseUrl: "https://stt.example/v1", model: "whisper-1", apiKey: "stt-secret" },
  };
}

async function start() {
  daemon = await startDaemon({ paths, config: config(), log: capture(), models: createModelRegistry({}, fauxModels(faux)) });
  client = await TestClient.connect(`ws://127.0.0.1:${daemon.port}/ws`);
}

describe("daemon logging", () => {
  it("summarises the configuration on start without any secrets", async () => {
    await start();
    const started = lines.find((line) => line.msg === "vexd started")!;
    expect(started).toMatchObject({ wechat: false, mcpServers: 0, speechToText: true, heartbeat: "30m" });
    expect(String(started.model)).toContain("faux");
    expect(JSON.stringify(lines)).not.toContain("stt-secret");
  });

  it("logs each run, tool call and reply with sizes but never the message text", async () => {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("feel", { mood: 5, reason: "开心" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("好的，记下了"),
      fauxAssistantMessage("标题"),
    ]);
    await start();
    client!.send({ type: "create_session" });
    const created = await client!.waitFor((m) => m.type === "session_created");
    if (created.type !== "session_created") throw new Error("unreachable");
    client!.send({ type: "send", sessionId: created.session.id, text: "私密内容不要出现在日志里" });
    await client!.waitFor((m) => m.type === "event" && m.event.kind === "busy" && !m.event.busy);
    expect(messages()).toEqual(expect.arrayContaining(["webchat connected", "message received", "run started", "tool call", "reply", "run finished"]));
    expect(lines.find((line) => line.msg === "message received")).toMatchObject({ chars: 12 });
    expect(lines.find((line) => line.msg === "tool call")).toMatchObject({ tool: "feel" });
    expect(lines.find((line) => line.msg === "run finished")).toMatchObject({ ms: expect.any(Number) });
    expect(JSON.stringify(lines)).not.toContain("私密内容");
    expect(JSON.stringify(lines)).not.toContain("记下了");
  });

  it("logs which settings were saved, by key only", async () => {
    await writeFile(paths.config, `model: { provider: ${faux.getModel().provider}, id: ${faux.getModel().id} }\n`, "utf8");
    await start();
    client!.send({ type: "save_settings", set: { "stt.baseUrl": "https://s/v1", "stt.model": "m", "stt.apiKey": "very-secret-key" } });
    await client!.waitFor((m) => m.type === "settings_saved");
    const saved = lines.find((line) => line.msg === "configuration saved")!;
    expect(saved.keys).toEqual(["stt.baseUrl", "stt.model", "stt.apiKey"]);
    expect(JSON.stringify(lines)).not.toContain("very-secret-key");
  });

  it("logs approval requests and answers", async () => {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "echo hi" }, { id: "c1" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("完成"),
      fauxAssistantMessage("标题"),
    ]);
    await start();
    client!.send({ type: "create_session" });
    const created = await client!.waitFor((m) => m.type === "session_created");
    if (created.type !== "session_created") throw new Error("unreachable");
    client!.send({ type: "send", sessionId: created.session.id, text: "运行" });
    const asked = await client!.waitFor((m) => m.type === "approvals" && m.pending.length > 0);
    if (asked.type !== "approvals") throw new Error("unreachable");
    client!.send({ type: "approve", id: asked.pending[0]!.id, answer: "deny" });
    await client!.waitFor((m) => m.type === "event" && m.event.kind === "busy" && !m.event.busy);
    expect(messages()).toEqual(expect.arrayContaining(["approval requested", "approval denied"]));
  });
});

describe("log level", () => {
  it("defaults to info and follows VEX_LOG_LEVEL", () => {
    delete process.env.VEX_LOG_LEVEL;
    expect(createLogger({ stdout: true }).level).toBe("info");
    process.env.VEX_LOG_LEVEL = "debug";
    expect(createLogger({ stdout: true }).level).toBe("debug");
    process.env.VEX_LOG_LEVEL = "nonsense";
    expect(createLogger({ stdout: true }).level).toBe("info");
    delete process.env.VEX_LOG_LEVEL;
  });
});
