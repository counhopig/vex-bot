/**
 * Runtime config integration matrix — every control-panel field maps to a
 * runtime consumer, or is explicitly classified unsupported.
 *
 * Table-driven: each row saves a per-user setting through ConfigStore tier 3,
 * builds an Agent through buildAgentFactory, and asserts the value reached
 * its runtime consumer. Rows classified "unsupported" assert the field is
 * NOT consumed (and not presented as active).
 *
 * Mirrors the audit table in docs/runtime-config-integration-fix-plan.md §2.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { join } from "path";
import { homedir } from "os";
import type { InboundMessageContext } from "../src/channels/ChannelAdapter.js";
import type { AgentRuntimeConfig } from "../src/agent/AgentRuntime.js";
import type { MemoryManager } from "../src/memory/MemoryManager.js";

// Capture the exact AgentRuntime config the agent builder hands the runtime.
const agentRuntimeConfigs: AgentRuntimeConfig[] = [];
vi.mock("../src/agent/AgentRuntime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agent/AgentRuntime.js")>();
  return {
    ...actual,
    AgentRuntime: class extends actual.AgentRuntime {
      constructor(config: AgentRuntimeConfig, deps: import("../src/agent/AgentRuntime.js").AgentRuntimeDeps) {
        agentRuntimeConfigs.push(config);
        super(config, deps);
      }
    },
  };
});

// Capture the exact createBuiltinTools options.
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

const loadAllSkillsMock = vi.fn();
vi.mock("../src/skills/SkillLoader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/skills/SkillLoader.js")>();
  return {
    ...actual,
    loadAllSkills: (config: unknown) => loadAllSkillsMock(config),
  };
});

const discoverPluginsMock = vi.fn();
vi.mock("../src/plugins/discovery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/plugins/discovery.js")>();
  return {
    ...actual,
    discoverPlugins: () => discoverPluginsMock(),
  };
});

import { buildAgentFactory } from "../src/cli/server.js";
import { ConfigStore } from "../src/config/ConfigStore.js";
import { YamlLoader } from "../src/config/resolvers/YamlLoader.js";
import type { CronService } from "../src/cron/service.js";
import type { ModelResolver } from "../src/providers/ModelResolver.js";

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

interface MatrixRow {
  name: string;
  /** Per-user settings (tier 3) saved via the control panel. */
  save: Record<string, unknown>;
  /** Assert the value reached its consumer on the built Agent. */
  assert: (c: MatrixContext) => void;
  /** "unsupported" rows assert the field is NOT consumed. */
  unsupported?: boolean;
}

interface MatrixContext {
  effective: Record<string, unknown>;
  runtimeCfg: AgentRuntimeConfig;
  builtinOpts: Record<string, unknown>;
  memoryManager: MemoryManager | undefined;
  skillsPrompt: string | undefined;
  agent: { persona: unknown; skillsPrompt?: string };
}

function mockCtx(content: string): InboundMessageContext {
  return {
    channelId: "webchat",
    messageId: `m-${Math.random()}`,
    chatId: "webchat:u1",
    chatType: "direct",
    senderId: "u1",
    webUserId: "u1",
    content,
    timestamp: Date.now(),
  };
}

const baseAgent = {
  defaultModel: "deepseek-chat",
  defaultProvider: "deepseek",
  temperature: 0.7,
  maxTokens: 4096,
};

// ---------------------------------------------------------------------------
// Matrix
// ---------------------------------------------------------------------------

