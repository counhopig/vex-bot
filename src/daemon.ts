import { readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startWeChatChannel } from "./channels/wechat/setup.js";
import { ConfigError, saveConfigText } from "./config/load.js";
import type { VexConfig } from "./config/schema.js";
import {
  baseInstructionsSection,
  residentFileSection,
  SystemPromptBuilder,
  timeSection,
} from "./context/prompt.js";
import { EventBus } from "./core/events.js";
import { Session } from "./core/session.js";
import { SessionManager } from "./core/sessionManager.js";
import { createTitleGenerator } from "./core/title.js";
import { isLoopback, WebAuth } from "./gateway/auth.js";
import { Gateway } from "./gateway/server.js";
import type { Logger } from "./logger.js";
import type { VexPaths } from "./paths.js";
import { MemoryIndex } from "./index/memory.js";
import { createMemorySearchTool } from "./index/tool.js";
import { ApprovalManager } from "./policy/approvals.js";
import { createToolGate } from "./policy/gate.js";
import { ToolPolicy } from "./policy/policy.js";
import { createModelRegistry, type ModelRegistry } from "./providers/models.js";
import { createCoreTools } from "./tools/registry.js";
import { ensureWorkspace } from "./workspace/workspace.js";
import { Persona } from "./persona/index.js";
import { Scheduler } from "./scheduler/index.js";
import { createFeelTool } from "./tools/feel.js";
import { createScheduleTool } from "./tools/schedule.js";
import { createWebFetchTool, createWebSearchTool } from "./tools/web.js";
import { McpBridge } from "./tools/mcp.js";
import { createDelegateTool } from "./tools/delegate.js";
import { skillsSection } from "./skills/index.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { WeChatChannel } from "./channels/wechat/channel.js";

export interface DaemonOptions {
  paths: VexPaths;
  config: VexConfig;
  log: Logger;
  models?: ModelRegistry;
  staticDir?: string;
}

export interface Daemon {
  url: string;
  port: number;
  stop(): Promise<void>;
}

const DEFAULT_STATIC_DIR = fileURLToPath(new URL("./web/static/", import.meta.url));

