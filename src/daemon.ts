import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
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
import { ApprovalManager } from "./policy/approvals.js";
import { createToolGate } from "./policy/gate.js";
import { ToolPolicy } from "./policy/policy.js";
import { createModelRegistry, type ModelRegistry } from "./providers/models.js";
import { createCoreTools } from "./tools/registry.js";
import { ensureWorkspace } from "./workspace/workspace.js";

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
  const tools = policy.filter(
    createCoreTools({ workspace: config.workspace, bashEnvPassthrough: config.bashEnvPassthrough }),
  );
  const prompt = new SystemPromptBuilder([
    baseInstructionsSection(config.workspace),
    residentFileSection({ workspace: config.workspace, file: "SOUL.md", maxLines: 200 }),
    residentFileSection({ workspace: config.workspace, file: "USER.md", maxLines: 200 }),
    residentFileSection({ workspace: config.workspace, file: "MEMORY.md", maxLines: 100 }),
    timeSection(),
  ]);

  const sessions = new SessionManager({
    paths,
    bus,
    openSession: (key, transcriptPath, windowLabel) =>
      Session.open({
        key,
        transcriptPath,
        model,
        thinking: config.model.thinking,
        tools,
        streamFn: models.streamFn,
        getApiKey,
        buildSystemPrompt: () => prompt.build({ windowLabel: windowLabel(), now: new Date() }),
        beforeToolCall: createToolGate({ policy, approvals, sessionKey: key, windowLabel }),
        emit: (event) => bus.emit({ type: "session", sessionKey: key, event }),
        onError: (err) => log.error({ err, session: key }, "session run failed"),
      }),
    generateTitle: createTitleGenerator({ model: backgroundModel, complete: models.completeSimple, getApiKey }),
    onError: (err) => log.warn({ err }, "session manager task failed"),
  });
  await sessions.init();

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
  const { port } = await gateway.start();
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
      await step("sessions", () => sessions.shutdown());
      await step("approvals", () => approvals.dispose());
      await step("gateway", () => gateway.stop());
      log.info("vexd stopped");
    },
  };
}
