import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runWeChat, type WeChatRuntime } from "./channels/wechat/setup.js";
import { ConfigError, parseConfig, saveConfigText } from "./config/load.js";
import { clearReloadError, readReloadError, writePendingReload } from "./config/reload.js";
import { configuredSecrets } from "./config/secrets.js";
import { setTimeout as delay } from "node:timers/promises";
import { applyLiveSettings, applySettings, readSettings } from "./config/settings.js";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { VaultConfig, VexConfig } from "./config/schema.js";
import { formatNow } from "./context/prompt.js";
import { EventBus } from "./core/events.js";
import type { Session } from "./core/session.js";
import { DEVICE_SESSION_KEY, SessionManager, WECHAT_SESSION_KEY } from "./core/sessionManager.js";
import { DeviceChannel } from "./channels/device/channel.js";
import { createTitleGenerator } from "./core/title.js";
import { isLoopback, WebAuth } from "./gateway/auth.js";
import { Gateway } from "./gateway/server.js";
import type { Logger } from "./logger.js";
import type { VexPaths } from "./paths.js";
import { withFileLock } from "./store/fileLock.js";
import { MemoryIndex } from "./index/memory.js";
import { createMemorySearchTool } from "./index/tool.js";
import { ApprovalManager } from "./policy/approvals.js";
import { ToolPolicy } from "./policy/policy.js";
import { createModelRegistry, type ModelRegistry } from "./providers/models.js";
import type { DecisionJudge } from "./policy/judge.js";
import { maxUserPromptBytes } from "./context/budget.js";
import { createCoreTools } from "./tools/registry.js";
import { ensureWorkspace, listDailyNotes, readWorkspaceFile, residentLimitWarning, saveWorkspaceFile } from "./workspace/workspace.js";
import { Vault } from "./vault/notes.js";
import { createVaultTools } from "./vault/tools.js";
import { Wiki, type WikiRunContext } from "./vault/wiki/service.js";
import type { GitRunner } from "./vault/wiki/git.js";
import { unresolvedWikiWrites } from "./vault/wiki/tools.js";
import { Persona } from "./persona/index.js";
import { Scheduler } from "./scheduler/index.js";
import { createFeelTool } from "./tools/feel.js";
import { createWebFetchTool, createWebSearchTool, type PageRequest } from "./tools/web.js";
import { McpBridge } from "./tools/mcp.js";
import { builtinSkillsDirectory } from "./skills/index.js";
import { readOriginalSource, readPlatformOriginalSource, type OriginalSource } from "./links/source.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { TraceStore } from "./trace/store.js";
import { createSessionFactory, TEMPORARY_WINDOW_LABELS } from "./sessionFactory.js";
import { ShutdownPlan } from "./shutdown.js";

export interface DaemonOptions {
  paths: VexPaths;
  config: VexConfig;
  log: Logger;
  models?: ModelRegistry;
  staticDir?: string;
  /** Restarts the process in place so saved settings take effect; absent where that is unsupported. */
  restart?: () => Promise<void>;
  /** Git transport override for isolated local repository integration tests. */
  wikiGitRunner?: GitRunner;
  /** Source reader override for isolated Wiki integrations. */
  wikiSourceResolver?: (url: string, signal: AbortSignal) => Promise<OriginalSource>;
  /** Decision override for isolated request-action integration tests. */
  decisionJudge?: DecisionJudge;
  /** Public page request override for isolated WebChat and Wiki integration tests. */
  webPageRequest?: PageRequest;
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
  const deviceToken = config.device?.token;

  const models = opts.models ?? createModelRegistry(config.providers);
  const model = models.resolve(config.model);
  const backgroundModel = models.resolve(config.backgroundModel);
  const getApiKey = (provider: string) => models.getApiKey(provider);
  const secrets = () => {
    const modelKey = getApiKey(model.provider);
    return modelKey ? [...configuredSecrets(config), modelKey] : configuredSecrets(config);
  };

