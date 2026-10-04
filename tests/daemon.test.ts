import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt, getCurrentTools, type FauxProviderHandle } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VexConfig } from "../src/config/schema.js";
import { startDaemon, type Daemon } from "../src/daemon.js";
import { createLogger } from "../src/logger.js";
import { resolvePaths, type VexPaths } from "../src/paths.js";
import { createModelRegistry, type ModelRegistry } from "../src/providers/models.js";
import type { ServerMessage } from "../src/protocol/messages.js";
import { TestClient } from "./helpers/client.js";
import { createFaux, fauxModels } from "./helpers/faux.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

let dir: string;
let paths: VexPaths;
let faux: FauxProviderHandle;
let daemon: Daemon | undefined;
let client: TestClient | undefined;

beforeEach(async () => {
  dir = await makeTmpDir();
  paths = resolvePaths(dir);
  faux = createFaux();
});
afterEach(async () => {
  client?.close();
  client = undefined;
  await daemon?.stop();
  daemon = undefined;
  await removeTmpDir(dir);
});

function config(overrides: Partial<VexConfig> = {}): VexConfig {
  return {
    model: { provider: faux.getModel().provider, id: faux.getModel().id },
    backgroundModel: { provider: faux.getModel().provider, id: faux.getModel().id },
    providers: {},
    web: { host: "127.0.0.1", port: 0 },
    workspace: join(dir, "workspace"),
    toolPolicy: {},
    bashEnvPassthrough: [],
    wechat: { enabled: false, baseUrl: "http://127.0.0.1:1" },
    ...overrides,
  };
}

function models(): ModelRegistry {
  return createModelRegistry({}, fauxModels(faux));
}

async function chat(text: string): Promise<string> {
  client = await TestClient.connect(`ws://127.0.0.1:${daemon!.port}/ws`);
  client.send({ type: "create_session" });
  const created = await client.waitFor((m) => m.type === "session_created");
  if (created.type !== "session_created") throw new Error("unreachable");
  client.send({ type: "send", sessionId: created.session.id, text });
  await client.waitFor((m) => m.type === "event" && m.event.kind === "busy" && !m.event.busy);
  // Title generation runs in the background; let it land before the test tears down.
  await client.waitFor((m) => m.type === "sessions" && m.sessions.some((x) => x.titled));
  return created.session.id;
}

