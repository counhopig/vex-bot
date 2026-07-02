/**
 * 插件启动顺序测试
 *
 * 验证 PluginService 在 Gateway 启动时、Agent 工具初始化之前完成加载，
 * 并在 Gateway shutdown 时正确清理；同时验证单个插件加载失败不会阻塞启动。
 */

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import type { VexConfig } from "../src/types/index.js";
import { clearTools, getAllTools } from "../src/tools/registry.js";
import { createToolResult } from "../src/tools/types.js";

let testHome = "";

// Mock logger
vi.mock("../src/utils/logger.js", () => ({
  getChildLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock os.homedir to isolate from real home directory
vi.mock("os", async () => {
  const actual = await vi.importActual<typeof import("os")>("os");
  return {
    ...actual,
    homedir: vi.fn(() => testHome),
  };
});

// Mock plugin loader to inject a fixture plugin that registers a tool.
// The fixture proves plugin tools are registered before Agent initializes its tools.
vi.mock("../src/plugins/loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/plugins/loader.js")>();
  return {
    ...actual,
    loadPlugins: vi.fn(async (config: VexConfig, _enableConfig: unknown, options?: { memoryManager?: unknown }) => {
      const { registerPlugin } = await import("../src/plugins/index.js");
      await registerPlugin(
        {
          meta: {
            id: "test-startup-plugin",
            name: "Test Startup Plugin",
            version: "1.0.0",
          },
          register: async (api) => {
            api.registerTool({
              name: "plugin_startup_test_tool",
              label: "Plugin Startup Test Tool",
              description: "Tool registered during plugin startup",
              parameters: Type.Object({}),
              execute: async () => createToolResult("ok"),
            });
            await api.remember?.("Plugin startup memory", {
              type: "note",
              source: "plugin-startup-test",
              tags: ["plugin", "startup"],
            });
          },
        },
        config,
        { origin: "bundled", memoryManager: options?.memoryManager as never },
      );
      return { loaded: ["test-startup-plugin"], skipped: [], failed: [] };
    }),
  };
});

function createConfig(): VexConfig {
  return {
    providers: {},
    channels: {},
    agent: {
      defaultModel: "deepseek-chat",
      defaultProvider: "deepseek",
    },
    server: {
      port: 3000,
      host: "127.0.0.1",
    },
    logging: {
      level: "info",
    },
    memory: {
      enabled: true,
      directory: join(testHome, "memory"),
    },
  };
}

beforeEach(async () => {
  testHome = mkdtempSync(join(tmpdir(), "vex-plugin-startup-"));
  const { clearPipeline } = await import("../src/pipeline/index.js");
  clearPipeline();
});

afterEach(async () => {
  clearTools();
  const { unregisterAllPlugins } = await import("../src/plugins/index.js");
  await unregisterAllPlugins();
  const { clearPipeline } = await import("../src/pipeline/index.js");
  clearPipeline();
  rmSync(testHome, { recursive: true, force: true });
});

describe("plugin startup wiring", () => {
  it("loads plugin tools before agent tool initialization", async () => {
    const { createGateway } = await import("../src/gateway/server.js");
    const config = createConfig();

    const gateway = await createGateway(config);

    const tools = getAllTools();
    expect(tools.some((tool) => tool.name === "plugin_startup_test_tool")).toBe(true);

    await gateway.shutdown();
  });

  it("passes shared memory to plugin registration", async () => {
    const { createGateway } = await import("../src/gateway/server.js");
    const { MemoryManager } = await import("../src/memory/index.js");
    const config = createConfig();

    const gateway = await createGateway(config);
    const memory = new MemoryManager({ directory: config.memory?.directory, enabled: true });
    const entries = await memory.list({ tags: ["plugin", "startup"] });

    expect(entries.some((entry) => entry.content === "Plugin startup memory")).toBe(true);

    await memory.close();
    await gateway.shutdown();
  });

  it("shuts down plugin service during gateway shutdown", async () => {
    const { createGateway } = await import("../src/gateway/server.js");
    const { getLoadedPlugins } = await import("../src/plugins/index.js");
    const config = createConfig();

    const gateway = await createGateway(config);
    expect(getLoadedPlugins().some((plugin) => plugin.id === "test-startup-plugin")).toBe(true);

    await gateway.shutdown();
    expect(getLoadedPlugins()).toHaveLength(0);
  });

  it("isolates plugin load failures so gateway startup continues", async () => {
    const { loadPlugins } = await import("../src/plugins/loader.js");
    vi.mocked(loadPlugins).mockImplementationOnce(async () => ({
      loaded: [],
      skipped: [],
      failed: [{ id: "broken-plugin", error: "simulated load failure" }],
    }));

    const { createGateway } = await import("../src/gateway/server.js");
    const config = createConfig();

    await expect(createGateway(config)).resolves.toBeDefined();
  });
});
