/**
 * WebServer — Express/HTTP bootstrap + channel lifecycle orchestration.
 *
 * This is the third slice of the archived gateway/server.ts (rewrite-plan §45):
 *   (1) handleMessage / getAgentForContext / getContextWebUserId → Dispatcher
 *   (2) sendReply → OutboundDeliver
 *   (3) Express setup, route mounting, channel lifecycle, MessageDeduplicator,
 *       createKeyedSerializer, shutdown steps → this file.
 *
 * Responsibilities:
 *  - Create the Express app + HTTP server, middleware, and routes:
 *      /health, /api/auth/*, /api/admin/users, (static — injected by part 6d),
 *      404 + error handler.
 *  - Wire the WebChat channel: WebSocket /ws, auth, session store, Dispatcher
 *    dispatch, and the four WS method-handler factories (sessions, logs,
 *    weixin-login, admin) built in part 6b.
 *  - Wire the personal-WeChat channel: single-user mode when web auth is
 *    disabled; per-user channels (activate/deactivate/restore) when enabled.
 *  - Serialize per-user channel ops (createKeyedSerializer), dedupe inbound
 *    WeChat messages (MessageDeduplicator), and run fault-isolated shutdown.
 *
 * Security behaviors preserved from the archive:
 *  - Loopback-only bind by default (resolveBindHost never returns 0.0.0.0
 *    unless the operator explicitly configured server.host).
 *  - /api/auth/* and /api/admin/users mount the WebAuthStore route handlers
 *    (login/register/session cookies are the WebAuthStore's responsibility).
 *  - The personal-WeChat channel only starts in single-user mode (webAuth
 *    disabled); with web auth enabled the per-user channel lifecycle applies.
 *  - Shutdown runs every teardown step even when an earlier step throws.
 */

import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from "http";
import NodeCache from "node-cache";
import { getChildLogger } from "../utils/logger.js";
import type { SystemConfig } from "./routes/config.js";
import type { WeixinConfig } from "../channels/wechat/WeChatChannel.js";
import { createWeChatChannel, type WeChatChannel } from "../channels/wechat/WeChatChannel.js";
import type { ChannelRegistry } from "../channels/ChannelAdapter.js";
import { WebChatChannel } from "../channels/webchat/WebChatChannel.js";
import type { WsMethodHandler } from "../channels/webchat/WebChatChannel.js";
import { createSessionHandlers } from "./routes/sessions.js";
import { createLogStreamHandlers } from "./routes/log-stream-handlers.js";
import { createWeixinLoginHandlers } from "./routes/weixin-login.js";
import { createAdminHandlers } from "./routes/admin.js";
import type { WebAuthStore } from "./routes/auth.js";
import { installWebAuthRoutes } from "./routes/auth.js";
import type { FileSessionStore } from "../sessions/store.js";
import type { LogStreamer } from "./routes/log-stream.js";
import type { WeixinCredentialStore } from "./WeixinCredentialStore.js";
import type { ConfigStore } from "../config/ConfigStore.js";
import type { Dispatcher } from "../dispatcher/Dispatcher.js";
import type { AgentRegistry } from "../agent/AgentRegistry.js";
import type { Agent } from "../agent/Agent.js";
import type { OutboundDeliver } from "../outbound/OutboundDeliver.js";
import type { InboundMessageContext } from "../channels/ChannelAdapter.js";

const logger = getChildLogger("web-server");

/**
 * Resolve the bind address. Defaults to loopback (never 0.0.0.0) so an unset or
 * blank host is not silently exposed on every interface — real exposure must be
 * opted into with an explicit host (server.host BREAKING change preserved).
 */
export function resolveBindHost(host?: string): string {
  const trimmed = host?.trim();
  return trimmed ? trimmed : "127.0.0.1";
}

/**
 * Bounded, TTL'd message-id dedup. NodeCache.set() throws ECACHEFULL once
 * maxKeys is reached; this fails open (process the message) rather than letting
 * that throw escape into the channel message loop.
 */
export class MessageDeduplicator {
  private readonly cache: NodeCache;

  constructor(options?: { ttlSeconds?: number; maxKeys?: number }) {
    this.cache = new NodeCache({
      stdTTL: options?.ttlSeconds ?? 300,
      maxKeys: options?.maxKeys ?? 10000,
      useClones: false,
    });
  }

