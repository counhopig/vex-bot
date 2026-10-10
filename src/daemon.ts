import { readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runWeChat, type WeChatRuntime } from "./channels/wechat/setup.js";
import { ConfigError, parseConfig, saveConfigText } from "./config/load.js";
import { clearReloadError, readReloadError, writePendingReload } from "./config/reload.js";
import { setTimeout as delay } from "node:timers/promises";
import { applySettings, readSettings } from "./config/settings.js";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { VaultConfig, VexConfig } from "./config/schema.js";
import {
  baseInstructionsSection,
  formatNow,
  residentFileSection,
  SystemPromptBuilder,
  timeSection,
  vaultSection,
  wikiSection,
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
import { writeFileAtomic } from "./store/atomic.js";
import { ensureWorkspace, listDailyNotes, readWorkspaceFile, RESIDENT_LINE_LIMITS, residentLimitWarning } from "./workspace/workspace.js";
import { Vault } from "./vault/notes.js";
import { createVaultTools } from "./vault/tools.js";
import { Wiki, type WikiRunContext } from "./wiki/service.js";
import { createWikiInteractiveTools, createWikiWriteTools } from "./wiki/tools.js";
import { Persona } from "./persona/index.js";
import { Scheduler } from "./scheduler/index.js";
import { createFeelTool } from "./tools/feel.js";
import { createScheduleTool } from "./tools/schedule.js";
import { createWebFetchTool, createWebSearchTool } from "./tools/web.js";
import { McpBridge } from "./tools/mcp.js";
import { createDelegateTool } from "./tools/delegate.js";
import { builtinSkillsDirectory, skillsSection } from "./skills/index.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { SessionEvent } from "./core/events.js";

export interface DaemonOptions {
  paths: VexPaths;
  config: VexConfig;
  log: Logger;
  models?: ModelRegistry;
  staticDir?: string;
  /** Restarts the process in place so saved settings take effect; absent where that is unsupported. */
  restart?: () => Promise<void>;
}

export interface Daemon {
  url: string;
  port: number;
  stop(): Promise<void>;
}

let cachedCatalog: { providers: string[]; models: Record<string, string[]> } | undefined;
function catalog() {
  const providers: string[] = getBuiltinProviders();
  cachedCatalog ??= { providers, models: Object.fromEntries(providers.map((name) => [name, getBuiltinModels(name as never).map((entry) => entry.id)])) };
  return cachedCatalog;
}

const DEFAULT_STATIC_DIR = fileURLToPath(new URL("./web/static/", import.meta.url));

export async function startDaemon(opts: DaemonOptions): Promise<Daemon> {
  const { paths, config, log } = opts;
  if (!isLoopback(config.web.host) && !config.web.token) {
    throw new ConfigError("web.token is required when web.host is not a loopback address");
  }
  await ensureWorkspace(config.workspace);

  const models = opts.models ?? createModelRegistry(config.providers);
  const model = models.resolve(config.model);
  const backgroundModel = models.resolve(config.backgroundModel);
  const getApiKey = (provider: string) => models.getApiKey(provider);

  const bus = new EventBus((err) => log.error({ err }, "event listener failed"));
  const approvals = new ApprovalManager({
    onChange: () => bus.emit({ type: "approvals_changed" }),
    workspace: config.workspace,
    onEvent: (event) => (event.type === "denied" ? log.warn : log.info).call(log, { tool: event.toolName, window: event.windowLabel, reason: event.reason }, `approval ${event.type}`),
  });
  const protectedRoots: string[] = [];
  const policy = new ToolPolicy({ workspace: config.workspace, overrides: config.toolPolicy, protectedRoots });
  const memoryIndex = await MemoryIndex.open({ databasePath: join(paths.home, "index.sqlite"), workspace: config.workspace, sessions: paths.sessions, onWarning: (message) => log.warn(message) });
  const startupCleanup: (() => Promise<void> | void)[] = [() => approvals.dispose(), () => memoryIndex.close()];
  try {
  const persona = await Persona.open({ path: join(paths.home, "state", "mood.json"), sleep: config.persona?.sleep,
    outreach: config.persona?.outreach, warn: (message) => log.warn(message) });
  let scheduler: Scheduler;
  let wechatRuntime: WeChatRuntime | undefined;
  let wechatInbound = 0;
  const live = new Map<Session, () => AgentTool<any>[]>();
  const mcp = new McpBridge(config.mcpServers ?? {}, {
    onToolsChanged: () => { for (const [session, getTools] of live) session.setTools(getTools()); },
    onError: (server, err) => log.warn({ server, err }, "MCP connection failed"),
    onConnected: (server, tools) => log.info({ server, tools }, "MCP server connected"),
  });
  startupCleanup.push(() => mcp.close());
  await mcp.start();
  let wiki: Wiki | undefined;
  let wikiRepoRoot: string | null = null;
  let runWikiAgent!: (prompt: string, context: WikiRunContext, signal: AbortSignal) => Promise<string>;
  const vault = config.vault ? new Vault({ home: paths.home, config: config.vault, root: config.wiki?.enabled ? () => wikiRepoRoot : undefined, onWarning: (message) => log.warn(message) }) : undefined;
  const commonTools = [...createCoreTools({ workspace: config.workspace, bashEnvPassthrough: config.bashEnvPassthrough, configPath: paths.config }),
    createMemorySearchTool(memoryIndex), createFeelTool(persona), createWebFetchTool(), createWebSearchTool(config.webSearch),
    ...(vault ? createVaultTools(vault) : [])];
  const prompt = new SystemPromptBuilder([
    baseInstructionsSection(config.workspace),
    residentFileSection({ workspace: config.workspace, file: "SOUL.md", maxLines: RESIDENT_LINE_LIMITS["SOUL.md"]! }),
    residentFileSection({ workspace: config.workspace, file: "USER.md", maxLines: RESIDENT_LINE_LIMITS["USER.md"]! }),
    () => `## Mood and rest hours\n${persona.describe()}`,
    residentFileSection({ workspace: config.workspace, file: "MEMORY.md", maxLines: RESIDENT_LINE_LIMITS["MEMORY.md"]! }),
    skillsSection(config.workspace, undefined, (message) => log.warn(message)),
    ...(vault ? [vaultSection()] : []),
    ...(wiki ? [wikiSection()] : []),
    timeSection(),
  ]);

  const runStarted = new Map<string, number>();
  const logSessionEvent = (key: string, event: SessionEvent) => {
    switch (event.kind) {
      case "user_message":
        log.info({ session: key, source: event.source, chars: event.text.length }, "message received");
        break;
      case "busy":
        if (event.busy) {
          runStarted.set(key, Date.now());
          log.info({ session: key, source: event.source }, "run started");
        } else {
          log.info({ session: key, ms: Date.now() - (runStarted.get(key) ?? Date.now()) }, "run finished");
          runStarted.delete(key);
        }
        break;
      case "tool_start":
        log.info({ session: key, tool: event.toolName, summary: event.summary.slice(0, 120) }, "tool call");
        break;
      case "tool_end":
        (event.isError ? log.warn : log.debug).call(log, { session: key, tool: event.toolName }, event.isError ? "tool failed" : "tool finished");
        break;
      case "assistant_message":
        (event.stopReason === "error" || event.stopReason === "aborted" ? log.warn : log.info).call(log, { session: key, chars: event.text.length, stopReason: event.stopReason }, "reply");
        break;
      case "error":
        log.warn({ session: key, message: event.message }, "run error");
        break;
    }
  };

  const openSession = async (key: string, transcriptPath: string, windowLabel: () => string, temporary: false | "heartbeat" | "consolidation" | "wiki" = false, wikiContext?: WikiRunContext): Promise<Session> => {
      const gate = createToolGate({ policy, approvals, sessionKey: key, windowLabel });
      const workspacePolicy = new ToolPolicy({ workspace: config.workspace, overrides: {} });
      const beforeToolCall: NonNullable<Parameters<typeof Session.open>[0]["beforeToolCall"]> = async (ctx, signal) => {
        if (temporary === "consolidation") {
          if (ctx.toolCall.name === "memory_search") return;
          const args = ctx.args as { path?: string };
          if (workspacePolicy.decide("write", { path: args.path ?? "." }) !== "allow") return { block: true, reason: "Memory consolidation may only touch workspace files." };
          return;
        }
        return gate(ctx, signal);
      };
      const getTools = (): AgentTool<any>[] => {
        if (temporary === "consolidation") return policy.filter(commonTools.filter((tool) => ["read", "write", "edit", "grep", "find", "memory_search"].includes(tool.name)));
        if (temporary === "wiki") {
          const readTools = commonTools.filter((tool) => ["vault_search", "vault_read"].includes(tool.name));
          return policy.filter([...readTools, ...createWikiWriteTools(wikiContext!)]);
        }
        const base = policy.filter([...commonTools, ...mcp.getTools(), createScheduleTool(scheduler, key.startsWith("web:") ? key.slice(4) : "wechat"), ...(wiki ? createWikiInteractiveTools(wiki) : [])]);
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
        emit: (event) => { if (!temporary) { logSessionEvent(key, event); bus.emit({ type: "session", sessionKey: key, event }); } },
        onOwnerMessage: temporary ? undefined : () => { if (key === "wechat") wechatInbound++; persona.userMessage(key === "wechat" ? "wechat" : "web"); },
        onOwnerInteraction: temporary ? undefined : async (count) => { for (let i = 0; i < count; i++) persona.interactionCompleted(); await persona.save(); },
        onError: (err) => log.error({ err, session: key }, "session run failed"),
        compaction: { backgroundModel, complete: models.completeSimple, workspace: config.workspace, threshold: config.compaction?.threshold, onError: (err) => log.warn({ err, session: key }, "context compaction failed"), onCompact: (info) => log.info({ session: key, ...info }, "context compacted") },
        onRunEnd: () => memoryIndex.sync().catch((err: unknown) => log.warn({ err }, "memory index sync failed")),
        onDispose: () => live.delete(session),
      });
      live.set(session, getTools);
      return session;
  };
  runWikiAgent = async (prompt, context, signal) => {
    signal.throwIfAborted();
    const id = randomUUID();
    const transcript = join(paths.sessions, "runs", `${id}.jsonl`);
    const session = await openSession(`run:${id}`, transcript, () => "wiki", "wiki", context);
    const abort = () => session.stop();
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      session.send(prompt, "wiki");
      await session.whenIdle();
      signal.throwIfAborted();
      if (!session.successfulReply) throw new Error("The wiki run did not finish");
      return session.successfulReply;
    } finally {
      signal.removeEventListener("abort", abort);
      await session.dispose();
      live.delete(session);
      await rm(transcript, { force: true });
    }
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

  if (config.wiki?.enabled && config.vault?.url) {
    wiki = new Wiki({
      home: paths.home,
      vault: config.vault as VaultConfig & { url: string },
      branch: config.vault.branch,
      maxNotesPerRun: config.wiki.maxNotesPerRun,
      notifyEnabled: config.wiki.notify,
      notify: async (text) => { await (await sessions.get("wechat")).injectAssistant(text, new AbortController().signal); },
      runAgent: (prompt, context, signal) => runWikiAgent(prompt, context, signal),
      readSkill: () => readFile(join(builtinSkillsDirectory(), "llm-wiki", "SKILL.md"), "utf8").catch(() => ""),
      onWarning: (message) => log.warn(message),
    });
    await wiki.init();
    wikiRepoRoot = wiki.root;
    protectedRoots.push(wikiRepoRoot);
    startupCleanup.push(() => wiki?.close());
  }

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
    ...(wiki && config.wiki ? { wiki: { enabled: config.wiki.enabled, every: config.wiki.every, status: async () => (await wiki!.status()).bootstrap, nextAttemptAt: () => wiki!.nextAttemptAt(), bootstrap: async (signal: AbortSignal) => { await wiki!.run({ kind: "bootstrap" }, signal); }, run: async (signal: AbortSignal) => { await wiki!.run({ kind: "scheduled" }, signal); } } } : {}),
    hooks: {
      log: (err) => log.warn({ err }, "scheduled task failed"),
      targetExists: (target) => sessions.listWeb().some((meta) => meta.id === target || `web:${meta.id}` === target),
      deliver: (target, text, kind, signal) => { log.info({ target, kind }, "scheduled message"); return deliver(target, text, kind === "missed" ? "missed scheduled task" : "scheduled task", signal); },
      runTemporary: async (text, kind, signal) => {
        signal.throwIfAborted();
        const id = randomUUID();
        const startedAt = Date.now();
        log.info({ kind }, "background run started");
        const transcript = join(paths.sessions, "runs", `${id}.jsonl`);
        const session = await openSession(`run:${id}`, transcript, () => kind === "heartbeat" ? "heartbeat" : "memory consolidation", kind);
        const abort = () => session.stop();
        signal.addEventListener("abort", abort, { once: true });
        try {
          signal.throwIfAborted(); session.send(text, kind); await session.whenIdle(); signal.throwIfAborted();
          if (!session.successfulReply) throw new Error("The background task did not finish");
          log.info({ kind, ms: Date.now() - startedAt, chars: session.successfulReply.length }, "background run finished");
          return session.successfulReply;
        } finally { signal.removeEventListener("abort", abort); await session.dispose(); live.delete(session); await rm(transcript, { force: true }); }
      },
      deliverHeartbeat: async (text, signal) => { signal.throwIfAborted(); log.info({ chars: text.length }, "heartbeat reported to the owner"); await (await sessions.get("wechat")).injectAssistant(text, signal); },
      checkOutreach: async (signal) => {
        const wechat = wechatRuntime?.channel;
        if (!wechat?.available) return;
        const session = await sessions.get("wechat");
        if (!wechat.available || !persona.shouldOutreach(!session.busy)) { await persona.save(); return; }
        const inboundBefore = wechatInbound;
        signal.throwIfAborted();
        const abort = () => session.stop();
        signal.addEventListener("abort", abort, { once: true });
        log.info("proactive chat started");
        try { session.send(persona.outreachPrompt(formatNow(new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone)), "proactive chat"); await session.whenIdle(); }
        finally { signal.removeEventListener("abort", abort); }
        if (session.successfulReply && await wechat.replyDelivered()) { persona.outreachSent(wechatInbound !== inboundBefore); await persona.save(); }
      },
    },
  });

  let restarting = false;
  const scheduleRestart = (): boolean => {
    if (!opts.restart) return false;
    if (restarting) return true;
    restarting = true;
    void (async () => {
      await delay(400);
      if ([...live.keys()].some((session) => session.busy)) log.info("waiting for running turns to finish before restarting");
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && [...live.keys()].some((session) => session.busy)) await delay(500);
      await opts.restart!();
    })().catch((err: unknown) => { restarting = false; log.error({ err }, "applying settings by restart failed"); });
    return true;
  };
  const ensureStartable = (text: string) => {
    const next = parseConfig(text, paths);
    const registry = opts.models ?? createModelRegistry(next.providers);
    try { registry.resolve(next.model); registry.resolve(next.backgroundModel); }
    catch (err) { throw new ConfigError(`The model cannot be used: ${err instanceof Error ? err.message : String(err)}`); }
  };
  const commitConfig = async (before: string, text: string, restartRequired: boolean, keys?: string[]): Promise<boolean> => {
    ensureStartable(text);
    if (restartRequired && opts.restart) await writePendingReload(paths, before);
    await saveConfigText(paths, text);
    await clearReloadError(paths);
    const restarting = restartRequired && scheduleRestart();
    log.info({ keys, restartRequired, restarting }, "configuration saved");
    return restarting;
  };

  const gateway = new Gateway({
    host: config.web.host,
    port: config.web.port,
    auth: new WebAuth(config.web.token),
    sessions,
    approvals,
    bus,
    config: {
      read: () => readFile(paths.config, "utf8"),
      save: async (text) => {
        const before = await readFile(paths.config, "utf8");
        return { restarting: await commitConfig(before, text, text !== before) };
      },
    },
    schedules: {
      list: () => ({
        tasks: scheduler.list(),
        targets: [{ id: "wechat", label: "WeChat" }, ...sessions.listWeb().map((meta) => ({ id: meta.id, label: meta.title }))],
      }),
      save: async ({ id, ...input }) => {
        const saved = id ? await scheduler.update(id, input) : await scheduler.create(input);
        log.info({ name: saved.name, enabled: saved.enabled }, id ? "scheduled task updated" : "scheduled task created");
        return saved;
      },
      remove: async (id) => {
        if (!await scheduler.delete(id)) throw new Error("No such scheduled task");
        log.info({ id }, "scheduled task deleted");
      },
    },
    status: async () => {
      const mood = persona.snapshot();
      const channel = wechatRuntime?.channel;
      return {
        model: `${model.provider}/${model.id}`,
        wechat: !config.wechat.enabled ? "disabled" : !channel ? "unlinked" : channel.expired ? "expired" : channel.available ? "connected" : "connecting",
        persona: { energy: Math.round(mood.energy), mood: Math.round(mood.mood), social: Math.round(mood.social), resting: persona.isResting() },
        reloadError: await readReloadError(paths),
      };
    },
    settings: {
      read: async () => ({ ...readSettings(await readFile(paths.config, "utf8")), catalog: catalog() }),
      save: async (patch) => {
        const before = await readFile(paths.config, "utf8");
        const next = applySettings(before, patch, paths);
        const restarting = await commitConfig(before, next.text, next.restartRequired, [...Object.keys(patch.set ?? {}), ...(patch.unset ?? [])]);
        return { restartRequired: next.restartRequired, restarting };
      },
    },
    workspace: { read: (name) => readWorkspaceFile(config.workspace, name), notes: () => listDailyNotes(config.workspace), save: async (name, text) => { await writeFileAtomic(join(config.workspace, name), text, 0o644); return { warning: residentLimitWarning(name, text) }; } },
    staticDir: opts.staticDir ?? DEFAULT_STATIC_DIR,
    log,
  });
  startupCleanup.push(() => gateway.stop());
  const { port } = await gateway.start();
  wechatRuntime = await runWeChat({ config, paths, sessions, approvals, bus, log });
  startupCleanup.push(() => wechatRuntime?.stop());
  startupCleanup.push(() => scheduler.close());
  await scheduler.start();
  const host = config.web.host.includes(":") ? `[${config.web.host}]` : config.web.host;
  const url = `http://${host}:${port}`;
  log.info({
    url,
    model: `${model.provider}/${model.id}`,
    backgroundModel: `${backgroundModel.provider}/${backgroundModel.id}`,
    wechat: config.wechat.enabled,
    mcpServers: Object.keys(config.mcpServers ?? {}).length,
    webSearch: config.webSearch?.provider,
    speechToText: !!config.stt,
    heartbeat: config.heartbeat?.every ?? "30m",
  }, "vexd started");

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
      await step("wechat", () => wechatRuntime?.stop());
      await step("sessions", () => sessions.shutdown());
      await step("approvals", () => approvals.dispose());
      await step("MCP", () => mcp.close());
      await step("persona", () => persona.save());
      await step("gateway", () => gateway.stop());
      await step("memory index", () => memoryIndex.close());
      await step("wiki", () => wiki?.close());
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