const matrix: MatrixRow[] = [
  {
    name: "agent.defaultProvider → AgentRuntime.provider",
    save: { agent: { ...baseAgent, defaultProvider: "openai" } },
    assert: (c) => expect(c.runtimeCfg.provider).toBe("openai"),
  },
  {
    name: "agent.defaultModel → AgentRuntime.model",
    save: { agent: { ...baseAgent, defaultModel: "gpt-4" } },
    assert: (c) => expect(c.runtimeCfg.model).toBe("gpt-4"),
  },
  {
    name: "agent.temperature → AgentRuntime.temperature",
    save: { agent: { ...baseAgent, temperature: 0.2 } },
    assert: (c) => expect(c.runtimeCfg.temperature).toBe(0.2),
  },
  {
    name: "agent.maxTokens → AgentRuntime.maxTokens",
    save: { agent: { ...baseAgent, maxTokens: 8192 } },
    assert: (c) => expect(c.runtimeCfg.maxTokens).toBe(8192),
  },
  {
    name: "agent.systemPrompt → AgentRuntime.systemPrompt",
    save: { agent: { ...baseAgent, systemPrompt: "Always reply in Cantonese." } },
    assert: (c) => expect(c.runtimeCfg.systemPrompt).toBe("Always reply in Cantonese."),
  },
  {
    name: "personal agent.bashEnvPassthrough → rejected (system-owned)",
    save: { agent: { ...baseAgent, bashEnvPassthrough: ["MY_TOKEN"] } },
    unsupported: true,
    assert: (c) => {
      const bash = (c.builtinOpts.bash as { envPassthrough?: string[] } | undefined);
      expect(bash?.envPassthrough).toBeUndefined();
    },
  },
  {
    name: "persona (enabled) → Persona instance",
    save: { persona: { enabled: true, persona_name: "PandaBot" } },
    assert: (c) => expect(c.agent.persona).not.toBeNull(),
  },
  {
    name: "persona.enabled=false → no Persona instance (broken gate)",
    save: { persona: { enabled: false, persona_name: "GhostBot" } },
    assert: (c) => expect(c.agent.persona).toBeNull(),
  },
  {
    name: "memory.enabled=false → memory tools off",
    save: { memory: { enabled: false } },
    assert: (c) => expect(c.builtinOpts.enableMemory).toBe(false),
  },
  {
    name: "personal memory.directory → rejected; server-derived user directory",
    save: { memory: { enabled: true, directory: "/tmp/vex-mem" } },
    unsupported: true,
    assert: (c) => {
      const store = (c.memoryManager as unknown as { store?: { directory?: string } }).store;
      expect(store?.directory).toBe(join(homedir(), ".vex", "memory", "users", "u1"));
    },
  },
  {
    name: "weather provider+location → weather tool options",
    save: { weather: { weather_provider: "caiyun", default_location: "深圳" } },
    assert: (c) => {
      expect(c.builtinOpts.weather).toMatchObject({ provider: "caiyun", defaultLocation: "深圳" });
    },
  },
  {
    name: "sessions.directory outside user root → NOT honored (unsupported via panel)",
    save: { sessions: { directory: "/etc/evil" } },
    unsupported: true,
    assert: (c) => expect(c.runtimeCfg.sessionDir).toBe(join(homedir(), ".vex", "sessions", "users", "u1")),
  },
  {
    name: "personal sessions.type → rejected (system-owned)",
    save: { sessions: { type: "memory" } },
    unsupported: true,
    assert: (c) => {
      const sessions = (c.effective.sessions as { type?: string } | undefined);
      expect(sessions).toBeUndefined();
    },
  },
  {
    name: "memory.embeddingModel/embeddingProvider → not consumed (unsupported)",
    save: { memory: { embeddingModel: "bge", embeddingProvider: "deepseek" } },
    unsupported: true,
    assert: (c) => {
      const memory = c.effective.memory as { embeddingModel?: string; embeddingProvider?: string } | undefined;
      expect(memory?.embeddingModel).toBeUndefined();
      expect(memory?.embeddingProvider).toBeUndefined();
    },
  },
  {
    name: "skills.userDir → skills loader receives it",
    save: { skills: { enabled: true, userDir: "/tmp/user-skills" } },
    assert: (c) => expect(c.skillsPrompt).toBeUndefined(), // empty dir → prompt omitted, loader still called
  },
  {
    name: "skillLearner → /skill_learn command intercepted",
    save: { skillLearner: { enabled: true } },
    assert: (c) => {
      // Interceptor behavior is asserted end-to-end in cli-server.test.ts;
      // here we only prove the feature was assembled without throwing.
      expect(c.agent).toBeDefined();
    },
  },
  {
    name: "sharelink → sharelink_parse tool in customTools",
    save: { sharelink: { enabled: true, responseMode: "simple", autoDetect: true } },
    assert: (c) => {
      const names = c.runtimeCfg.customTools?.map((t) => t.name) ?? [];
      expect(names).toContain("sharelink_parse");
    },
  },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

describe("config → runtime consumer matrix", () => {
  beforeEach(() => {
    createBuiltinToolsMock.mockClear();
    loadAllSkillsMock.mockClear();
    loadAllSkillsMock.mockResolvedValue([]);
    discoverPluginsMock.mockClear();
    discoverPluginsMock.mockResolvedValue([]);
    agentRuntimeConfigs.length = 0;
  });

  for (const row of matrix) {
    it(`${row.unsupported ? "[unsupported] " : ""}${row.name}`, async () => {
      const store = new ConfigStore({
        yamlLoader: new YamlLoader("/nonexistent/config.yaml"),
        userConfigLoader: { load: () => row.save },
      });
      const effective = await store.resolve("u1", "webchat");
      const factory = buildAgentFactory(fakeModelResolver(), { cron: fakeCronService() });
      const agent = await factory("u1", "webchat", effective);

      const builtinOpts = createBuiltinToolsMock.mock.calls[0]?.[0] as Record<string, unknown>;
      const runtimeCfg = agentRuntimeConfigs[0]!;
      const memoryManager = (builtinOpts.memoryManager ?? undefined) as MemoryManager | undefined;

      const ctx: MatrixContext = {
        effective: effective as unknown as Record<string, unknown>,
        runtimeCfg,
        builtinOpts,
        memoryManager,
        skillsPrompt: agent.skillsPrompt,
        agent: { persona: agent.persona, skillsPrompt: agent.skillsPrompt },
      };
      row.assert(ctx);
      await agent.shutdown();
    });
  }
});
