import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, getCurrentSystemPrompt, getCurrentTools, type FauxProviderHandle } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VexConfig } from "../src/config/schema.js";
import { startDaemon, type Daemon } from "../src/daemon.js";
import { createLogger } from "../src/logger.js";
import { resolvePaths, type VexPaths } from "../src/paths.js";
import { createModelRegistry, type ModelRegistry } from "../src/providers/models.js";
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
    expect(systemPrompt).toContain("窗口：网页会话「新对话」");
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
    expect(toolNames).toEqual(["read", "write", "edit", "grep", "find"]);
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