  const bus = new EventBus((err) => log.error({ err }, "event listener failed"));
  const approvals = new ApprovalManager({
    everyCall: WIKI_PUBLISHING_TOOLS,
    onChange: () => bus.emit({ type: "approvals_changed" }),
    workspace: config.workspace,
    onEvent: (event) => (event.type === "denied" ? log.warn : log.info).call(log, { tool: event.toolName, window: event.windowLabel, reason: event.reason }, `approval ${event.type}`),
  });
  const protectedRoots: string[] = [];
  const policy = new ToolPolicy({ workspace: config.workspace, overrides: config.toolPolicy, protectedRoots, readableRoots: [builtinSkillsDirectory()] });
  const memoryIndex = await MemoryIndex.open({ databasePath: join(paths.home, "index.sqlite"), workspace: config.workspace, sessions: paths.sessions, onWarning: (message) => log.warn(message) });
  const shutdown = new ShutdownPlan(log);
  shutdown.add("approvals", () => approvals.dispose());
  shutdown.add("memory index", () => memoryIndex.close());
  try {
    const traces = new TraceStore({ dir: paths.traces, secrets, onWarning: (message) => log.warn(message) });
    await traces.open();
    shutdown.add("traces", () => traces.flush());
    const persona = await Persona.open({ path: join(paths.home, "state", "mood.json"), sleep: config.persona?.sleep,
      outreach: config.persona?.outreach, warn: (message) => log.warn(message) });
    shutdown.add("persona", () => persona.save());
    let scheduler: Scheduler;
    let wechatRuntime: WeChatRuntime | undefined;
    let wechatInbound = 0;
    const live = new Map<Session, () => AgentTool<any>[]>();
    const mcp = new McpBridge(config.mcpServers ?? {}, {
      onToolsChanged: () => { for (const [session, getTools] of live) session.setTools(getTools()); },
      onError: (server, err) => log.warn({ server, err }, "MCP connection failed"),
      onConnected: (server, tools) => log.info({ server, tools }, "MCP server connected"),
    });
    shutdown.add("MCP", () => mcp.close());
    await mcp.start();
    // The vault and its wiki share one clone: with the wiki on, vault reads go through the wiki's copy.
    const wikiConfig = config.vault?.url ? config.vault.wiki : undefined;
    const wiki: Wiki | undefined = wikiConfig ? new Wiki({
      home: paths.home,
      vault: config.vault as VaultConfig & { url: string },
      branch: config.vault?.branch,
      maxNotesPerRun: wikiConfig.maxNotesPerRun,
      notifyEnabled: wikiConfig.notify,
      notify: async (text) => { await (await sessions.get("wechat")).enqueueAssistant(text); },
      runAgent: (prompt, context, signal) => runTemporary("wiki", prompt, signal, (session) => wikiReply(session, context), context),
      sourceSegmentBudget: async (prefix, context) => {
        const tools = wikiTools(context);
        const systemPrompt = await wikiPrompt(() => tools).build({ windowLabel: TEMPORARY_WINDOW_LABELS.wiki, now: new Date() });
        return maxUserPromptBytes(backgroundModel, systemPrompt, tools, prefix);
      },
      ...(opts.wikiGitRunner ? { run: opts.wikiGitRunner } : {}),
      onWarning: (message) => log.warn(message),
    }) : undefined;
    const vault = config.vault ? new Vault({ home: paths.home, config: config.vault, ...(wiki ? { copy: wiki.notesCopy } : {}), onWarning: (message) => log.warn(message) }) : undefined;
    const linkReading = (signal: AbortSignal, request?: PageRequest) => ({
      signal,
      ...(request ? { request } : {}),
      sessdata: config.links?.bilibili?.sessdata || process.env.BILIBILI_SESSDATA,
      ...(config.stt ? { stt: config.stt } : {}),
    });
    const wikiSourceResolver = opts.wikiSourceResolver ?? ((url: string, signal: AbortSignal) => readOriginalSource(url, linkReading(signal)));
    const commonTools = [...createCoreTools({ workspace: config.workspace, bashEnvPassthrough: config.bashEnvPassthrough, configPath: paths.config }),
      createMemorySearchTool(memoryIndex), createFeelTool(persona), createWebFetchTool({
        ...(opts.webPageRequest ? { request: opts.webPageRequest } : {}),
        sourceResolver: (url, signal, request) => readPlatformOriginalSource(url, linkReading(signal, request)),
      }), createWebSearchTool(config.webSearch),
      ...(vault ? createVaultTools(vault) : [])];
    const { openSession, runTemporary, wikiTools, wikiPrompt } = createSessionFactory({
      paths, config, log, models, model, backgroundModel, getApiKey, secrets, bus, approvals, policy, memoryIndex, traces, persona, mcp, commonTools, vault, wiki, wikiSourceResolver,
      scheduler: () => scheduler, live,
      ...(opts.decisionJudge ? { decisionJudge: opts.decisionJudge } : {}),
      onOwnerMessage: (key) => { if (key === "wechat") wechatInbound++; },
    });
    const sessions = new SessionManager({
      paths,
      bus,
      openSession,
      generateTitle: createTitleGenerator({ model: backgroundModel, complete: models.completeSimple, getApiKey }),
      onError: (err) => log.warn({ err }, "session manager task failed"),
      // A WebChat session waiting for the owner's approval stays open until the answer arrives.
      retain: (key) => approvals.pending().some((request) => request.sessionKey === key),
      ...(deviceToken ? { deviceLabel: config.device!.label } : {}),
    });
    await sessions.init();
    shutdown.add("sessions", () => sessions.shutdown());
    const device = deviceToken ? new DeviceChannel({ sessions, approvals, bus, log }) : undefined;
    if (device) {
      device.start();
      shutdown.add("device", () => device.stop());
    }

    if (wiki) {
      protectedRoots.push(wiki.root);
      shutdown.add("wiki", () => wiki.close());
    }
    const deliver = async (target: string, text: string, source: string, signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();
      const key = target === WECHAT_SESSION_KEY || target === DEVICE_SESSION_KEY ? target : target.startsWith("web:") ? target : `web:${target}`;
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
      ...(wikiConfig ? { wiki: { every: wikiConfig.every } } : {}),
      hooks: {
        log: (err) => log.warn({ err }, "scheduled task failed"),
        targetExists: (target) => (target === DEVICE_SESSION_KEY && !!device) || sessions.listWeb().some((meta) => meta.id === target || `web:${meta.id}` === target),
        deliver: (target, text, kind, signal) => { log.info({ target, kind }, "scheduled message"); return deliver(target, text, kind === "missed" ? "missed scheduled task" : "scheduled task", signal); },
        runTemporary: async (text, kind, signal) => {
          signal.throwIfAborted();
          const startedAt = Date.now();
          log.info({ kind }, "background run started");
          const reply = await runTemporary(kind, text, signal, (session) => {
            if (!session.successfulReply) throw new Error("The background task did not finish");
            return session.successfulReply;
          });
          log.info({ kind, ms: Date.now() - startedAt, chars: reply.length }, "background run finished");
          return reply;
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
        wikiWork: async (now, cadenceDue) => wiki ? wiki.dueWork(now, cadenceDue) : null,
        runWiki: async (work, signal) => { await wiki?.run({ kind: work }, signal); },
      },
    });
    shutdown.add("scheduler", () => scheduler.close());

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
      if (!restartRequired) applyLiveSettings(config, parseConfig(text, paths));
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
        save: (text, base) => withFileLock(paths.config, async () => {
          const before = await readFile(paths.config, "utf8");
          if (base !== undefined && base !== before) throw new ConfigError("Configuration changed after it was opened; reload it before saving");
          return { restarting: await commitConfig(before, text, text !== before) };
        }),
      },
      schedules: {
        list: () => ({
          tasks: scheduler.list(),
          targets: [{ id: "wechat", label: "WeChat" }, ...(device ? [{ id: DEVICE_SESSION_KEY, label: config.device!.label }] : []),
            ...sessions.listWeb().map((meta) => ({ id: meta.id, label: meta.title }))],
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
        save: (patch) => withFileLock(paths.config, async () => {
          const before = await readFile(paths.config, "utf8");
          const next = applySettings(before, patch, paths);
          const restarting = await commitConfig(before, next.text, next.restartRequired, [...Object.keys(patch.set ?? {}), ...(patch.unset ?? [])]);
          return { restartRequired: next.restartRequired, restarting };
        }),
      },
      workspace: { read: (name) => readWorkspaceFile(config.workspace, name), notes: () => listDailyNotes(config.workspace), save: async (name, text, base) => { await saveWorkspaceFile(config.workspace, name, text, base); return { warning: residentLimitWarning(name, text) }; } },
      traces,
      ...(device && deviceToken ? { device: { token: deviceToken, channel: device } } : {}),
      staticDir: opts.staticDir ?? DEFAULT_STATIC_DIR,
      log,
    });
    shutdown.add("gateway", () => gateway.stop());
    const { port } = await gateway.start();
    wechatRuntime = await runWeChat({ config, paths, sessions, approvals, bus, log,
      onReplyDelivery: (ok, error) => traces.note("wechat", { type: "delivery", ok, ...(error ? { error } : {}) }) });
    shutdown.add("wechat", () => wechatRuntime?.stop());
    wiki?.start();
    await scheduler.start();
    const host = config.web.host.includes(":") ? `[${config.web.host}]` : config.web.host;
    const url = `http://${host}:${port}`;
    log.info({
      url,
      model: `${model.provider}/${model.id}`,
      backgroundModel: `${backgroundModel.provider}/${backgroundModel.id}`,
      wechat: config.wechat.enabled,
      device: !!device,
      mcpServers: Object.keys(config.mcpServers ?? {}).length,
      webSearch: config.webSearch?.provider,
      speechToText: !!config.stt,
      heartbeat: config.heartbeat?.every ?? "30m",
    }, "vexd started");

    return {
      url,
      port,
      async stop() {
        await shutdown.run();
        log.info("vexd stopped");
      },
    };
  } catch (error) {
    await shutdown.run();
    throw error;
  }
}

/** Wiki tools that publish to or rewrite the owner's repository; each call is confirmed. */
const WIKI_PUBLISHING_TOOLS = ["wiki_bootstrap", "wiki_rollback", "wiki_rebuild"];

/** A wiki compilation run succeeds only with a checked reply and no path whose latest wiki write failed. */
function wikiReply(session: Session, context: WikiRunContext): string {
  const outcome = session.completionOutcome;
  const failedPaths = unresolvedWikiWrites(context);
  if (failedPaths.length) throw new Error(`Wiki compilation tool failed for ${failedPaths.join(", ")}`);
  const reply = session.successfulReply;
  if (outcome.successful && reply) return reply;
  throw new Error(outcome.failureReason ?? "The wiki run did not finish");
}
