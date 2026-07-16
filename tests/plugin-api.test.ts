/**
 * Plugin API contract tests — activate() must receive the same real config
 * as register(), services registered during activate() must be started, and
 * discovery must skip .ts entries on runtimes that cannot import TypeScript.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { VexConfig } from "../src/types/index.js";

vi.mock("../src/utils/logger.js", () => ({
  getChildLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("../src/tools/registry.js", () => ({
  registerTool: vi.fn(),
  registerTools: vi.fn(),
}));

vi.mock("../src/hooks/index.js", () => ({
  registerHook: vi.fn(() => () => {}),
}));

async function getPluginModule() {
  return await import("../src/plugins/index.js");
}

describe("plugin api contract", () => {
  let pluginModule: Awaited<ReturnType<typeof getPluginModule>>;

  beforeEach(async () => {
    vi.resetModules();
    pluginModule = await getPluginModule();
  });

  afterEach(async () => {
    await pluginModule.unregisterAllPlugins();
  });

  it("activate() receives the same real config object as register()", async () => {
    const config = { agent: { defaultModel: "marker-model" } } as unknown as VexConfig;
    let registerConfig: unknown;
    let activateConfig: unknown;

    await pluginModule.registerPlugin(
      {
        meta: { id: "cfg-plugin", name: "Cfg", version: "1.0.0" },
        register: (api) => { registerConfig = api.config; },
        activate: (api) => { activateConfig = api.config; },
      },
      config,
    );
    await pluginModule.activatePlugin("cfg-plugin");

    expect(registerConfig).toBe(config);
    expect(activateConfig).toBe(config);
  });

  it("a service registered during activate() gets started", async () => {
    const start = vi.fn();
    await pluginModule.registerPlugin(
      {
        meta: { id: "svc-plugin", name: "Svc", version: "1.0.0" },
        activate: (api) => {
          api.registerService?.({ id: "late-svc", start, stop: vi.fn() });
        },
      },
      {} as VexConfig,
    );
    await pluginModule.activatePlugin("svc-plugin");

    expect(start).toHaveBeenCalledTimes(1);
  });

  it("unregisterPlugin stops services in reverse order without mutating the list", async () => {
    const order: string[] = [];
    let servicesRef: unknown;
    await pluginModule.registerPlugin(
      {
        meta: { id: "rev-plugin", name: "Rev", version: "1.0.0" },
        register: (api) => {
          api.registerService?.({ id: "s1", start: vi.fn(), stop: () => { order.push("s1"); } });
          api.registerService?.({ id: "s2", start: vi.fn(), stop: () => { order.push("s2"); } });
        },
      },
      {} as VexConfig,
    );
    servicesRef = pluginModule.getPluginDetails("rev-plugin")?.services;
    await pluginModule.unregisterPlugin("rev-plugin");

    expect(order).toEqual(["s2", "s1"]);
    expect((servicesRef as Array<{ id: string }>).map((s) => s.id)).toEqual(["s1", "s2"]);
  });
});

describe("plugin discovery ts gating", () => {
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vex-plugin-disc-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("skips .ts entries when the runtime cannot import TypeScript", async () => {
    writeFileSync(join(dir, "tsonly.ts"), "export default () => {};\n");
    writeFileSync(join(dir, "jsok.js"), "export default () => {};\n");
    const tsDirPlugin = join(dir, "tsdir");
    mkdirSync(tsDirPlugin);
    writeFileSync(join(tsDirPlugin, "index.ts"), "export default () => {};\n");

    const { discoverPlugins } = await import("../src/plugins/discovery.js");
    const candidates = await discoverPlugins({
      paths: [dir],
      includeBuiltin: false,
      includeGlobal: false,
      includeWorkspace: false,
      allowTsEntries: false,
    });

    expect(candidates.map((c) => c.id)).toEqual(["jsok"]);
  });

  it("keeps .ts entries when TS imports are allowed", async () => {
    writeFileSync(join(dir, "tsonly.ts"), "export default () => {};\n");

    const { discoverPlugins } = await import("../src/plugins/discovery.js");
    const candidates = await discoverPlugins({
      paths: [dir],
      includeBuiltin: false,
      includeGlobal: false,
      includeWorkspace: false,
      allowTsEntries: true,
    });

    expect(candidates.map((c) => c.id)).toEqual(["tsonly"]);
  });
});
