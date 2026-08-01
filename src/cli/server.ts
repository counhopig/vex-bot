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
 * Build a per-(user, channel) Agent from its EffectiveConfig.
 * Each Agent owns its Pipeline, Persona, and AgentRuntime (no process-global
 * state — principle #5); the runtime resolves models through a shared
 * ModelResolver initialized from the system provider config.
 */
function buildAgentFactory(modelResolver: ModelResolver) {
  return async (userId: string, channelId: string, config: unknown): Promise<Agent> => {
    const effective = config as EffectiveConfig;
    const persona = effective.persona
      ? new Persona(createPersonaConfig(effective.persona as Record<string, unknown>)!)
      : null;
    const runtime = new AgentRuntime(
      {
        model: effective.agent.defaultModel,
        provider: effective.agent.defaultProvider,
        systemPrompt: effective.agent.systemPrompt,
        temperature: effective.agent.temperature,
        maxTokens: effective.agent.maxTokens,
        workingDirectory: effective.agent.workingDirectory ?? process.cwd(),
        sessionDir: defaultSessionDir(),
        customTools: createBuiltinTools({ owner: `${userId}:${channelId}` }),
      },
      { modelResolver, createPiSession: createDefaultPiSession },
    );
    return new Agent(userId, effective, { pipeline: new Pipeline(), persona, runtime });
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
  const agentRegistry = new AgentRegistry<Agent>({ factory: buildAgentFactory(modelResolver) });
  const dispatcher = new Dispatcher(configStore, agentRegistry, async (msg) => {
    await outbound.sendText(msg.channelId, msg.ctx.chatId, msg.text, { webUserId: msg.webUserId });
  });

  // Cron: process-wide scheduler bound to Dispatcher.dispatchSynthetic.
  const cron = new CronService({
    executeJob: createCronExecutor({ dispatch: (ctx: InboundMessageContext) => dispatcher.dispatchSynthetic(ctx) }).executeJob,
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
