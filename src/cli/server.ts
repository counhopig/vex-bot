/**
 * CLI server bootstrap — assembles the full WebServer dependency graph from a
 * SystemConfig and starts it.
 *
 * This is the top-level composition the rewrite-plan assigns to cli/ (the
 * web/server.ts bootstrap owns Express + channel lifecycle; the CLI owns
 * provider construction, per-user Agent building, and process lifecycle).
 */

import { join } from "path";
import { homedir } from "os";

import { YamlLoader } from "../config/resolvers/YamlLoader.js";
import { ConfigStore } from "../config/ConfigStore.js";
import { ModelResolver } from "../providers/ModelResolver.js";
import { ChannelRegistryImpl } from "../channels/ChannelRegistry.js";
import { OutboundDeliver } from "../outbound/OutboundDeliver.js";
import { AgentRegistry } from "../agent/AgentRegistry.js";
import { Agent } from "../agent/Agent.js";
import { AgentRuntime } from "../agent/AgentRuntime.js";
import { Pipeline } from "../agent/Pipeline.js";
import { Persona } from "../agent/persona/Persona.js";
import { createPersonaConfig } from "../agent/persona/PersonaConfig.js";
import { createDefaultPiSession, defaultSessionDir } from "../agent/createDefaultPiSession.js";
import { createBuiltinTools } from "../tools/builtin/index.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import { createMemoryManager } from "../memory/index.js";
import { loadAllSkills } from "../skills/SkillLoader.js";
import { SkillRegistry } from "../skills/SkillRegistry.js";
import { buildPrompt as buildSkillsPrompt } from "../skills/SkillInjector.js";
import { PluginService } from "../plugins/service.js";
import { discoverPlugins } from "../plugins/discovery.js";
import { defaultBus } from "../hooks/index.js";
import { Dispatcher } from "../dispatcher/Dispatcher.js";
import { WebServer } from "../web/server.js";
import { handleStaticRequest } from "../web/static/index.js";
import { WebAuthStore } from "../web/routes/auth.js";
import { FileSessionStore } from "../sessions/store.js";
import { LogStreamer } from "../web/routes/log-stream.js";
import { WeixinCredentialStore } from "../web/WeixinCredentialStore.js";
import { createLogger, setLogger } from "../utils/logger.js";
import { createCronExecutor } from "../cron/executor.js";
import { CronService } from "../cron/service.js";
import type { SystemConfig } from "../web/routes/config.js";
import type { EffectiveConfig } from "../config/EffectiveConfig.js";
import type { WeixinConfig } from "../channels/wechat/WeChatChannel.js";
import type { InboundMessageContext } from "../channels/ChannelAdapter.js";
import type { LlmCompleteLike } from "../sessions/title.js";
import type { WeatherToolOptions } from "../tools/builtin/weather.js";
import { resolveConfigPath } from "./config.js";

/**
 * Build the WebChat session-title generator (archive parity:
 * _archive/src/web/websocket.ts's maybeGenerateTitle used the system's
 * default provider/model, not the per-user resolved one — titling is a
 * cheap, unpersonalized summary, not part of the conversation). Returns
 * undefined when no provider has an API key configured, so title
 * generation silently stays off rather than failing every turn.
 */
function createTitleGenerator(
  modelResolver: ModelResolver,
  config: SystemConfig,
): { provider: string; model: string; complete: LlmCompleteLike } | undefined {
  const agent = (config.agent ?? {}) as Record<string, unknown>;
  const provider = typeof agent.defaultProvider === "string" ? agent.defaultProvider : undefined;
  const model = typeof agent.defaultModel === "string" ? agent.defaultModel : undefined;
  if (!provider || !model || !modelResolver.isProviderAvailable(provider)) return undefined;

  const complete: LlmCompleteLike = async (opts) => {
    const { completeSimple } = await import("@mariozechner/pi-ai");
    const resolved = modelResolver.resolveModel(opts.provider, opts.model);
    if (!resolved) throw new Error(`Cannot resolve model: ${opts.provider}/${opts.model}`);
    const apiKey = modelResolver.getApiKeyForProvider(opts.provider);
    const message = await completeSimple(
      resolved,
      { messages: [{ role: "user", content: opts.prompt, timestamp: Date.now() }] },
      { temperature: opts.temperature, maxTokens: opts.maxTokens, apiKey },
    );
    const text = message.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("");
    return { text };
  };

  return { provider, model, complete };
}

