/**
 * CLI server bootstrap tests — buildAgentFactory wiring.
 *
 * Part 2 of the coder-prompt integration: buildAgentFactory must construct a
 * per-user MemoryManager from effective.memory, read system weather, and pass
 * both + the process CronService into createBuiltinTools. createBuiltinTools
 * is mocked (spying on the real implementation) so the test can assert the
 * exact options the agent builder hands to the tool assembler.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
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

// Spy on loadAllSkills so buildAgentFactory's skill wiring is testable
// without touching the filesystem.
const loadAllSkillsMock = vi.fn();
vi.mock("../src/skills/SkillLoader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/skills/SkillLoader.js")>();
  return {
    ...actual,
    loadAllSkills: (config: unknown) => loadAllSkillsMock(config),
  };
});

// Spy on the AgentRuntime constructor so the test can assert the exact
// customTools (builtin + plugin) the agent builder hands the runtime.
const agentRuntimeConfigs: Array<import("../src/agent/AgentRuntime.js").AgentRuntimeConfig> = [];
vi.mock("../src/agent/AgentRuntime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agent/AgentRuntime.js")>();
  return {
    ...actual,
    AgentRuntime: class extends actual.AgentRuntime {
      constructor(
        config: import("../src/agent/AgentRuntime.js").AgentRuntimeConfig,
        deps: import("../src/agent/AgentRuntime.js").AgentRuntimeDeps,
      ) {
        agentRuntimeConfigs.push(config);
        super(config, deps);
      }
    },
  };
});

// Spy on discoverPlugins so plugin wiring tests drive a deterministic
// candidate list instead of the real filesystem scan.
const discoverPluginsMock = vi.fn();
vi.mock("../src/plugins/discovery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/plugins/discovery.js")>();
  return {
    ...actual,
    discoverPlugins: (opts: unknown) => discoverPluginsMock(opts),
  };
});

import { buildAgentFactory, createConfigStore } from "../src/cli/server.js";
import { WebAuthStore } from "../src/web/routes/auth.js";
import { createBuiltinTools } from "../src/tools/builtin/index.js";
import type { ModelResolver } from "../src/providers/ModelResolver.js";
import type { EffectiveConfig } from "../src/config/EffectiveConfig.js";
import type { CronService } from "../src/cron/service.js";
import type { MemoryManager } from "../src/memory/MemoryManager.js";
import type { SkillEntry } from "../src/skills/types.js";
import type { PluginCandidate } from "../src/plugins/types.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";

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
  loadAllSkillsMock.mockClear();
  loadAllSkillsMock.mockResolvedValue([]);
  agentRuntimeConfigs.length = 0;
  discoverPluginsMock.mockClear();
  discoverPluginsMock.mockResolvedValue([]);
});

describe("buildAgentFactory tool wiring", () => {
  it("constructs a per-user MemoryManager from effective.memory and passes it to createBuiltinTools", async () => {
    const factory = buildAgentFactory(fakeModelResolver(), {
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
        cron: fakeCronService(),
      });
      await factory("u42", "webchat", effectiveConfig({ memory }));

      const opts = createBuiltinToolsMock.mock.calls[0]![0] as {
        memoryManager?: MemoryManager & { store?: { directory?: string } };
      };
      const dir = (opts.memoryManager as unknown as { store: { directory: string } }).store.directory;
      expect(dir).toBe(join(homedir(), ".vex", "memory", "users", "u42"));
    }
  });

  it("disables memory tools when effective.memory.enabled is false", async () => {
    const factory = buildAgentFactory(fakeModelResolver(), {
      cron: fakeCronService(),
    });
    await factory("u1", "webchat", effectiveConfig({ memory: { enabled: false } }));

    const opts = createBuiltinToolsMock.mock.calls[0]![0] as { enableMemory?: boolean };
    expect(opts.enableMemory).toBe(false);
  });

  it("builds the weather tool from the per-user effective weather section (not a startup capture)", async () => {
    // Two users, two locations: the factory must read effective.weather,
    // which ConfigStore resolves per user (YAML + SQLite overlay).
    for (const [userId, location] of [["u1", "Beijing"], ["u2", "Shanghai"]] as const) {
      createBuiltinToolsMock.mockClear();
      const factory = buildAgentFactory(fakeModelResolver(), {
        cron: fakeCronService(),
      });
      await factory(userId, "webchat", effectiveConfig({
        memory: undefined,
        weather: { provider: "wttr", defaultLocation: location },
      }));

      const opts = createBuiltinToolsMock.mock.calls[0]![0] as { weather?: { provider?: string; defaultLocation?: string } };
      expect(opts.weather).toEqual({ provider: "wttr", defaultLocation: location });
    }
  });

  it("passes the process CronService through with enableCron on", async () => {
    const cron = fakeCronService();
    const factory = buildAgentFactory(fakeModelResolver(), {
      cron,
    });
    await factory("u1", "webchat", effectiveConfig({ memory: undefined }));

    const opts = createBuiltinToolsMock.mock.calls[0]![0] as { cronService?: unknown; enableCron?: boolean };
    expect(opts.cronService).toBe(cron);
    expect(opts.enableCron).toBe(true);
  });

  it("loads skills from effective.skills and passes the assembled prompt to the Agent", async () => {
    const fakeSkill: SkillEntry = {
      frontmatter: { name: "greeting", title: "Greeting" },
      content: "Say hi.",
      filePath: "/tmp/skills/greeting/SKILL.md",
      source: "user",
    };
    loadAllSkillsMock.mockResolvedValue([fakeSkill]);

    const factory = buildAgentFactory(fakeModelResolver(), {
      cron: fakeCronService(),
    });
    const agent = await factory("u1", "webchat", effectiveConfig({
      memory: undefined,
      skills: { enabled: true, userDir: "/tmp/skills" },
    }));

    expect(loadAllSkillsMock).toHaveBeenCalledTimes(1);
    expect(loadAllSkillsMock).toHaveBeenCalledWith({
      enabled: true,
      userDir: "/tmp/skills/users/u1",
    });
    expect(agent.skillsPrompt).toContain("# Available Skills");
    expect(agent.skillsPrompt).toContain("Skill: Greeting");
  });

  it("leaves skillsPrompt undefined when effective.skills is absent", async () => {
    const factory = buildAgentFactory(fakeModelResolver(), {
      cron: fakeCronService(),
    });
    const agent = await factory("u1", "webchat", effectiveConfig({ memory: undefined, skills: undefined }));

    expect(loadAllSkillsMock).not.toHaveBeenCalled();
    expect(agent.skillsPrompt).toBeUndefined();
  });

  it("leaves skillsPrompt undefined when effective.skills.enabled is false", async () => {
    const factory = buildAgentFactory(fakeModelResolver(), {
      cron: fakeCronService(),
    });
    const agent = await factory("u1", "webchat", effectiveConfig({
      memory: undefined,
      skills: { enabled: false, userDir: "/tmp/skills" },
    }));

    expect(loadAllSkillsMock).not.toHaveBeenCalled();
    expect(agent.skillsPrompt).toBeUndefined();
  });

  it("does not crash when effective.skills is enabled but no skills load (prompt omitted)", async () => {
    loadAllSkillsMock.mockResolvedValue([]);
    const factory = buildAgentFactory(fakeModelResolver(), {
      cron: fakeCronService(),
    });
    const agent = await factory("u1", "webchat", effectiveConfig({
      memory: undefined,
      skills: { enabled: true, userDir: "/tmp/empty-skills" },
    }));

    expect(loadAllSkillsMock).toHaveBeenCalledTimes(1);
    expect(agent.skillsPrompt).toBeUndefined();
  });
});

describe("buildAgentFactory plugin wiring", () => {
  let pluginFixtureDir = "";

  beforeEach(() => {
    pluginFixtureDir = mkdtempSync(join(tmpdir(), "vex-plugin-wiring-"));
  });

  afterEach(() => {
    rmSync(pluginFixtureDir, { recursive: true, force: true });
    delete (globalThis as { __vexPluginStateDir?: string }).__vexPluginStateDir;
  });

  function toolPluginCandidate(id: string): PluginCandidate {
    writeFileSync(
      join(pluginFixtureDir, `${id}.js`),
      [
        "module.exports = {",
        `  meta: { id: '${id}', name: '${id}', version: '1.0.0' },`,
        "  register: (api) => {",
        "    globalThis.__vexPluginStateDir = api.getStateDir();",
        "    api.registerTool({",
        `      name: '${id}-tool',`,
        "      description: 'from plugin',",
        "      parameters: { type: 'object', properties: {} },",
        "      execute: async () => ({ content: [{ type: 'text', text: 'hi' }] }),",
        "    });",
        "  },",
        "};",
      ].join("\n"),
    );
    return {
      id,
      origin: "workspace",
      entryPath: join(pluginFixtureDir, `${id}.js`),
      directory: pluginFixtureDir,
    };
  }

  it("loads system-discovered plugins per (user, channel) and merges their tools into the AgentRuntime customTools", async () => {
    discoverPluginsMock.mockResolvedValue([toolPluginCandidate("wired")]);
    const factory = buildAgentFactory(fakeModelResolver(), {
      cron: fakeCronService(),
    });

    const agent = await factory("u1", "webchat", effectiveConfig({ memory: undefined }));

    expect(agent).toBeDefined();
    expect(discoverPluginsMock).toHaveBeenCalledTimes(1);
    const config = agentRuntimeConfigs[0]!;
    expect(config.customTools?.map((t) => t.name)).toContain("wired-tool");
    expect(
      (globalThis as { __vexPluginStateDir?: string }).__vexPluginStateDir,
    ).toBe(join(homedir(), ".vex", "plugins", "u1", "wired"));
  });

  it("scopes the plugin state dir per user", async () => {
    discoverPluginsMock.mockResolvedValue([toolPluginCandidate("wired")]);
    const factory = buildAgentFactory(fakeModelResolver(), {
      cron: fakeCronService(),
    });

    await factory("u1", "webchat", effectiveConfig({ memory: undefined }));
    expect(
      (globalThis as { __vexPluginStateDir?: string }).__vexPluginStateDir,
    ).toBe(join(homedir(), ".vex", "plugins", "u1", "wired"));

    await factory("u2", "webchat", effectiveConfig({ memory: undefined }));
    expect(
      (globalThis as { __vexPluginStateDir?: string }).__vexPluginStateDir,
    ).toBe(join(homedir(), ".vex", "plugins", "u2", "wired"));
  });

  it("builds a working agent when discovery finds no plugins (plugin section omitted)", async () => {
    discoverPluginsMock.mockResolvedValue([]);
    const factory = buildAgentFactory(fakeModelResolver(), {
      cron: fakeCronService(),
    });

    const agent = await factory("u1", "webchat", effectiveConfig({ memory: undefined }));

    expect(agent).toBeDefined();
    expect(discoverPluginsMock).toHaveBeenCalledTimes(1);
    const config = agentRuntimeConfigs[0]!;
    const names = config.customTools?.map((t) => t.name) ?? [];
    expect(names).not.toContain("wired-tool");
    expect(names.length).toBeGreaterThan(0);
  });
});

describe("createConfigStore composition", () => {
  const mkTemp = () => mkdtempSync(join(tmpdir(), "vex-configstore-"));
  const rmTemp = (dir: string) => rmSync(dir, { recursive: true, force: true });

  it("wires SqliteLoader to the same auth DB path the control panel writes (save → resolve round-trip)", async () => {
    const dir = mkTemp();
    try {
      const dbPath = join(dir, "web-auth.sqlite");
      const auth = new WebAuthStore({ dbPath, enabled: true });
      const user = await auth.createUser("alice", "password-123");
      auth.saveUserConfigSettings(user.id, { persona: { persona_name: "PandaBot" } });
      auth.close();

      // createConfigStore composes YamlLoader + SqliteLoader on that dbPath.
      const store = createConfigStore(join(dir, "config.local.yaml"), dbPath);
      const config = await store.resolve(user.id, "webchat");

      expect(config.persona?.persona_name).toBe("PandaBot");
    } finally {
      rmTemp(dir);
    }
  });

  it("falls back to YAML/defaults for users with no saved settings", async () => {
    const dir = mkTemp();
    try {
      const dbPath = join(dir, "web-auth.sqlite");
      const auth = new WebAuthStore({ dbPath, enabled: true });
      await auth.createUser("alice", "password-123");
      auth.close();

      const store = createConfigStore(join(dir, "config.local.yaml"), dbPath);
      const config = await store.resolve("alice", "webchat");

      expect(config.persona).toBeUndefined();
      expect(config.agent.defaultModel).toBe("deepseek-chat");
    } finally {
      rmTemp(dir);
    }
  });
});

describe("buildAgentFactory runtime-config wiring", () => {
  function mockCtx(content: string): import("../src/channels/ChannelAdapter.js").InboundMessageContext {
    return {
      channelId: "webchat",
      messageId: `msg-${Date.now()}`,
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

  it("honors persona.enabled === false (no persona state instantiated)", async () => {
    const factory = buildAgentFactory(fakeModelResolver(), { cron: fakeCronService() });
    const agent = await factory("u1", "webchat", effectiveConfig({
      memory: undefined,
      persona: { enabled: false, persona_name: "GhostBot" },
    }));
    expect(agent.persona).toBeNull();
  });

  it("instantiates persona when enabled is true or absent", async () => {
    const factory = buildAgentFactory(fakeModelResolver(), { cron: fakeCronService() });
    const enabled = await factory("u1", "webchat", effectiveConfig({
      memory: undefined,
      persona: { enabled: true, persona_name: "PandaBot" },
    }));
    const absent = await factory("u2", "webchat", effectiveConfig({ memory: undefined }));
    expect(enabled.persona).not.toBeNull();
    expect(absent.persona).toBeNull();
  });

  it("passes only the configured bash envPassthrough names to the bash tool", async () => {
    const factory = buildAgentFactory(fakeModelResolver(), { cron: fakeCronService() });
    await factory("u1", "webchat", effectiveConfig({
      memory: undefined,
      agent: { ...baseAgent, bashEnvPassthrough: ["MY_TOKEN", "CI"] },
    }));
    const opts = createBuiltinToolsMock.mock.calls[0]![0] as { bash?: { envPassthrough?: string[] } };
    expect(opts.bash?.envPassthrough).toEqual(["MY_TOKEN", "CI"]);
  });

  it("does not pass a bash envPassthrough when none is configured", async () => {
    const factory = buildAgentFactory(fakeModelResolver(), { cron: fakeCronService() });
    await factory("u1", "webchat", effectiveConfig({ memory: undefined }));
    const opts = createBuiltinToolsMock.mock.calls[0]![0] as { bash?: { envPassthrough?: string[] } };
    expect(opts.bash?.envPassthrough ?? []).toEqual([]);
  });

  it("scopes the pi JSONL session dir per user by default", async () => {
    const factory = buildAgentFactory(fakeModelResolver(), { cron: fakeCronService() });
    await factory("u1", "webchat", effectiveConfig({ memory: undefined }));
    expect(agentRuntimeConfigs[0]!.sessionDir).toBe(join(homedir(), ".vex", "sessions", "users", "u1"));
  });

  it("honors a configured session dir only when it stays inside the user root", async () => {
    const factory = buildAgentFactory(fakeModelResolver(), { cron: fakeCronService() });
    const inside = join(homedir(), ".vex", "sessions", "users", "u1", "custom");
    agentRuntimeConfigs.length = 0;
    await factory("u1", "webchat", effectiveConfig({
      memory: undefined,
      sessions: { directory: inside },
    }));
    expect(agentRuntimeConfigs[0]!.sessionDir).toBe(inside);

    agentRuntimeConfigs.length = 0;
    await factory("u1", "webchat", effectiveConfig({
      memory: undefined,
      sessions: { directory: "/etc/evil" },
    }));
    expect(agentRuntimeConfigs[0]!.sessionDir).toBe(join(homedir(), ".vex", "sessions", "users", "u1"));
  });

  it("wires SkillLearner + ShareLink into the per-agent pipeline and tool set", async () => {
    const factory = buildAgentFactory(fakeModelResolver(), { cron: fakeCronService() });
    const agent = await factory("u1", "webchat", effectiveConfig({
      memory: undefined,
      skillLearner: { enabled: true, autoTriggerKeywords: ["记住"] },
      sharelink: { enabled: true, autoDetect: true, responseMode: "simple" },
    }));

    // SkillLearner command is intercepted and short-circuits before any LLM call.
    const reply = await agent.processMessage(mockCtx("/skill_learn"));
    expect(reply.content).toContain("已进入技能学习模式");

    // ShareLink tool is present in the runtime customTools.
    const cfg = agentRuntimeConfigs[0]!;
    const names = cfg.customTools?.map((t) => t.name) ?? [];
    expect(names).toContain("sharelink_parse");
    await agent.shutdown();
  });

  it("leaves ShareLink/SkillLearner off when their config sections are absent", async () => {
    const factory = buildAgentFactory(fakeModelResolver(), { cron: fakeCronService() });
    const agent = await factory("u1", "webchat", effectiveConfig({ memory: undefined }));

    const names = agentRuntimeConfigs[0]!.customTools?.map((t) => t.name) ?? [];
    expect(names).not.toContain("sharelink_parse");
    await agent.shutdown();
  });

  it("does not deploy SkillLearner state across users (separate state dirs)", async () => {
    const factory = buildAgentFactory(fakeModelResolver(), { cron: fakeCronService() });
    const agentA = await factory("uA", "webchat", effectiveConfig({
      memory: undefined,
      skillLearner: { enabled: true },
    }));
    const agentB = await factory("uB", "webchat", effectiveConfig({
      memory: undefined,
      skillLearner: { enabled: true },
    }));

    const replyA = await agentA.processMessage(mockCtx("/skill_learn"));
    expect(replyA.content).toContain("已进入技能学习模式");
    // Agent B has no active session — its status command reports no session.
    const replyB = await agentB.processMessage(mockCtx("/skill_status"));
    expect(replyB.content).not.toContain("正在学习中");

    await agentA.shutdown();
    await agentB.shutdown();
  });
});