  isDuplicate(key: string): boolean {
    if (this.cache.has(key)) return true;
    try {
      this.cache.set(key, 1);
    } catch (error) {
      // Cache full: fail open. Reprocessing a rare duplicate is far better than
      // throwing out of the message handler and dropping/crashing the loop.
      logger.warn({ error }, "Message dedup cache full; skipping dedup for this message");
    }
    return false;
  }
}

/** Run teardown steps in order, isolating failures so one bad step can't abort the rest. */
export async function runShutdownSteps(
  steps: Array<{ label: string; run: () => Promise<void> | void }>,
): Promise<void> {
  for (const step of steps) {
    try {
      await step.run();
    } catch (error) {
      logger.warn({ error, step: step.label }, "Shutdown step failed; continuing");
    }
  }
}

/** Serialize async tasks per key so operations on the same key never interleave. */
export function createKeyedSerializer(): <T>(key: string, task: () => Promise<T>) => Promise<T> {
  const chains = new Map<string, Promise<unknown>>();
  return <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const prev = chains.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(task);
    chains.set(key, next);
    void next.finally(() => {
      if (chains.get(key) === next) chains.delete(key);
    });
    return next;
  };
}

// ---------------------------------------------------------------------------
// WebServer options
// ---------------------------------------------------------------------------

export interface WebServerOptions {
  /** System config the control panel reads/edits (server.port, webAuth, …). */
  config: SystemConfig;
  /** Path of the runtime config file (saveConfig / WeChat token persistence). */
  configPath: string;
  /** Authentication store + route handlers (/api/auth/*, /api/admin/users). */
  auth: WebAuthStore;
  /** WebChat session store (bindings + transcripts). */
  sessionStore: FileSessionStore;
  /** Shared channel lookup for Dispatcher / Outbound / per-user lifecycle. */
  registry: ChannelRegistry;
  /** YAML-backed config resolution for per-(user, channel) EffectiveConfig. */
  configStore: ConfigStore;
  /** Per-(user, channel) Agent cache. */
  agentRegistry: AgentRegistry<Agent>;
  /** Inbound message entry point. */
  dispatcher: Dispatcher;
  /** Outbound delivery (Dispatcher's deliver callback). */
  outbound: OutboundDeliver;
  /** Backend log tailer for logs.subscribe. */
  logStreamer: LogStreamer;
  /** Per-user WeChat credential rows (restore/activate at startup). */
  credentialStore: WeixinCredentialStore;
  /** Resolve the current channels.weixin section. */
  getWeixinConfig: () => WeixinConfig | undefined;
  /**
   * Optional static asset handler `(req, res) => handled`. Supplied by part 6d
   * (src/web/static). When absent, non-API GETs fall through to 404.
   */
  staticHandler?: (req: IncomingMessage, res: ServerResponse) => boolean;
  /** WebChat heartbeat interval (ms), default 30000. */
  heartbeatIntervalMs?: number;
  /** WebChat client timeout (ms), default 60000. */
  clientTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// WebServer
// ---------------------------------------------------------------------------

export class WebServer {
  private readonly app: Express;
  private readonly httpServer: HttpServer;
  private readonly options: WebServerOptions;
  private webChat?: WebChatChannel;
  private weixinChannel?: WeChatChannel;
  private readonly userWeixinChannels = new Map<string, WeChatChannel>();
  private readonly dedup = new MessageDeduplicator();
  // Serialize channel activate/deactivate per user so concurrent ops for the
  // same user can't orphan a running channel or delete a just-created one.
  private readonly channelOp = createKeyedSerializer();

  constructor(options: WebServerOptions) {
    this.options = options;
    this.app = express();
    this.httpServer = createServer(this.app);

    this.setupMiddleware();
    this.setupRoutes();
  }

  getApp(): Express {
    return this.app;
  }

  /** Underlying HTTP server (used by tests + WebChatChannel). */
  get server(): HttpServer {
    return this.httpServer;
  }

  // -----------------------------------------------------------------------
  // Routes
  // -----------------------------------------------------------------------

