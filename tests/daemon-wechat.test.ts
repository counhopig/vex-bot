import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type FauxProviderHandle } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WeChatStore } from "../src/channels/wechat/store.js";
import type { VexConfig } from "../src/config/schema.js";
import { startDaemon, type Daemon } from "../src/daemon.js";
import { createLogger } from "../src/logger.js";
import { resolvePaths, type VexPaths } from "../src/paths.js";
import { createModelRegistry } from "../src/providers/models.js";
import { createFaux, fauxModels } from "./helpers/faux.js";
import { FakeIlink, textMessage } from "./helpers/ilink.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

let dir: string;
let paths: VexPaths;
let faux: FauxProviderHandle;
let ilink: FakeIlink;
let daemon: Daemon | undefined;

beforeEach(async () => {
  dir = await makeTmpDir();
  paths = resolvePaths(dir);
  faux = createFaux();
  ilink = new FakeIlink();
  await ilink.start();
});
afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  await ilink.stop();
  await removeTmpDir(dir);
});

function config(wechat: Partial<VexConfig["wechat"]> = {}): VexConfig {
  return {
    model: { provider: faux.getModel().provider, id: faux.getModel().id },
    backgroundModel: { provider: faux.getModel().provider, id: faux.getModel().id },
    providers: {},
    web: { host: "127.0.0.1", port: 0 },
    workspace: join(dir, "workspace"),
    toolPolicy: {},
    bashEnvPassthrough: [],
    wechat: { enabled: true, baseUrl: ilink.baseUrl, ...wechat },
  };
}

async function start(cfg: VexConfig): Promise<void> {
  daemon = await startDaemon({ paths, config: cfg, log: createLogger(), models: createModelRegistry({}, fauxModels(faux)) });
}

async function link(userId?: string): Promise<void> {
  await new WeChatStore(paths.wechat).saveCredentials({ token: "tok", accountId: "bot1", baseUrl: ilink.baseUrl, userId });
}

describe("vexd with WeChat", () => {
  it("shuts down while heartbeat delivery waits behind a permanent approval-blocked WeChat run", async () => {
    await link("owner1");
    const cfg = config();
    cfg.heartbeat = { every: "1s", activeHours: ["00:00", "00:00"] };
    await mkdir(cfg.workspace, { recursive: true });
    await writeFile(join(cfg.workspace, "HEARTBEAT.md"), "Check system");
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "date" }, { id: "blocked" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("heartbeat result"),
    ]);
    ilink.queueUpdates(textMessage("owner1", "run date", { message_id: "m1" }));
    await start(cfg);
    await vi.waitFor(() => expect(ilink.sentTexts()[0]).toContain("【需要你批准】"));
    await vi.waitFor(() => expect(faux.getPendingResponseCount()).toBe(0), { timeout: 3000 });
    const started = Date.now();
    await daemon!.stop(); daemon = undefined;
    expect(Date.now() - started).toBeLessThan(1000);
    expect(ilink.sentTexts()).not.toContain("heartbeat result");
  });
  it("answers the owner on WeChat", async () => {
    await link("owner1");
    faux.setResponses([fauxAssistantMessage("在的")]);
    ilink.queueUpdates(textMessage("stranger", "hi", { message_id: "x1" }), textMessage("owner1", "在吗", { message_id: "m1" }));
    await start(config());
    await vi.waitFor(() => expect(ilink.sentTexts()).toEqual(["在的"]), { timeout: 5000 });
    expect(faux.getPendingResponseCount()).toBe(0);
  });

  it("asks for approval on WeChat and runs the tool after /y", async () => {
    await link("owner1");
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "echo hi" }, { id: "c1" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("跑完了"),
    ]);
    ilink.queueUpdates(textMessage("owner1", "跑一下", { message_id: "m1" }));
    await start(config());
    await vi.waitFor(() => expect(ilink.sentTexts()[0]).toContain("【需要你批准】微信想执行 bash：\necho hi"), { timeout: 5000 });
    ilink.queueUpdates(textMessage("owner1", "/y", { message_id: "m2" }));
    await vi.waitFor(() => expect(ilink.sentTexts().slice(1)).toEqual(["已允许：bash", "跑完了"]), { timeout: 5000 });
  });

  it("uses the configured owner over the scanner", async () => {
    await link("scanner");
    faux.setResponses([fauxAssistantMessage("主人好")]);
    ilink.queueUpdates(textMessage("scanner", "我不是主人", { message_id: "m1" }), textMessage("boss", "我是", { message_id: "m2" }));
    await start(config({ ownerId: "boss" }));
    await vi.waitFor(() => expect(ilink.sentTexts()).toEqual(["主人好"]), { timeout: 5000 });
  });

  it("stays off when disabled, unlinked, or without an owner", async () => {
    await start(config({ enabled: false }));
    await daemon!.stop();
    await start(config());
    await daemon!.stop();
    await link(undefined);
    await start(config());
    await new Promise((r) => setTimeout(r, 50));
    expect(ilink.requests).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)("keeps running when wechat credentials are unreadable", async () => {
    await link("owner1");
    const credPath = join(paths.wechat, "credentials.json");
    await chmod(credPath, 0o000);
    await start(config());
    expect(daemon).toBeDefined();
    expect(daemon!.url).toBeDefined();
    expect(daemon!.port).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 50));
    expect(ilink.requests).toEqual([]);
  });
});