/**
 * System-level dependencies the per-agent builder needs beyond its own
 * EffectiveConfig: the process-wide CronService (cron tools are wired to it)
 * and the system weather section (weather is not per-user — EffectiveConfig
 * is user-scoped and deliberately omits it).
 */
export interface BuildAgentSystemDeps {
  /** Process-wide CronService shared by every agent's cron tools. */
  cron: CronService;
  /** System-level weather config section (optional). */
  weather?: WeatherToolOptions;
}

/**
 * Build a per-(user, channel) Agent from its EffectiveConfig.
 * Each Agent owns its Pipeline, Persona, AgentRuntime, and a per-user
 * MemoryManager (no process-global state — principle #5); the runtime
 * resolves models through a shared ModelResolver initialized from the
 * system provider config.
 */
export function buildAgentFactory(modelResolver: ModelResolver, system: BuildAgentSystemDeps) {
  return async (userId: string, channelId: string, config: unknown): Promise<Agent> => {
    const effective = config as EffectiveConfig;
    const persona = effective.persona
      ? new Persona(createPersonaConfig(effective.persona as Record<string, unknown>)!)
      : null;

    // Per-user MemoryManager from effective.memory (per-user resolved by
    // ConfigStore); directory isolated per user. `memoryEnabled` defaults to
    // true when the section is absent (matching how every sibling section in
    // EffectiveConfig gets a real default from BUILT_IN_DEFAULTS), so an
    // omitted `memory:` block still yields a working manager — not an
    // "enabled but permanently inert" tool set.
    const memoryCfg = effective.memory;
    const memoryEnabled = memoryCfg ? memoryCfg.enabled !== false : true;
    const memoryManager = memoryEnabled
      ? createMemoryManager({
          enabled: memoryEnabled,
          directory: memoryCfg?.directory ?? join(homedir(), ".vex", "memory", userId),
        })
      : undefined;

    // Per-user skills: load the user's skill dirs into a fresh SkillRegistry
    // and assemble the skills section of the system prompt. Absent/disabled
    // skills config → skillsPrompt is undefined (section omitted). Re-scans
    // on every agent build — simplest correct behavior, no caching.
    const skillsCfg = effective.skills;
    let skillsPrompt: string | undefined;
    if (skillsCfg && skillsCfg.enabled !== false) {
      const registry = new SkillRegistry();
      const entries = await loadAllSkills(skillsCfg);
      await registry.load(entries);
      const prompt = buildSkillsPrompt(registry);
      skillsPrompt = prompt || undefined;
    }

    // Per-(user, channel) plugin runtime: one PluginService per Agent,
    // owning a fresh ToolRegistry so plugin tools are scoped to this agent
    // (principle #5 — no state bleeding across instances), the shared
    // defaultBus for app-wide hook broadcasts, per-user state dirs, and the
    // same per-user MemoryManager the builtin memory tools use. Discovery is
    // system-level (bundled → global → workspace); there is no per-user
    // plugin code dir concept this round. Plugin tools are merged into the
    // runtime's customTools alongside the builtin set.
    const pluginToolRegistry = new ToolRegistry();
    const pluginService = new PluginService({
      toolRegistry: pluginToolRegistry,
      eventBus: defaultBus,
      config: effective,
      memoryManager,
      getStateDir: (pluginId) => join(homedir(), ".vex", "plugins", userId, pluginId),
    });
    const candidates = await discoverPlugins();
    await pluginService.loadFromCandidates(candidates);
    await pluginService.activateAll();

    const runtime = new AgentRuntime(
      {
        model: effective.agent.defaultModel,
        provider: effective.agent.defaultProvider,
        systemPrompt: effective.agent.systemPrompt,
        temperature: effective.agent.temperature,
        maxTokens: effective.agent.maxTokens,
        workingDirectory: effective.agent.workingDirectory ?? process.cwd(),
        sessionDir: defaultSessionDir(),
        customTools: [
          ...createBuiltinTools({
            owner: `${userId}:${channelId}`,
            memoryManager,
            weather: system.weather,
            cronService: system.cron,
            enableMemory: memoryEnabled,
            enableCron: true,
          }),
          ...pluginToolRegistry.getAll(),
        ],
      },
      { modelResolver, createPiSession: createDefaultPiSession },
    );
    return new Agent(userId, effective, { pipeline: new Pipeline(), persona, runtime, skillsPrompt, pluginService });
  };
}