  private setupMiddleware(): void {
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));
    this.app.use((req, res, next) => {
      logger.debug({ method: req.method, path: req.path }, "Incoming request");
      next();
    });
  }

  private setupRoutes(): void {
    const { config, auth, staticHandler } = this.options;

    this.app.get("/health", (req, res) => {
      res.json({ status: "ok", timestamp: new Date().toISOString() });
    });

    const authRoutes = installWebAuthRoutes(auth);
    this.app.get("/api/auth/me", authRoutes.me);
    this.app.post("/api/auth/register", authRoutes.register);
    this.app.post("/api/auth/login", authRoutes.login);
    this.app.post("/api/auth/logout", authRoutes.logout);
    this.app.get("/api/admin/users", authRoutes.listUsers);
    this.app.post("/api/admin/users", authRoutes.createUser);
    this.app.patch("/api/admin/users/:id", authRoutes.updateUser);
    this.app.delete("/api/admin/users/:id", authRoutes.deleteUser);

    if (staticHandler) {
      this.app.use((req, res, next) => {
        const handled = staticHandler(req, res);
        if (!handled) {
          next();
        }
      });
    }

    this.app.use((req, res) => {
      res.status(404).json({ error: "Not found" });
    });

    this.app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
      logger.error({ error: err }, "Unhandled error");
      res.status(500).json({ error: "Internal server error" });
    });
  }

  // -----------------------------------------------------------------------
  // Channel lifecycle
  // -----------------------------------------------------------------------

  /** Wire WebChat + personal-WeChat channels and per-user WeChat channels. */
  async initialize(): Promise<void> {
    const { config, configPath, auth, sessionStore, registry, dispatcher, logStreamer } = this.options;
    const webAuthEnabled = auth.isEnabled;
    const weixinConfig = this.options.getWeixinConfig();

    // WebChat channel (always).
    const handlers: Record<string, WsMethodHandler> = {
      ...createSessionHandlers({ sessionStore }),
      ...createLogStreamHandlers({ logStreamer, webAuthEnabled }),
      ...createWeixinLoginHandlers({
        auth,
        getWeixinConfig: this.options.getWeixinConfig,
        weixinChannel: webAuthEnabled ? undefined : this.weixinChannel,
        onUserWeixinLogin: (userId, login) => this.activateUserWeixinChannel(userId, login),
        onUserWeixinUnbind: (userId) => this.deactivateUserWeixinChannel(userId),
      }),
      ...createAdminHandlers({
        getConfig: () => config,
        configPath,
        auth,
        getProviders: () => [],
        getChannels: () => registry.getAllChannels().map((c) => ({ id: c.id, name: c.id, connected: true })),
        getUptimeMs: () => (this.webChat ? this.webChat.uptime : 0),
        getClientCount: () => (this.webChat ? this.webChat.clientCount : 0),
        getUserWeixinStatus: (userId) => this.getUserWeixinStatus(userId),
        onResetUser: (userId) => this.resetUserRuntime(userId),
      }),
    };

    this.webChat = new WebChatChannel({
      server: this.httpServer,
      auth,
      sessionStore,
      dispatch: (ctx) => dispatcher.dispatch(ctx),
      handlers,
      heartbeatIntervalMs: this.options.heartbeatIntervalMs,
      clientTimeoutMs: this.options.clientTimeoutMs,
    });
    registry.register(this.webChat);
    await this.webChat.initialize();
    logger.info("WebChat channel initialized");

    // Personal-WeChat channel: single-user mode only (webAuth disabled).
    if (weixinConfig && !webAuthEnabled) {
      this.weixinChannel = createWeChatChannel(weixinConfig, { configPath });
      this.weixinChannel.onMessage((ctx) => this.handleChannelMessage(ctx));
      registry.register(this.weixinChannel);
      logger.info("Weixin (Personal WeChat) channel enabled");
    }

    // Restore persisted per-user WeChat logins (webAuth enabled).
    await this.restoreUserWeixinChannels();
    logger.info("WebServer initialized");
  }

  /** Dedupe + dispatch an inbound channel message (WeChat single-user path). */
  private async handleChannelMessage(context: InboundMessageContext): Promise<void> {
    if (this.dedup.isDuplicate(`${context.channelId}:${context.messageId}`)) {
      logger.debug({ channelId: context.channelId, messageId: context.messageId }, "Skipping duplicate message");
      return;
    }
    await this.options.dispatcher.dispatch(context);
  }

  /** Reset a user's runtime after a config save (config.save → onResetUser). */
  private async resetUserRuntime(userId: string): Promise<void> {
    // Config.save originates from the control panel (webchat channel); reset
    // that user's agent so the new settings take effect immediately.
    await this.options.agentRegistry.reset(userId, "webchat");
    logger.debug({ userId }, "User runtime reset after config save");
  }

  /** Per-user WeChat channel status for status.get / control panel. */
  private getUserWeixinStatus(userId: string): { configured: boolean; connected: boolean; accountId?: string } {
    const login = this.options.credentialStore.getByUserId(userId);
    return {
      configured: Boolean(login),
      connected: this.userWeixinChannels.has(userId),
      accountId: login?.accountId,
    };
  }

  /** Start (or restart) the user's personal-WeChat channel. Serialized per user. */
  private activateUserWeixinChannel(userId: string, weixinConfig: WeixinConfig): Promise<void> {
    return this.channelOp(userId, async () => {
      const existing = this.userWeixinChannels.get(userId);
      if (existing) {
        await existing.shutdown();
        this.userWeixinChannels.delete(userId);
      }

      const base = this.options.getWeixinConfig() ?? {};
      const channel = createWeChatChannel({ ...base, ...weixinConfig, enabled: true });
      channel.onMessage((context) => this.handleUserWeixinMessage(userId, context));
      this.userWeixinChannels.set(userId, channel);
      this.options.registry.registerForUser(userId, "weixin", channel);
      await channel.initialize();
      logger.info({ userId, accountId: weixinConfig.accountId }, "User-scoped Weixin channel activated");
    });
  }

  /** Stop the user's personal-WeChat channel. Serialized per user. */
  private deactivateUserWeixinChannel(userId: string): Promise<void> {
    return this.channelOp(userId, async () => {
      const existing = this.userWeixinChannels.get(userId);
      if (!existing) return;
      this.userWeixinChannels.delete(userId);
      this.options.registry.unregisterForUser(userId, "weixin");
      await existing.shutdown();
      logger.info({ userId }, "User-scoped Weixin channel deactivated");
    });
  }

  /** Tag a user-scoped WeChat message with the owning web user, then dedupe + dispatch. */
  private async handleUserWeixinMessage(userId: string, context: InboundMessageContext): Promise<void> {
    if (this.dedup.isDuplicate(`${context.channelId}:${userId}:${context.messageId}`)) {
      logger.debug({ userId, messageId: context.messageId }, "Skipping duplicate user message");
      return;
    }
    await this.options.dispatcher.dispatch({ ...context, webUserId: userId });
  }

  /** Recreate every persisted per-user WeChat channel at startup. */
  private async restoreUserWeixinChannels(): Promise<void> {
    const logins = this.options.credentialStore.list();
    for (const login of logins) {
      try {
        await this.activateUserWeixinChannel(login.userId, {
          token: login.token,
          accountId: login.accountId,
          baseUrl: login.baseUrl,
          enabled: true,
        });
      } catch (error) {
        logger.error({ error, userId: login.userId, accountId: login.accountId }, "Failed to restore user-scoped Weixin channel");
      }
    }
  }

  // -----------------------------------------------------------------------
  // Start / shutdown
  // -----------------------------------------------------------------------

  /** Bind the HTTP server and start listening. */
  async start(): Promise<void> {
    const { port, host } = this.options.config.server as { port?: number; host?: string };
    const bindPort = typeof port === "number" ? port : 3000;
    const bindHost = resolveBindHost(typeof host === "string" ? host : undefined);

    await new Promise<void>((resolve, reject) => {
      this.httpServer.once("error", reject);
      this.httpServer.listen(bindPort, bindHost, () => {
        logger.info({ port: bindPort, host: bindHost }, "WebServer started");
        resolve();
      });
    });

    // Initialize the WeChat channel in the background. Its QR login flow can
    // block for minutes waiting for a scan; awaiting it before listen() would
    // keep the web UI unreachable. Run it detached so a missing/failed login
    // never blocks the server — users can (re)scan from the Control Panel.
    if (this.weixinChannel) {
      this.weixinChannel.initialize().catch((error: unknown) => {
        logger.error({ error }, "Weixin channel initialization failed; web UI remains available");
      });
    }
  }

  /** Fault-isolated teardown: cron, WS, channels, agents, HTTP server. */
  async shutdown(): Promise<void> {
    logger.info("Shutting down WebServer...");
    const userChannels = [...this.userWeixinChannels.values()];
    this.userWeixinChannels.clear();

    await runShutdownSteps([
      { label: "webChat", run: () => this.webChat?.shutdown() },
      { label: "weixinChannel", run: () => this.weixinChannel?.shutdown() },
      ...userChannels.map((channel, i) => ({
        label: `userWeixinChannel[${i}]`,
        run: () => channel.shutdown(),
      })),
      { label: "agentRegistry", run: () => this.options.agentRegistry.shutdown() },
      { label: "httpServer", run: () => { this.httpServer.close(); } },
    ]);
    logger.info("WebServer shut down");
  }
}
