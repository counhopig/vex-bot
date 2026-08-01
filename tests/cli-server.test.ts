/**
 * CLI server bootstrap tests — buildAgentFactory wiring.
 *
 * Part 2 of the coder-prompt integration: buildAgentFactory must construct a
 * per-user MemoryManager from effective.memory, read system weather, and pass
 * both + the process CronService into createBuiltinTools. createBuiltinTools
 * is mocked (spying on the real implementation) so the test can assert the
 * exact options the agent builder hands to the tool assembler.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { join } from "path";
import { homedir } from "os";

// Spy on createBuiltinTools: wrap the real implementation, capture options.
const createBuiltinToolsMock = vi.fn();
vi.mock("../src/tools/builtin/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tools/builtin/index.js")>();
  return {
    ...actual,
    createBuiltinTools: (opts: Parameters<typeof actual.createBuiltinTools>[0]) => {
      createBuiltinToolsMock(opts);
      return actual.createBuiltinTools(opts);
    },
  };
});

import { buildAgentFactory } from "../src/cli/server.js";
import { createBuiltinTools } from "../src/tools/builtin/index.js";
import type { ModelResolver } from "../src/providers/ModelResolver.js";
import type { EffectiveConfig } from "../src/config/EffectiveConfig.js";
import type { CronService } from "../src/cron/service.js";
import type { MemoryManager } from "../src/memory/MemoryManager.js";

/** Minimal ModelResolver stub — buildAgentFactory only stores it. */
function fakeModelResolver(): ModelResolver {
  return {
    init: vi.fn(),
    resolveModel: vi.fn(() => undefined),
    getApiKeyForProvider: vi.fn(() => "sk-test"),
    isProviderAvailable: vi.fn(() => false),
    getAllRegisteredModels: vi.fn(() => []),
    reset: vi.fn(),
  } as unknown as ModelResolver;
}

function fakeCronService(): CronService {
  return {
    list: vi.fn(() => []),
    add: vi.fn(),
    remove: vi.fn(() => true),
    run: vi.fn(async () => ({ status: "ok" })),
    get: vi.fn(() => undefined),
    update: vi.fn(() => undefined),
    start: vi.fn(),
    stop: vi.fn(),
  } as unknown as CronService;
}

function effectiveConfig(overrides?: Partial<EffectiveConfig>): EffectiveConfig {
  return {
    userId: "u1",
    channelId: "webchat",
    providers: {},
    agent: { defaultModel: "deepseek-chat", defaultProvider: "deepseek", temperature: 0.7, maxTokens: 4096 },
    server: { port: 3000, host: "127.0.0.1" },
    logging: { level: "info", pretty: true },
    ...overrides,
  } as EffectiveConfig;
}

beforeEach(() => {
  createBuiltinToolsMock.mockClear();
});

describe("buildAgentFactory tool wiring", () => {
  it("constructs a per-user MemoryManager from effective.memory and passes it to createBuiltinTools", async () => {
    const factory = buildAgentFactory(fakeModelResolver(), {
      weather: undefined,
      cron: fakeCronService(),
    });
    const agent = await factory("u1", "webchat", effectiveConfig({
      memory: { enabled: true, directory: "/tmp/vex-mem" },
    }));

    expect(agent).toBeDefined();
    expect(createBuiltinToolsMock).toHaveBeenCalledTimes(1);
    const opts = createBuiltinToolsMock.mock.calls[0]![0] as {
      owner: string;
      memoryManager?: MemoryManager;
      enableMemory?: boolean;
      weather?: unknown;
      cronService?: unknown;
      enableCron?: boolean;
    };
    expect(opts.owner).toBe("u1:webchat");
    expect(opts.memoryManager).toBeDefined();
    expect(opts.enableMemory).toBe(true);
  });

  it("defaults the memory directory per-user when effective.memory has no directory (or is absent entirely)", async () => {
    // Two cases, one expectation: an explicit memory section without a
    // directory AND a completely absent memory section both fall back to the
    // per-user default directory. The absent case previously produced an
    // "enabled but permanently inert" tool set (memoryEnabled true, but no
    // manager constructed) — this asserts the manager is real in both cases.
    for (const memory of [
      { enabled: true },       // explicit section, no directory
      undefined,               // no memory section at all
    ]) {
      createBuiltinToolsMock.mockClear();
      const factory = buildAgentFactory(fakeModelResolver(), {
        weather: undefined,
        cron: fakeCronService(),
      });
      await factory("u42", "webchat", effectiveConfig({ memory }));

      const opts = createBuiltinToolsMock.mock.calls[0]![0] as {
        memoryManager?: MemoryManager & { store?: { directory?: string } };
      };
      const dir = (opts.memoryManager as unknown as { store: { directory: string } }).store.directory;
      expect(dir).toBe(join(homedir(), ".vex", "memory", "u42"));
    }
  });

  it("disables memory tools when effective.memory.enabled is false", async () => {
    const factory = buildAgentFactory(fakeModelResolver(), {
      weather: undefined,
      cron: fakeCronService(),
    });
    await factory("u1", "webchat", effectiveConfig({ memory: { enabled: false } }));

    const opts = createBuiltinToolsMock.mock.calls[0]![0] as { enableMemory?: boolean };
    expect(opts.enableMemory).toBe(false);
  });

  it("passes system weather config through to createBuiltinTools", async () => {
    const weather = { defaultLocation: "Beijing" };
    const factory = buildAgentFactory(fakeModelResolver(), {
      weather,
      cron: fakeCronService(),
    });
    await factory("u1", "webchat", effectiveConfig({ memory: undefined }));

    const opts = createBuiltinToolsMock.mock.calls[0]![0] as { weather?: unknown };
    expect(opts.weather).toEqual(weather);
  });

  it("passes the process CronService through with enableCron on", async () => {
    const cron = fakeCronService();
    const factory = buildAgentFactory(fakeModelResolver(), {
      weather: undefined,
      cron,
    });
    await factory("u1", "webchat", effectiveConfig({ memory: undefined }));

    const opts = createBuiltinToolsMock.mock.calls[0]![0] as { cronService?: unknown; enableCron?: boolean };
    expect(opts.cronService).toBe(cron);
    expect(opts.enableCron).toBe(true);
  });
});