/** Start the full WebServer; resolves the SIGINT/SIGTERM shutdown path. */
export async function startWebServer(config: SystemConfig): Promise<WebServer> {
  setLogger(createLogger({
    level: (() => {
      const raw = (config.logging as { level?: string } | undefined)?.level;
      return raw === "debug" || raw === "warn" || raw === "error" || raw === "info" ? raw : "info";
    })(),
    pretty: (config.logging as { pretty?: boolean } | undefined)?.pretty ?? true,
  }));

  const configPath = resolveConfigPath();
  const webAuth = (config.webAuth ?? {}) as { enabled?: boolean; database?: string };
  const dbPath = typeof webAuth.database === "string" && webAuth.database
    ? webAuth.database
    : join(homedir(), ".vex", "web-auth.sqlite");

  // Core infrastructure
  const modelResolver = new ModelResolver();
  modelResolver.init({ providers: config.providers as ModelResolverInit });
  const configStore = new ConfigStore({ yamlLoader: new YamlLoader(configPath) });
  const registry = new ChannelRegistryImpl();
  const outbound = new OutboundDeliver(registry);

  // Cron: process-wide scheduler bound to Dispatcher.dispatchSynthetic.
  // Declared before the AgentRegistry so buildAgentFactory can hand the same
  // CronService to every agent's cron tools; `dispatcher` is late-bound below
  // (the executor only touches it when a job fires, after startup completes).
  let dispatcher: Dispatcher;
  const cron = new CronService({
    executeJob: createCronExecutor({ dispatch: (ctx: InboundMessageContext) => dispatcher.dispatchSynthetic(ctx) }).executeJob,
  });

  const weather = config.weather as WeatherToolOptions | undefined;
  const agentRegistry = new AgentRegistry<Agent>({
    factory: buildAgentFactory(modelResolver, { cron, weather }),
  });
  dispatcher = new Dispatcher(configStore, agentRegistry, async (msg) => {
    await outbound.sendText(msg.channelId, msg.ctx.chatId, msg.text, { webUserId: msg.webUserId });
  });
  cron.start();

  const auth = new WebAuthStore({ dbPath, enabled: webAuth.enabled ?? true });
  const sessionStore = new FileSessionStore(join(homedir(), ".vex", "sessions"));
  const logStreamer = new LogStreamer();
  const credentialStore = new WeixinCredentialStore({ dbPath });

  const server = new WebServer({
    config,
    configPath,
    auth,
    sessionStore,
    registry,
    configStore,
    agentRegistry,
    dispatcher,
    outbound,
    logStreamer,
    credentialStore,
    getWeixinConfig: () => (config.channels?.weixin as WeixinConfig | undefined),
    staticHandler: (req, res) => handleStaticRequest(req, res, { config, auth }),
    titleGenerator: createTitleGenerator(modelResolver, config),
  });

  await server.initialize();
  await server.start();

  // Graceful shutdown on SIGINT/SIGTERM; the cron loop is stopped with the server.
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\nReceived ${signal}, shutting down...`);
    cron.stop();
    await server.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  return server;
}

type ModelResolverInit = {
  providers?: Record<string, { baseUrl?: string; apiKey?: string; headers?: Record<string, string> } | undefined>;
};