export async function startDaemon(opts: DaemonOptions): Promise<Daemon> {
  const { paths, config, log } = opts;
  if (!isLoopback(config.web.host) && !config.web.token) {
    throw new ConfigError("web.host 不是本机地址时必须设置 web.token");
  }
  await ensureWorkspace(config.workspace);

  const models = opts.models ?? createModelRegistry(config.providers);
  const model = models.resolve(config.model);
  const backgroundModel = models.resolve(config.backgroundModel);
  const getApiKey = (provider: string) => models.getApiKey(provider);

  const bus = new EventBus((err) => log.error({ err }, "event listener failed"));
  const approvals = new ApprovalManager({ onChange: () => bus.emit({ type: "approvals_changed" }), workspace: config.workspace });
  const policy = new ToolPolicy({ workspace: config.workspace, overrides: config.toolPolicy });
  const memoryIndex = await MemoryIndex.open({ databasePath: join(paths.home, "index.sqlite"), workspace: config.workspace, sessions: paths.sessions, onWarning: (message) => log.warn(message) });
  const startupCleanup: (() => Promise<void> | void)[] = [() => approvals.dispose(), () => memoryIndex.close()];
  try {
  const persona = await Persona.open({ path: join(paths.home, "state", "mood.json"), sleep: config.persona?.sleep,
    outreach: config.persona?.outreach, warn: (message) => log.warn(message) });
  let scheduler: Scheduler;
  let wechat: WeChatChannel | undefined;
  let wechatInbound = 0;
  const live = new Map<Session, () => AgentTool<any>[]>();
  const mcp = new McpBridge(config.mcpServers ?? {}, {
    onToolsChanged: () => { for (const [session, getTools] of live) session.setTools(getTools()); },
    onError: (server, err) => log.warn({ server, err }, "MCP connection failed"),
  });
  startupCleanup.push(() => mcp.close());
  await mcp.start();
  const commonTools = [...createCoreTools({ workspace: config.workspace, bashEnvPassthrough: config.bashEnvPassthrough, configPath: paths.config }),
    createMemorySearchTool(memoryIndex), createFeelTool(persona), createWebFetchTool(), createWebSearchTool(config.webSearch)];
  const prompt = new SystemPromptBuilder([
    baseInstructionsSection(config.workspace),
    residentFileSection({ workspace: config.workspace, file: "SOUL.md", maxLines: 200 }),
    residentFileSection({ workspace: config.workspace, file: "USER.md", maxLines: 200 }),
    () => `## 情绪与作息\n${persona.describe()}`,
    residentFileSection({ workspace: config.workspace, file: "MEMORY.md", maxLines: 100 }),
    skillsSection(config.workspace, undefined, (message) => log.warn(message)),
    timeSection(),
  ]);

  const openSession = async (key: string, transcriptPath: string, windowLabel: () => string, temporary: false | "heartbeat" | "consolidation" = false): Promise<Session> => {
      const gate = createToolGate({ policy, approvals, sessionKey: key, windowLabel });
      const workspacePolicy = new ToolPolicy({ workspace: config.workspace, overrides: {} });
      const beforeToolCall: NonNullable<Parameters<typeof Session.open>[0]["beforeToolCall"]> = async (ctx, signal) => {
        if (temporary === "consolidation") {
          if (ctx.toolCall.name === "memory_search") return;
          const args = ctx.args as { path?: string };
          if (workspacePolicy.decide("write", { path: args.path ?? "." }) !== "allow") return { block: true, reason: "记忆整理只能访问工作区文件。" };
          return;
        }
        return gate(ctx, signal);
      };
      const getTools = (): AgentTool<any>[] => {
        if (temporary === "consolidation") return policy.filter(commonTools.filter((tool) => ["read", "write", "edit", "grep", "find", "memory_search"].includes(tool.name)));
        const base = policy.filter([...commonTools, ...mcp.getTools(), createScheduleTool(scheduler, key.startsWith("web:") ? key.slice(4) : "wechat")]);
        return policy.filter([...base, createDelegateTool({ workspace: config.workspace, model: temporary ? backgroundModel : model, streamFn: models.streamFn, getApiKey, getTools: () => policy.filter([...commonTools, ...mcp.getTools(), createScheduleTool(scheduler, key.startsWith("web:") ? key.slice(4) : "wechat")]), beforeToolCall })]);
      };
      const session = await Session.open({
        key,
        transcriptPath,
        model: temporary ? backgroundModel : model,
        thinking: temporary ? config.backgroundModel.thinking : config.model.thinking,
        tools: getTools(),
        streamFn: models.streamFn,
        getApiKey,
        buildSystemPrompt: () => prompt.build({ windowLabel: windowLabel(), now: new Date() }),
        beforeToolCall,
        emit: (event) => { if (!temporary) bus.emit({ type: "session", sessionKey: key, event }); },
        onOwnerMessage: temporary ? undefined : () => { if (key === "wechat") wechatInbound++; persona.userMessage(key === "wechat" ? "wechat" : "web"); },
        onOwnerInteraction: temporary ? undefined : async (count) => { for (let i = 0; i < count; i++) persona.interactionCompleted(); await persona.save(); },
        onError: (err) => log.error({ err, session: key }, "session run failed"),
        compaction: { backgroundModel, complete: models.completeSimple, workspace: config.workspace, threshold: config.compaction?.threshold, onError: (err) => log.warn({ err, session: key }, "context compaction failed") },
        onRunEnd: () => memoryIndex.sync().catch((err: unknown) => log.warn({ err }, "memory index sync failed")),
        onDispose: () => live.delete(session),
      });
      live.set(session, getTools);
      return session;
  };
  const sessions = new SessionManager({
    paths,
    bus,
    openSession,
    generateTitle: createTitleGenerator({ model: backgroundModel, complete: models.completeSimple, getApiKey }),
    onError: (err) => log.warn({ err }, "session manager task failed"),
  });
  await sessions.init();
  startupCleanup.push(() => sessions.shutdown());

  const deliver = async (target: string, text: string, source: string, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    const key = target === "wechat" ? target : target.startsWith("web:") ? target : `web:${target}`;
    const session = await sessions.get(key);
    signal.throwIfAborted();
    const abort = () => session.stop();
    signal.addEventListener("abort", abort, { once: true });
    try { session.send(text, source); await session.whenIdle(); } finally { signal.removeEventListener("abort", abort); }
  };
  scheduler = new Scheduler({ dataDir: paths.home, workspace: config.workspace,
    heartbeat: { every: config.heartbeat?.every ?? "30m", activeHours: config.heartbeat?.activeHours ?? ["08:00", "22:00"] },
    memory: { consolidateAt: config.memory?.consolidateAt ?? "03:00" },
    outreach: { enabled: config.persona?.outreach?.enabled ?? true, checkEvery: config.persona?.outreach?.checkEvery ?? "30m" },
    hooks: {
      log: (err) => log.warn({ err }, "scheduled task failed"),
      targetExists: (target) => sessions.listWeb().some((meta) => meta.id === target || `web:${meta.id}` === target),
      deliver: (target, text, kind, signal) => deliver(target, text, kind === "missed" ? "错过的定时任务" : "定时任务", signal),
      runTemporary: async (text, kind, signal) => {
        signal.throwIfAborted();
        const id = randomUUID();
        const transcript = join(paths.sessions, "runs", `${id}.jsonl`);
        const session = await openSession(`run:${id}`, transcript, () => kind === "heartbeat" ? "心跳" : "记忆整理", kind);
        const abort = () => session.stop();
        signal.addEventListener("abort", abort, { once: true });
        try {
          signal.throwIfAborted(); session.send(text, kind); await session.whenIdle(); signal.throwIfAborted();
          if (!session.successfulReply) throw new Error("后台任务未完成");
          return session.successfulReply;
        } finally { signal.removeEventListener("abort", abort); await session.dispose(); live.delete(session); await rm(transcript, { force: true }); }
      },
      deliverHeartbeat: async (text, signal) => { signal.throwIfAborted(); await (await sessions.get("wechat")).injectAssistant(text, signal); },
      checkOutreach: async (signal) => {
        if (!wechat?.available) return;
        const session = await sessions.get("wechat");
        if (!wechat?.available || !persona.shouldOutreach(!session.busy)) { await persona.save(); return; }
        const inboundBefore = wechatInbound;
        signal.throwIfAborted();
        const abort = () => session.stop();
        signal.addEventListener("abort", abort, { once: true });
        try { session.send("主动聊天：结合当前情绪、时段与记忆，自然地开启一个话题。", "主动聊天"); await session.whenIdle(); }
        finally { signal.removeEventListener("abort", abort); }
        if (session.successfulReply && await wechat.replyDelivered()) { persona.outreachSent(wechatInbound !== inboundBefore); await persona.save(); }
      },
    },
  });

  const gateway = new Gateway({
    host: config.web.host,
    port: config.web.port,
    auth: new WebAuth(config.web.token),
    sessions,
    approvals,
    bus,
    config: { read: () => readFile(paths.config, "utf8"), save: (text) => saveConfigText(paths, text) },
    staticDir: opts.staticDir ?? DEFAULT_STATIC_DIR,
    log,
  });
  startupCleanup.push(() => gateway.stop());
  const { port } = await gateway.start();
  wechat = await startWeChatChannel({ config, paths, sessions, approvals, bus, log }).catch((err: unknown) => {
    log.error({ err }, "wechat failed to start; running without wechat");
    return undefined;
  });
  startupCleanup.push(() => wechat?.stop());
  startupCleanup.push(() => scheduler.close());
  await scheduler.start();
  const host = config.web.host.includes(":") ? `[${config.web.host}]` : config.web.host;
  const url = `http://${host}:${port}`;
  log.info({ url, model: `${model.provider}/${model.id}` }, "vexd started");

  const step = async (name: string, fn: () => Promise<void> | void) => {
    try {
      await fn();
    } catch (err) {
      log.error({ err, step: name }, "shutdown step failed");
    }
  };

  return {
    url,
    port,
    async stop() {
      await step("scheduler", () => scheduler.close());
      await step("wechat", () => wechat?.stop());
      await step("sessions", () => sessions.shutdown());
      await step("approvals", () => approvals.dispose());
      await step("MCP", () => mcp.close());
      await step("persona", () => persona.save());
      await step("gateway", () => gateway.stop());
      await step("memory index", () => memoryIndex.close());
      log.info("vexd stopped");
    },
  };
  } catch (error) {
    for (const close of startupCleanup.reverse()) {
      try { await close(); } catch (err) { log.warn({ err }, "startup cleanup failed"); }
    }
    throw error;
  }
}