describe("startDaemon", () => {
  it("serves a working chat with the workspace in the system prompt", async () => {
    let systemPrompt = "";
    faux.setResponses([
      (ctx) => {
        systemPrompt = getCurrentSystemPrompt(ctx.messages);
        return fauxAssistantMessage("在的");
      },
      fauxAssistantMessage("标题"),
    ]);
    daemon = await startDaemon({ paths, config: config(), log: createLogger(), models: models() });
    expect(daemon.url).toBe(`http://127.0.0.1:${daemon.port}`);
    await chat("在吗");

    expect((await stat(join(dir, "workspace", "SOUL.md"))).isFile()).toBe(true);
    expect(systemPrompt).toContain(join(dir, "workspace"));
    expect(systemPrompt).toContain("## SOUL.md");
    expect(systemPrompt).toContain('Window: WebChat conversation "New chat"');
    expect(client!.messages.some((m) => m.type === "event" && m.event.kind === "assistant_message" && m.event.text === "在的")).toBe(true);
  });

  it("restores conversations after a restart", async () => {
    faux.setResponses([fauxAssistantMessage("记住了"), fauxAssistantMessage("标题")]);
    daemon = await startDaemon({ paths, config: config(), log: createLogger(), models: models() });
    const sessionId = await chat("我叫小王");
    client!.close();
    await daemon.stop();

    daemon = await startDaemon({ paths, config: config(), log: createLogger(), models: models() });
    client = await TestClient.connect(`ws://127.0.0.1:${daemon.port}/ws`);
    client.send({ type: "open", sessionId });
    const history = await client.waitFor((m) => m.type === "history");
    if (history.type !== "history") throw new Error("unreachable");
    expect(history.items).toMatchObject([
      { kind: "user", text: "我叫小王" },
      { kind: "assistant", text: "记住了" },
    ]);
  });

  it("hides denied tools from the model", async () => {
    let toolNames: string[] = [];
    faux.setResponses([
      (ctx) => {
        toolNames = getCurrentTools(ctx.messages).map((t) => t.name);
        return fauxAssistantMessage("ok");
      },
      fauxAssistantMessage("标题"),
    ]);
    daemon = await startDaemon({ paths, config: config({ toolPolicy: { bash: "deny" } }), log: createLogger(), models: models() });
    await chat("hi");
    expect(toolNames).toEqual(["read", "write", "edit", "grep", "find", "memory_search", "feel", "web_fetch", "web_search", "schedule", "delegate"]);
  });

  it("loads persona and dynamic skills in order and settles only successful owner interaction", async () => {
    const workspace = join(dir, "workspace");
    await mkdir(join(workspace, "skills", "custom"), { recursive: true });
    await writeFile(join(workspace, "skills", "custom", "SKILL.md"), "---\nname: custom\ndescription: Custom test skill\n---\nFull secret body\n");
    let prompt = "";
    faux.setResponses([(ctx) => { prompt = getCurrentSystemPrompt(ctx.messages); return fauxAssistantMessage("ok"); }, fauxAssistantMessage("标题")]);
    daemon = await startDaemon({ paths, config: config(), log: createLogger(), models: models() });
    const id = await chat("hi");
    expect(prompt).toContain("Custom test skill");
    expect(prompt).not.toContain("Full secret body");
    expect(prompt.indexOf("## USER.md")).toBeLessThan(prompt.indexOf("## Mood and rest hours"));
    expect(prompt.indexOf("## Mood and rest hours")).toBeLessThan(prompt.indexOf("## MEMORY.md"));
    expect(prompt.indexOf("## MEMORY.md")).toBeLessThan(prompt.indexOf("Custom test skill"));
    const mood = JSON.parse(await readFile(join(paths.home, "state", "mood.json"), "utf8"));
    expect(mood.social).toBeCloseTo(35, 1);
    await writeFile(join(workspace, "skills", "custom", "SKILL.md"), "---\nname: custom\ndescription: Changed skill\n---\nBody\n");
    faux.setResponses([(ctx) => { prompt = getCurrentSystemPrompt(ctx.messages); return fauxAssistantMessage("updated"); }]);
    client!.send({ type: "send", sessionId: id, text: "again" });
    await client!.waitFor(m => m.type === "event" && m.event.kind === "assistant_message" && m.event.text === "updated");
    expect(prompt).toContain("Changed skill");
  });

  it("binds schedule to the calling web session and marks delivery without owner settlement", async () => {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("schedule", { action: "create", name: "test", schedule: { once: new Date(Date.now() + 1700).toISOString() }, prompt: "scheduled hello" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("created"), fauxAssistantMessage("标题"), fauxAssistantMessage("scheduled reply"),
    ]);
    daemon = await startDaemon({ paths, config: config(), log: createLogger(), models: models() });
    const id = await chat("schedule it");
    const tasks = JSON.parse(await readFile(join(paths.home, "schedules.json"), "utf8"));
    expect(tasks[0].target).toBe(id);
    const notification = await client!.waitFor(m => m.type === "event" && m.event.kind === "user_message" && m.event.source === "scheduled task");
    expect(notification).toMatchObject({ sessionId: id, event: { text: "[Scheduled task \"test\"] scheduled hello" } });
    await client!.waitFor(m => m.type === "event" && m.event.kind === "assistant_message" && m.event.text === "scheduled reply");
    await daemon.stop(); daemon = undefined;
    const mood = JSON.parse(await readFile(join(paths.home, "state", "mood.json"), "utf8"));
    expect(mood.social).toBeCloseTo(35, 1);
  });

  it("runs heartbeat silently in an isolated background transcript and injects its result without another model call", async () => {
    const workspace = join(dir, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "HEARTBEAT.md"), "Check something");
    let calls = 0;
    faux.setResponses([(ctx) => { calls++; expect(getCurrentSystemPrompt(ctx.messages)).toContain("Window: heartbeat"); return fauxAssistantMessage("检查完成，需要注意"); }]);
    daemon = await startDaemon({ paths, config: config({ heartbeat: { every: "1s", activeHours: ["00:00", "00:00"] } }), log: createLogger(), models: models() });
    await new Promise(resolve => setTimeout(resolve, 1400));
    await daemon.stop(); daemon = undefined;
    const history = await readFile(join(paths.sessions, "wechat.jsonl"), "utf8");
    expect(history).toContain("检查完成，需要注意");
    expect(history).not.toContain("HEARTBEAT.md");
    expect(calls).toBe(1);
    const mood = JSON.parse(await readFile(join(paths.home, "state", "mood.json"), "utf8"));
    expect(mood.social).toBeCloseTo(50, 1);
  });

  it("wires feel without approval and persists its temporary emotion", async () => {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("feel", { mood: 10, reason: "开心" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("ok"), fauxAssistantMessage("标题"),
    ]);
    daemon = await startDaemon({ paths, config: config(), log: createLogger(), models: models() });
    await chat("记录情绪");
    const mood = JSON.parse(await readFile(join(paths.home, "state", "mood.json"), "utf8"));
    expect(mood.feelings).toHaveLength(1);
    expect(mood.feelings[0]).toMatchObject({ mood: 10, reason: "开心" });
    expect(client!.messages.some(m => m.type === "approvals" && m.pending.length)).toBe(false);
  });

  it("aborts a slow silent heartbeat on shutdown without delivering a partial message", async () => {
    const workspace = join(dir, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "HEARTBEAT.md"), "Check something");
    faux = createFaux(1);
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    faux.setResponses([() => { started(); return fauxAssistantMessage("a very long heartbeat that should never finish"); }]);
    daemon = await startDaemon({ paths, config: config({ heartbeat: { every: "1s", activeHours: ["00:00", "00:00"] } }), log: createLogger(), models: models() });
    await ready;
    await daemon.stop(); daemon = undefined;
    await expect(readFile(join(paths.sessions, "wechat.jsonl"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(join(paths.sessions, "runs"))).toEqual([]);
  });

  it("starts with no tasks when the schedule file is corrupt and keeps the bad file", async () => {
    await writeFile(join(paths.home, "schedules.json"), "not JSON");
    daemon = await startDaemon({ paths, config: config(), log: createLogger(), models: models() });
    expect((await readdir(paths.home)).some(name => name.startsWith("schedules.json.bad-"))).toBe(true);
  });

  describe("applying saved settings", () => {
    async function startWithRestart(restart: () => Promise<void>) {
      await writeFile(paths.config, `# mine\nmodel: { provider: ${faux.getModel().provider}, id: ${faux.getModel().id} }\n`, "utf8");
      daemon = await startDaemon({ paths, config: config(), log: createLogger(), models: models(), restart });
      client = await TestClient.connect(`ws://127.0.0.1:${daemon.port}/ws`);
    }
    const saved = () => client!.waitFor((m) => m.type === "settings_saved");

    it("restarts in place after a setting that needs it, remembering how to roll back", async () => {
      const restart = vi.fn(async () => {});
      await startWithRestart(restart);
      client!.send({ type: "save_settings", set: { "heartbeat.every": "45m" } });
      expect(await saved()).toMatchObject({ ok: true, restartRequired: true, restarting: true });
      await vi.waitFor(() => expect(restart).toHaveBeenCalledTimes(1), { timeout: 3000 });
      expect(await readFile(paths.config, "utf8")).toContain("heartbeat");
      const pending = JSON.parse(await readFile(join(paths.home, "state", "pending-reload.json"), "utf8"));
      expect(pending.previous).toContain("# mine");
      expect(pending.previous).not.toContain("heartbeat");
    });

    it("does not restart for settings the skills read on every run", async () => {
      const restart = vi.fn(async () => {});
      await startWithRestart(restart);
      client!.send({ type: "save_settings", set: { "stt.baseUrl": "https://s/v1", "stt.model": "m" } });
      expect(await saved()).toMatchObject({ ok: true, restartRequired: false });
      await new Promise((resolve) => setTimeout(resolve, 900));
      expect(restart).not.toHaveBeenCalled();
    });

    it("refuses a model that cannot be used and leaves the configuration alone", async () => {
      const restart = vi.fn(async () => {});
      await startWithRestart(restart);
      const before = await readFile(paths.config, "utf8");
      client!.send({ type: "save_settings", set: { "model.provider": "nonexistent", "model.id": "x" } });
      expect(await saved()).toMatchObject({ ok: false, error: expect.stringContaining("The model cannot be used") });
      expect(await readFile(paths.config, "utf8")).toBe(before);
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(restart).not.toHaveBeenCalled();
    });

    it("saves the raw configuration and restarts only when its text changed", async () => {
      const restart = vi.fn(async () => {});
      await startWithRestart(restart);
      const text = await readFile(paths.config, "utf8");
      client!.send({ type: "save_config", text });
      expect(await client!.waitFor((m) => m.type === "config_saved")).toMatchObject({ ok: true, restarting: false });
      client!.send({ type: "save_config", text: `${text}wechat: { enabled: false }\n` });
      expect(await client!.waitFor((m) => m.type === "config_saved" && m.restarting === true)).toBeTruthy();
      await vi.waitFor(() => expect(restart).toHaveBeenCalledTimes(1), { timeout: 3000 });
    });

    it("only reports that a restart is needed when the host cannot restart itself", async () => {
      await writeFile(paths.config, `model: { provider: ${faux.getModel().provider}, id: ${faux.getModel().id} }\n`, "utf8");
      daemon = await startDaemon({ paths, config: config(), log: createLogger(), models: models() });
      client = await TestClient.connect(`ws://127.0.0.1:${daemon.port}/ws`);
      client.send({ type: "save_settings", set: { "heartbeat.every": "45m" } });
      expect(await saved()).toMatchObject({ ok: true, restartRequired: true, restarting: false });
    });

    it("shows why the previous configuration was restored", async () => {
      await mkdir(join(paths.home, "state"), { recursive: true });
      await writeFile(join(paths.home, "state", "reload-error.json"), JSON.stringify({ message: "port busy", at: 1 }));
      await writeFile(paths.config, `model: { provider: ${faux.getModel().provider}, id: ${faux.getModel().id} }\n`, "utf8");
      daemon = await startDaemon({ paths, config: config(), log: createLogger(), models: models() });
      client = await TestClient.connect(`ws://127.0.0.1:${daemon.port}/ws`);
      client.send({ type: "get_status" });
      expect(await client.waitFor((m) => m.type === "status")).toMatchObject({ status: { reloadError: "port busy" } });
      client.send({ type: "save_settings", set: { "stt.baseUrl": "https://s/v1", "stt.model": "m" } });
      expect(await saved()).toMatchObject({ ok: true });
      client.send({ type: "get_status" });
      expect(await client.waitFor((m) => m.type === "status" && m.status.reloadError === undefined)).toBeTruthy();
    });
  });

  it("warns when a saved persona file is longer than the model will see", async () => {
    daemon = await startDaemon({ paths, config: config(), log: createLogger(), models: models() });
    client = await TestClient.connect(`ws://127.0.0.1:${daemon.port}/ws`);
    client.send({ type: "save_file", name: "SOUL.md", text: Array.from({ length: 250 }, (_, index) => `rule ${index}`).join("\n") });
    expect(await client.waitFor((m) => m.type === "file_saved")).toMatchObject({ ok: true, warning: expect.stringContaining("only the first 200") });
    client.send({ type: "save_file", name: "USER.md", text: "short" });
    const saved = await client.waitFor((m) => m.type === "file_saved" && m.name === "USER.md");
    expect(saved).toMatchObject({ ok: true });
    expect("warning" in saved && saved.warning).toBeFalsy();
  });

  it("opens prompt files with their default text and restores it when the text is cleared", async () => {
    daemon = await startDaemon({ paths, config: config(), log: createLogger(), models: models() });
    client = await TestClient.connect(`ws://127.0.0.1:${daemon.port}/ws`);
    client.send({ type: "get_file", name: "prompts/outreach.md" });
    expect(await client.waitFor((m) => m.type === "file" && m.name === "prompts/outreach.md")).toMatchObject({ text: expect.stringContaining("Proactive chat") });
    client.send({ type: "save_file", name: "prompts/outreach.md", text: "Say hello warmly." });
    await client.waitFor((m) => m.type === "file_saved" && m.ok);
    expect(await readFile(join(dir, "workspace", "prompts", "outreach.md"), "utf8")).toBe("Say hello warmly.");
    client.send({ type: "save_file", name: "prompts/outreach.md", text: "" });
    await client.waitFor((m) => m.type === "file_saved" && m.ok);
    client.send({ type: "get_file", name: "prompts/outreach.md" });
    expect(await client.waitFor((m) => m.type === "file" && m.text.includes("Proactive chat") && m.text !== "Say hello warmly.")).toBeTruthy();
  });

  it("lists, creates, updates and deletes scheduled tasks for the settings page", async () => {
    daemon = await startDaemon({ paths, config: config(), log: createLogger(), models: models() });
    client = await TestClient.connect(`ws://127.0.0.1:${daemon.port}/ws`);
    const latest = () => [...client!.messages].reverse().find((m) => m.type === "schedules") as Extract<ServerMessage, { type: "schedules" }>;
    client.send({ type: "get_schedules" });
    await client.waitFor((m) => m.type === "schedules");
    expect(latest().targets[0]).toEqual({ id: "wechat", label: "WeChat" });
    client.send({ type: "save_schedule", name: "news", prompt: "search AI news", target: "wechat", enabled: true, schedule: { cron: "0 9 * * *" } });
    await client.waitFor((m) => m.type === "schedule_saved" && m.ok);
    await vi.waitFor(() => expect(latest().tasks).toHaveLength(1));
    const id = latest().tasks[0]!.id;
    client.send({ type: "save_schedule", id, name: "news", prompt: "search AI news", target: "wechat", enabled: false, schedule: { cron: "0 9 * * *" } });
    await vi.waitFor(() => expect(latest().tasks[0]?.enabled).toBe(false));
    client.send({ type: "save_schedule", name: "bad", prompt: "x", target: "wechat", enabled: true, schedule: { cron: "not a cron" } });
    await client.waitFor((m) => m.type === "schedule_saved" && !m.ok);
    client.send({ type: "delete_schedule", id });
    await vi.waitFor(() => expect(latest().tasks).toEqual([]));
    expect(JSON.parse(await readFile(join(paths.home, "schedules.json"), "utf8"))).toEqual([]);
  });

  it("refuses a public address without a token", async () => {
    await expect(
      startDaemon({ paths, config: config({ web: { host: "0.0.0.0", port: 0 } }), log: createLogger(), models: models() }),
    ).rejects.toThrow(/web.token/);
  });

  it("writes logs to a file", async () => {
    const log = createLogger({ file: paths.logFile });
    daemon = await startDaemon({ paths, config: config(), log, models: models() });
    await daemon.stop();
    daemon = undefined;
    log.flush();
    await new Promise((r) => setTimeout(r, 100));
    expect(await readFile(paths.logFile, "utf8")).toContain("vexd started");
  });
});
