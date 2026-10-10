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
  // A failed fake-timer test must not leave later tests waiting on a frozen clock.
  vi.useRealTimers();
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
    expect(toolNames).toEqual(["read", "write", "edit", "grep", "find", "memory_search", "feel", "web_fetch", "web_search", "schedule", "delegate", "request_action_outcome"]);
  });

  it("offers the notes vault tools and prompt only when a vault is configured", async () => {
    await mkdir(join(dir, "notes"), { recursive: true });
    await writeFile(join(dir, "notes", "Idea.md"), "# Idea\nTry a weekly review\n");
    let toolNames: string[] = [];
    let systemPrompt = "";
    faux.setResponses([
      (ctx) => {
        toolNames = getCurrentTools(ctx.messages).map((t) => t.name);
        systemPrompt = getCurrentSystemPrompt(ctx.messages);
        return fauxAssistantMessage("ok");
      },
      fauxAssistantMessage("标题"),
    ]);
    daemon = await startDaemon({ paths, config: config({ toolPolicy: { bash: "deny" }, vault: { path: join(dir, "notes") } }), log: createLogger(), models: models() });
    await chat("hi");
    expect(toolNames).toEqual(["read", "write", "edit", "grep", "find", "memory_search", "feel", "web_fetch", "web_search", "vault_search", "vault_read", "schedule", "delegate", "request_action_outcome"]);
    expect(systemPrompt).toContain("## Notes vault");
  });

  it("does not mention the notes vault without configuration", async () => {
    let toolNames: string[] = [];
    let systemPrompt = "";
    faux.setResponses([
      (ctx) => {
        toolNames = getCurrentTools(ctx.messages).map((t) => t.name);
        systemPrompt = getCurrentSystemPrompt(ctx.messages);
        return fauxAssistantMessage("ok");
      },
      fauxAssistantMessage("标题"),
    ]);
    daemon = await startDaemon({ paths, config: config(), log: createLogger(), models: models() });
    await chat("hi");
    expect(toolNames).not.toContain("vault_search");
    expect(systemPrompt).not.toContain("Notes vault");
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
    faux.setResponses([(ctx) => { prompt = getCurrentSystemPrompt(ctx.messages); return fauxAssistantMessage("second reply"); }]);
    client!.send({ type: "send", sessionId: id, text: "again" });
    await client!.waitFor(m => m.type === "event" && m.event.kind === "assistant_message" && m.event.text === "second reply");
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
    let heartbeatPrompt = "";
    let heartbeatTools: string[] = [];
    faux.setResponses([(ctx) => { calls++; heartbeatPrompt = getCurrentSystemPrompt(ctx.messages); heartbeatTools = getCurrentTools(ctx.messages).map((tool) => tool.name); expect(heartbeatPrompt).toContain("Window: heartbeat"); return fauxAssistantMessage("检查完成，需要注意"); }]);
    daemon = await startDaemon({ paths, config: config({ heartbeat: { every: "1s", activeHours: ["00:00", "00:00"] } }), log: createLogger(), models: models() });
    await new Promise(resolve => setTimeout(resolve, 1400));
    await daemon.stop(); daemon = undefined;
    const history = await readFile(join(paths.sessions, "wechat.jsonl"), "utf8");
    expect(history).toContain("检查完成，需要注意");
    expect(history).not.toContain("HEARTBEAT.md");
    expect(calls).toBe(1);
    expect(heartbeatPrompt).toContain("## Available tools");
    expect(heartbeatTools).not.toContain("wiki_ingest");
    const mood = JSON.parse(await readFile(join(paths.home, "state", "mood.json"), "utf8"));
    expect(mood.social).toBeCloseTo(50, 1);
  });

  it("builds the consolidation profile prompt and workspace-only toolset in the assembled daemon", async () => {
    vi.useFakeTimers();
    // Consolidation fires at 03:00 local time, so the clock must be local too.
    vi.setSystemTime(new Date(2026, 9, 11, 2, 59, 59));
    let prompt = "";
    let tools: string[] = [];
    let task = "";
    faux.setResponses([(ctx) => { prompt = getCurrentSystemPrompt(ctx.messages); tools = getCurrentTools(ctx.messages).map((tool) => tool.name); task = String(ctx.messages.filter((message) => message.role === "user").at(-1)?.content ?? ""); return fauxAssistantMessage("Consolidation complete."); }]);
    daemon = await startDaemon({ paths, config: config({ memory: { consolidateAt: "03:00" } }), log: createLogger(), models: models() });
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.waitFor(() => expect(prompt).toContain("Window: memory consolidation"));
    expect(task).toContain("Distil what recurs or is clearly important");
    expect(tools).toEqual(expect.arrayContaining(["read", "write", "edit", "grep", "find", "memory_search"]));
    expect(tools).not.toContain("wiki_ingest");
    await daemon.stop(); daemon = undefined;
    vi.useRealTimers();
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
    let running: VexConfig;
    async function startWithRestart(restart: () => Promise<void>) {
      await writeFile(paths.config, `# mine\nmodel: { provider: ${faux.getModel().provider}, id: ${faux.getModel().id} }\n`, "utf8");
      running = config();
      daemon = await startDaemon({ paths, config: running, log: createLogger(), models: models(), restart });
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
      // The running daemon reads these per call, so the saved values must reach it.
      expect(running.stt).toEqual({ baseUrl: "https://s/v1", model: "m" });
      client!.messages.length = 0;
      client!.send({ type: "save_settings", set: { "links.bilibili.sessdata": "fresh" }, unset: ["stt.baseUrl", "stt.model"] });
      expect(await saved()).toMatchObject({ ok: true, restartRequired: false });
      expect(running.links).toEqual({ bilibili: { sessdata: "fresh" } });
      expect(running.stt).toBeUndefined();
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

  it("lists, opens and saves the daily notes", async () => {
    daemon = await startDaemon({ paths, config: config(), log: createLogger(), models: models() });
    await writeFile(join(dir, "workspace", "memory", "2026-10-04.md"), "older");
    await writeFile(join(dir, "workspace", "memory", "2026-10-05.md"), "# 2026-10-05\n- deploy cmp");
    client = await TestClient.connect(`ws://127.0.0.1:${daemon.port}/ws`);
    client.send({ type: "list_notes" });
    expect(await client.waitFor((m) => m.type === "notes")).toEqual({ type: "notes", names: ["memory/2026-10-05.md", "memory/2026-10-04.md"] });
    client.send({ type: "get_file", name: "memory/2026-10-05.md" });
    expect(await client.waitFor((m) => m.type === "file")).toEqual({ type: "file", name: "memory/2026-10-05.md", text: "# 2026-10-05\n- deploy cmp" });
    client.send({ type: "save_file", name: "memory/2026-10-05.md", text: "- deploy cmp on Friday" });
    await client.waitFor((m) => m.type === "file_saved" && m.ok);
    expect(await readFile(join(dir, "workspace", "memory", "2026-10-05.md"), "utf8")).toBe("- deploy cmp on Friday");
  });

  it("refuses to overwrite a workspace file that changed after the editor loaded it", async () => {
    daemon = await startDaemon({ paths, config: config(), log: createLogger(), models: models() });
    const note = join(dir, "workspace", "memory", "2026-10-05.md");
    await writeFile(note, "loaded");
    client = await TestClient.connect(`ws://127.0.0.1:${daemon.port}/ws`);
    await writeFile(note, "loaded\n- added by the assistant");
    client.send({ type: "save_file", name: "memory/2026-10-05.md", text: "owner edit", base: "loaded" });
    expect(await client.waitFor((m) => m.type === "file_saved")).toMatchObject({ ok: false, error: expect.stringContaining("changed after it was opened") });
    expect(await readFile(note, "utf8")).toBe("loaded\n- added by the assistant");
    client.messages.length = 0;
    client.send({ type: "save_file", name: "memory/2026-10-05.md", text: "owner edit", base: "loaded\n- added by the assistant" });
    expect(await client.waitFor((m) => m.type === "file_saved")).toMatchObject({ ok: true });
    expect(await readFile(note, "utf8")).toBe("owner edit");
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
