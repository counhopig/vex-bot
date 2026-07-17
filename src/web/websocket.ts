/**
 * WebSocket server - real-time communication
 */

import { WebSocketServer, WebSocket } from "ws";
import type { Server as HttpServer, IncomingMessage } from "http";
import { z } from "zod";
import { getChildLogger } from "../utils/logger.js";
import { generateId } from "../utils/index.js";
import { renderQrSvgDataUri } from "../utils/qr.js";
import type {
  WsFrame,
  WsRequestFrame,
  WsResponseFrame,
  WsEventFrame,
  ChatSendParams,
  ChatDeltaEvent,
  SystemStatus,
  SessionsListParams,
  SessionsHistoryParams,
  SessionsDeleteParams,
  SessionsResetParams,
  SessionsRestoreParams,
  ConfigInfo,
  ConfigSaveParams,
} from "./types.js";
import type { Agent } from "../agents/agent.js";
import type { UserRuntimeManager } from "../agents/user-runtime.js";
import type { VexConfig, WeixinConfig } from "../types/index.js";
import type { WeixinChannel } from "../channels/weixin/index.js";
import {
  WeixinClient,
  DEFAULT_WEIXIN_OC_API_TIMEOUT_MS,
  DEFAULT_WEIXIN_OC_BASE_URL,
  DEFAULT_WEIXIN_OC_BOT_TYPE,
  DEFAULT_WEIXIN_OC_CDN_BASE_URL,
} from "../channels/weixin/client.js";
import { getAllProviders } from "../providers/index.js";
import { getAllChannels } from "../channels/index.js";
import { getSessionStore, type SessionListItem, type TranscriptMessage } from "../sessions/index.js";
import { generateSessionTitle } from "../sessions/title.js";
import { runMessageInterceptors, runResponseObservers } from "../pipeline/index.js";
import {
  extractSystemConfigParams,
  extractUserConfigSettings,
  getConfigInfo,
  getUserConfigInfo,
  saveConfig,
  validateConfig,
} from "./config-handlers.js";
import { LogStreamer } from "./log-stream.js";
import {
  getRequestUser,
  getUserConfigSettings,
  isWebAuthEnabled,
  deleteUserWeixinLogin,
  saveUserConfigSettings,
  saveUserWeixinLogin,
  HttpError,
  type PublicWebUser,
} from "./auth.js";
const logger = getChildLogger("websocket");
const WEBCHAT_SESSION_PREFIX = "webchat:";

/**
 * The backend log stream carries every user's activity (chat previews, session
 * keys, errors). It's an operator/admin view: any authenticated user must not
 * be able to read it. Single-user mode (web auth disabled) has one operator, so
 * there's nothing to gate.
 */
export function canAccessBackendLogs(webAuthEnabled: boolean, role?: string): boolean {
  return !webAuthEnabled || role === "admin";
}

/** Keep the browser UI scoped to sessions created by WebChat itself. */
export function filterWebChatSessions(
  sessions: readonly SessionListItem[],
  limit?: number,
  userId?: string
): SessionListItem[] {
  const prefix = userId ? `${WEBCHAT_SESSION_PREFIX}${userId}:` : WEBCHAT_SESSION_PREFIX;
  const webchatSessions = sessions.filter((session) => session.sessionKey.startsWith(prefix));
  return limit ? webchatSessions.slice(0, limit) : webchatSessions;
}

const EmptyParamsSchema = z.object({}).passthrough().default({});
const ChatSendParamsSchema = z.object({
  // The target session is the client's own restored/active session, never a
  // client-supplied key — bound it so a single message can't be unbounded.
  message: z.string().min(1).max(100_000),
});
const SessionsListParamsSchema = z.object({
  limit: z.number().int().positive().optional(),
  activeMinutes: z.number().positive().optional(),
  search: z.string().optional(),
}).default({});
const SessionKeyParamsSchema = z.object({
  sessionKey: z.string().min(1),
});
const ProviderConfigInfoSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  baseUrl: z.string().optional(),
  hasApiKey: z.boolean(),
  groupId: z.string().optional(),
}).passthrough();
const ChannelConfigInfoSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().optional(),
  hasConfig: z.boolean(),
  enabled: z.boolean().optional(),
  baseUrl: z.string().optional(),
  botType: z.string().optional(),
  hasToken: z.boolean().optional(),
  accountId: z.string().optional(),
}).passthrough();
const PersonaConfigSchema = z.object({
  enabled: z.boolean().optional(),
  persona_name: z.string().optional(),
  persona_base_prompt: z.string().optional(),
  persona_reply_style: z.string().optional(),
  time_awareness_enabled: z.boolean().optional(),
  emotion_enabled: z.boolean().optional(),
  emotion_decay_per_hour: z.number().optional(),
  emotion_recovery_per_reply: z.number().optional(),
  emotion_injection_style: z.string().optional(),
  emotion_decay_cron: z.string().optional(),
  effect_enabled: z.boolean().optional(),
  effect_auto_trigger: z.boolean().optional(),
  todo_enabled: z.boolean().optional(),
  todo_auto_trigger: z.boolean().optional(),
  consolidation_enabled: z.boolean().optional(),
  memory_enabled: z.boolean().optional(),
  memory_max_turns: z.number().int().optional(),
  profile_enabled: z.boolean().optional(),
  reflection_enabled: z.boolean().optional(),
  reflection_trigger_turns: z.number().int().optional(),
  reflection_history_turns: z.number().int().optional(),
  reflection_periodic_cron: z.string().optional(),
  profile_building_enabled: z.boolean().optional(),
  profile_building_trigger_turns: z.number().int().optional(),
  greeting_on_first_chat: z.boolean().optional(),
  goodnight_hint_enabled: z.boolean().optional(),
  proactive_nudge_enabled: z.boolean().optional(),
  proactive_nudge_cron: z.string().optional(),
  rest_enabled: z.boolean().optional(),
  rest_sleep_hour: z.number().optional(),
  rest_wake_hour: z.number().optional(),
  storage_cache_max: z.number().int().optional(),
  debug_log_enabled: z.boolean().optional(),
}).passthrough();
const SkillLearnerConfigSchema = z.object({
  enabled: z.boolean().optional(),
  autoTriggerKeywords: z.array(z.string()).optional(),
  maxLearningTurns: z.number().int().optional(),
  enableAutoLearn: z.boolean().optional(),
  enableProactiveSuggest: z.boolean().optional(),
  proactiveThreshold: z.number().optional(),
  autoDeployToSkills: z.boolean().optional(),
}).passthrough();
const ShareLinkConfigSchema = z.object({
  enabled: z.boolean().optional(),
  responseMode: z.enum(["simple", "detailed"]).optional(),
  includeDescription: z.boolean().optional(),
  includeCover: z.boolean().optional(),
  descriptionMaxLength: z.number().int().optional(),
  bilibiliCookie: z.object({
    sessdata: z.string().optional(),
    biliJct: z.string().optional(),
  }).optional(),
  summarizeProviderId: z.string().optional(),
  sttProviderId: z.string().optional(),
  audioDownloadTimeout: z.number().optional(),
  subtitleMaxLength: z.number().int().optional(),
  llmShortContentThreshold: z.number().optional(),
  llmChunkSize: z.number().int().optional(),
  autoDetect: z.boolean().optional(),
}).passthrough();
const SessionsConfigSchema = z.object({
  type: z.enum(["memory", "file"]).optional(),
  directory: z.string().optional(),
  ttlMs: z.number().int().optional(),
}).passthrough();
const WeatherConfigSchema = z.object({
  weather_provider: z.enum(["wttr", "caiyun"]).optional(),
  caiyun_api_key: z.string().optional(),
  caiyun_api_version: z.enum(["v2.6", "v3"]).optional(),
  wttr_base_url: z.string().optional(),
  default_location: z.string().optional(),
  request_timeout_ms: z.number().int().optional(),
  cache_ttl_ms: z.number().int().optional(),
  hasCaiyunApiKey: z.boolean().optional(),
}).passthrough();
const ConfigSaveParamsSchema = z.object({
  providers: z.record(ProviderConfigInfoSchema).optional(),
  channels: z.record(ChannelConfigInfoSchema).optional(),
  agent: z.object({
    defaultProvider: z.string(),
    defaultModel: z.string(),
    temperature: z.number().optional(),
    maxTokens: z.number().optional(),
    systemPrompt: z.string().optional(),
  }).optional(),
  server: z.object({
    port: z.number().int().positive(),
    host: z.string(),
  }).optional(),
  logging: z.object({
    level: z.enum(["debug", "info", "warn", "error"]),
  }).optional(),
  memory: z.object({
    enabled: z.boolean().optional(),
    directory: z.string().optional(),
    embeddingModel: z.string().optional(),
    embeddingProvider: z.string().optional(),
  }).optional(),
  skills: z.object({
    enabled: z.boolean().optional(),
    userDir: z.string().optional(),
    workspaceDir: z.string().optional(),
    disabled: z.array(z.string()).optional(),
    only: z.array(z.string()).optional(),
  }).optional(),
  persona: PersonaConfigSchema.optional(),
  skillLearner: SkillLearnerConfigSchema.optional(),
  sharelink: ShareLinkConfigSchema.optional(),
  weather: WeatherConfigSchema.optional(),
  sessions: SessionsConfigSchema.optional(),
  rawYaml: z.string().optional(),
}).default({});
const WeixinQrStatusParamsSchema = z.object({
  qrcode: z.string().min(1),
});
const RequestFrameSchema = z.object({
  type: z.literal("req"),
  id: z.string().min(1),
  method: z.string().min(1),
  params: z.unknown().optional(),
});

function formatZodError(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "frame"}: ${issue.message}`).join("; ");
}

function parseRequestFrame(data: string): WsRequestFrame {
  const raw = JSON.parse(data);
  const result = RequestFrameSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid request frame: ${formatZodError(result.error)}`);
  }
  return result.data;
}

function parseParams<T>(schema: z.ZodType<T>, params: unknown): T {
  const result = schema.safeParse(params);
  if (!result.success) {
    throw new Error(`Invalid params: ${formatZodError(result.error)}`);
  }
  return result.data;
}

function getRequestId(data: string): string | undefined {
  try {
    const raw = JSON.parse(data);
    if (raw !== null && typeof raw === "object" && "id" in raw && typeof raw.id === "string") {
      return raw.id;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** WebSocket client */
interface WsClient {
  id: string;
  ws: WebSocket;
  sessionKey: string | null;  // null means session not yet bound
  sessionId: string | null;
  user: PublicWebUser | null;
  lastPing: number;
  /** AbortController for current chat, used for cancellation */
  currentAbortController: AbortController | null;
  /** Detaches this client from the backend log stream, if subscribed. */
  logUnsubscribe: (() => void) | null;
}

/** WebSocket server options */
export interface WsServerOptions {
  server: HttpServer;
  agent: Agent;
  runtimeManager?: UserRuntimeManager;
  config: VexConfig;
  weixinChannel?: WeixinChannel;
  onUserWeixinLogin?: (userId: string, login: WeixinConfig) => Promise<void> | void;
  onUserWeixinUnbind?: (userId: string) => Promise<void> | void;
  getUserWeixinStatus?: (userId: string) => { configured: boolean; connected: boolean; accountId?: string };
  heartbeatInterval?: number;
  clientTimeout?: number;
}

interface PendingUserWeixinLogin {
  userId: string;
  client: WeixinClient;
}

/** WebSocket server class */
export class WsServer {
  private wss: WebSocketServer;
  private clients = new Map<string, WsClient>();
  private agent: Agent;
  private runtimeManager?: UserRuntimeManager;
  private config: VexConfig;
  private weixinChannel?: WeixinChannel;
  private onUserWeixinLogin?: (userId: string, login: WeixinConfig) => Promise<void> | void;
  private onUserWeixinUnbind?: (userId: string) => Promise<void> | void;
  private getUserWeixinStatus?: (userId: string) => { configured: boolean; connected: boolean; accountId?: string };
  private pendingUserWeixinLogins = new Map<string, PendingUserWeixinLogin>();
  // Sessions currently having a title generated, so concurrent replies don't
  // fire duplicate title LLM calls for the same session.
  private titleInFlight = new Set<string>();
  private startTime = Date.now();
  private heartbeatInterval: number;
  private clientTimeout: number;
  private logStreamer = new LogStreamer();

  constructor(options: WsServerOptions) {
    this.agent = options.agent;
    this.runtimeManager = options.runtimeManager;
    this.config = options.config;
    this.weixinChannel = options.weixinChannel;
    this.onUserWeixinLogin = options.onUserWeixinLogin;
    this.onUserWeixinUnbind = options.onUserWeixinUnbind;
    this.getUserWeixinStatus = options.getUserWeixinStatus;
    this.heartbeatInterval = options.heartbeatInterval ?? 30000;
    this.clientTimeout = options.clientTimeout ?? 60000;

    this.wss = new WebSocketServer({
      server: options.server,
      path: "/ws",
    });

    this.wss.on("connection", (ws, req) => {
      this.handleConnection(ws, req);
    });

    // Heartbeat check
    setInterval(() => this.checkHeartbeat(), this.heartbeatInterval);

    logger.info("WebSocket server initialized");
  }

  /** Handle new connection */
  private async handleConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
    const user = getRequestUser(this.config, req);
    if (isWebAuthEnabled(this.config) && !user) {
      ws.close(1008, "Authentication required");
      return;
    }

    const clientId = generateId("client");

    // Don't create session immediately; wait for client to send sessions.restore or chat.send
    const client: WsClient = {
      id: clientId,
      ws,
      sessionKey: null,
      sessionId: null,
      user,
      lastPing: Date.now(),
      currentAbortController: null,
      logUnsubscribe: null,
    };

    this.clients.set(clientId, client);
    logger.info({ clientId, userId: user?.id }, "Client connected");

    // Send welcome message - no session info, wait for client to decide
    this.sendEvent(ws, "connected", {
      clientId,
      version: "1.0.0",
      user,
    });

    ws.on("message", (data) => {
      this.handleMessage(client, data.toString());
    });

    ws.on("close", () => {
      client.logUnsubscribe?.();
      client.logUnsubscribe = null;
      this.clients.delete(clientId);
      logger.info({ clientId, userId: client.user?.id }, "Client disconnected");
    });

    ws.on("error", (error) => {
      logger.error({ clientId, error }, "WebSocket error");
    });

    ws.on("pong", () => {
      client.lastPing = Date.now();
    });
  }

  /** Handle message */
  private async handleMessage(client: WsClient, data: string): Promise<void> {
    try {
      const frame = parseRequestFrame(data);
      await this.handleRequest(client, frame);
    } catch (error) {
      logger.error({ error, data }, "Failed to handle message");
      const id = getRequestId(data);
      if (id) {
        this.sendResponse(client.ws, id, false, undefined, this.toErrorFrame(error, "BAD_REQUEST"));
      }
    }
  }

  /** Handle request */
  private async handleRequest(
    client: WsClient,
    frame: WsRequestFrame
  ): Promise<void> {
    const { id, method, params } = frame;

    try {
      let result: unknown;

      switch (method) {
        case "chat.send":
          result = await this.handleChatSend(client, parseParams(ChatSendParamsSchema, params));
          break;
        case "chat.cancel":
          parseParams(EmptyParamsSchema, params);
          result = this.handleChatCancel(client);
          break;
        case "chat.clear":
          parseParams(EmptyParamsSchema, params);
          result = await this.handleChatClear(client);
          break;
        case "sessions.list":
          result = await this.handleSessionsList(client, parseParams(SessionsListParamsSchema, params));
          break;
        case "sessions.history":
          result = await this.handleSessionsHistory(client, parseParams(SessionKeyParamsSchema, params));
          break;
        case "sessions.delete":
          result = await this.handleSessionsDelete(client, parseParams(SessionKeyParamsSchema, params));
          break;
        case "sessions.reset":
          result = await this.handleSessionsReset(client, parseParams(SessionKeyParamsSchema, params));
          break;
        case "sessions.restore":
          result = await this.handleSessionsRestore(client, parseParams(SessionKeyParamsSchema, params));
          break;
        case "status.get":
          parseParams(EmptyParamsSchema, params);
          result = this.getSystemStatus(client);
          break;
        case "session.info":
          parseParams(EmptyParamsSchema, params);
          result = await this.getSessionInfo(client);
          break;
        case "config.get":
          parseParams(EmptyParamsSchema, params);
          result = this.getConfigForClient(client);
          break;
        case "config.validate":
          result = validateConfig(parseParams(ConfigSaveParamsSchema, params) ?? {});
          break;
        case "config.save":
          result = await this.saveConfigForClient(client, parseParams(ConfigSaveParamsSchema, params) ?? {});
          break;
        case "ping":
          parseParams(EmptyParamsSchema, params);
          result = { pong: Date.now() };
          break;
        case "logs.subscribe":
          parseParams(EmptyParamsSchema, params);
          result = this.handleLogsSubscribe(client);
          break;
        case "logs.unsubscribe":
          parseParams(EmptyParamsSchema, params);
          result = this.handleLogsUnsubscribe(client);
          break;
        case "weixin.qr":
          parseParams(EmptyParamsSchema, params);
          result = await this.handleWeixinQR(client);
          break;
        case "weixin.qr.status":
          result = await this.handleWeixinQRStatus(client, parseParams(WeixinQrStatusParamsSchema, params));
          break;
        case "weixin.unbind":
          parseParams(EmptyParamsSchema, params);
          result = await this.handleWeixinUnbind(client);
          break;
        default:
          throw new Error(`Unknown method: ${method}`);
      }

      this.sendResponse(client.ws, id, true, result);
    } catch (error) {
      this.sendResponse(client.ws, id, false, undefined, this.toErrorFrame(error, "ERROR"));
    }
  }

  /** Build a WS error frame, preserving the HTTP-equivalent status of typed errors. */
  private toErrorFrame(error: unknown, code: string): { code: string; message: string; status?: number } {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof HttpError) return { code, message, status: error.status };
    return { code, message };
  }

  private requireBackendLogAccess(client: WsClient): void {
    if (!canAccessBackendLogs(isWebAuthEnabled(this.config), client.user?.role)) {
      throw new HttpError(403, "Admin privileges required");
    }
  }

  /** Subscribe a client to live backend logs and return the recent backlog. */
  private handleLogsSubscribe(client: WsClient): { entries: ReturnType<LogStreamer["getBacklog"]> } {
    this.requireBackendLogAccess(client);
    if (!client.logUnsubscribe) {
      client.logUnsubscribe = this.logStreamer.subscribe((entry) => {
        this.sendEvent(client.ws, "log.entry", entry);
      });
    }
    return { entries: this.logStreamer.getBacklog() };
  }

  private handleLogsUnsubscribe(client: WsClient): { ok: true } {
    this.requireBackendLogAccess(client);
    client.logUnsubscribe?.();
    client.logUnsubscribe = null;
    return { ok: true };
  }

  private async getAgentForClient(client: WsClient): Promise<Agent> {
    return this.runtimeManager?.getAgent(client.user?.id) ?? this.agent;
  }

  private getConfigForClient(client: WsClient): ConfigInfo {
    if (!client.user || !isWebAuthEnabled(this.config)) {
      return getConfigInfo(this.config);
    }
    return getUserConfigInfo(this.config, getUserConfigSettings(this.config, client.user.id), client.user);
  }

  private async saveConfigForClient(
    client: WsClient,
    params: ConfigSaveParams,
  ): Promise<{ success: boolean; message: string; requiresRestart?: boolean }> {
    if (!client.user || !isWebAuthEnabled(this.config)) {
      return saveConfig(this.config, params);
    }
    const validation = validateConfig(params);
    if (!validation.valid) {
      return {
        success: false,
        message: "Config validation failed: " + validation.errors.join("; "),
      };
    }
    saveUserConfigSettings(this.config, client.user.id, extractUserConfigSettings(params));
    await this.runtimeManager?.reset(client.user.id);
    const systemParams = client.user.role === "admin" ? extractSystemConfigParams(params) : {};
    if (Object.keys(systemParams).length === 0) {
      return { success: true, message: "User settings saved" };
    }
    const systemResult = saveConfig(this.config, systemParams);
    return systemResult.success
      ? { ...systemResult, message: "User settings and system config saved" }
      : systemResult;
  }

  private createUserWeixinClient(): WeixinClient {
    const config = this.config.channels.weixin ?? {};
    return new WeixinClient(
      "weixin",
      config.baseUrl ?? DEFAULT_WEIXIN_OC_BASE_URL,
      config.cdnBaseUrl ?? DEFAULT_WEIXIN_OC_CDN_BASE_URL,
      config.apiTimeoutMs ?? DEFAULT_WEIXIN_OC_API_TIMEOUT_MS,
      undefined,
    );
  }

  private async handleWeixinQR(client: WsClient): Promise<{ qrcode_url: string; qrcode: string } | { error: string }> {
    if (client.user) {
      const weixinClient = this.createUserWeixinClient();
      const botType = this.config.channels.weixin?.botType ?? DEFAULT_WEIXIN_OC_BOT_TYPE;
      const result = await weixinClient.getQRCode(botType);
      this.pendingUserWeixinLogins.set(result.qrcode, {
        userId: client.user.id,
        client: weixinClient,
      });
      const qrcode_url = renderQrSvgDataUri(result.qrcodeImgContent);
      return { qrcode_url, qrcode: result.qrcode };
    }

    if (!this.weixinChannel) {
      return { error: "Personal WeChat channel not enabled" };
    }
    const result = await this.weixinChannel.getLoginQRCode();
    if (!result) {
      return { error: "Failed to get QR code" };
    }
    const qrcode_url = renderQrSvgDataUri(result.qrcodeImgContent);
    return { qrcode_url, qrcode: result.qrcode };
  }

  private async handleWeixinQRStatus(client: WsClient, params: { qrcode: string }): Promise<{
    status: string;
    message: string;
    accountId?: string;
    user?: PublicWebUser;
  }> {
    const pendingLogin = client.user ? this.pendingUserWeixinLogins.get(params.qrcode) : undefined;
    if (pendingLogin && pendingLogin.userId !== client.user?.id) {
      return { status: "error", message: "QR code belongs to another user" };
    }
    if (!pendingLogin && !this.weixinChannel) {
      return { status: "error", message: "Personal WeChat channel not enabled" };
    }
    const result = pendingLogin
      ? await pendingLogin.client.pollQRStatus(params.qrcode, 15000)
      : await this.weixinChannel!.checkQRStatus(params.qrcode);
    const statusMessages: Record<string, string> = {
      wait: "Waiting for scan...",
      confirmed: "Login successful!",
      expired: "QR code expired",
      canceled: "User cancelled login",
      denied: "User denied login",
    };
    const payload: {
      status: string;
      message: string;
      accountId?: string;
      user?: PublicWebUser;
    } = {
      status: result.status,
      message: statusMessages[result.status] ?? result.status,
      accountId: result.accountId,
    };
    if (result.status === "confirmed" && client.user && result.botToken) {
      payload.user = saveUserWeixinLogin(this.config, client.user.id, {
        token: result.botToken,
        accountId: result.accountId ?? "",
        baseUrl: result.baseUrl ?? this.config.channels.weixin?.baseUrl ?? "",
        userId: result.userId,
      });
      client.user = payload.user;
      this.pendingUserWeixinLogins.delete(params.qrcode);
      await this.onUserWeixinLogin?.(client.user.id, {
        token: result.botToken,
        accountId: result.accountId,
        baseUrl: result.baseUrl ?? this.config.channels.weixin?.baseUrl,
        botType: this.config.channels.weixin?.botType,
        cdnBaseUrl: this.config.channels.weixin?.cdnBaseUrl,
        apiTimeoutMs: this.config.channels.weixin?.apiTimeoutMs,
        longPollTimeoutMs: this.config.channels.weixin?.longPollTimeoutMs,
        enabled: true,
      });
    } else if (["expired", "canceled", "cancel", "denied"].includes(result.status)) {
      this.pendingUserWeixinLogins.delete(params.qrcode);
    }
    return payload;
  }

  private async handleWeixinUnbind(client: WsClient): Promise<{ user: PublicWebUser }> {
    if (!client.user) {
      throw new Error("Login required");
    }
    const user = deleteUserWeixinLogin(this.config, client.user.id);
    client.user = user;
    // Shut down the user's running Weixin channel so the unbind takes effect
    // immediately, not at the next restart.
    await this.onUserWeixinUnbind?.(user.id);
    return { user };
  }

  /** Ensure client has a session; create if none */
  private async ensureSession(client: WsClient): Promise<void> {
    if (client.sessionKey && client.sessionId) {
      return;
    }

    const store = getSessionStore();
    const sessionKey = client.user
      ? `${WEBCHAT_SESSION_PREFIX}${client.user.id}:${client.id}`
      : `${WEBCHAT_SESSION_PREFIX}${client.id}`;
    const session = await store.getOrCreate(sessionKey);

    client.sessionKey = sessionKey;
    client.sessionId = session.sessionId;

    logger.info({ clientId: client.id, sessionKey, sessionId: session.sessionId }, "Session created");
  }

  /** Handle chat send */
  private async handleChatSend(
    client: WsClient,
    params: ChatSendParams
  ): Promise<{ messageId: string }> {
    const startedAt = Date.now();
    // Ensure session exists
    await this.ensureSession(client);

    const { message } = params;
    const messageId = generateId("msg");
    const store = getSessionStore();

    // Construct message context
    // Use sessionKey as senderId to ensure Agent can find history after session restore
    const stableSenderId = client.sessionKey!.replace("webchat:", "");

    logger.debug(
      {
        clientId: client.id,
        sessionKey: client.sessionKey,
        stableSenderId,
        messagePreview: message.slice(0, 100),
        messageLength: message.length,
      },
      "Chat send"
    );

    // Save user message to transcript
    const userMessage: TranscriptMessage = {
      id: messageId,
      role: "user",
      content: message,
      timestamp: Date.now(),
    };
    await store.appendTranscript(client.sessionId!, client.sessionKey!, userMessage);
    logger.debug(
      { clientId: client.id, sessionKey: client.sessionKey, sessionId: client.sessionId, messageId, role: "user" },
      "WebChat transcript appended"
    );

    const context = {
      channelId: "webchat" as const,
      chatId: client.sessionKey!,
      messageId,
      senderId: stableSenderId,
      senderName: "WebChat User",
      content: message,
      chatType: "direct" as const,
      timestamp: Date.now(),
      // Tag the owning Web user so per-user extensions (persona, skill learner)
      // resolve to the same runtime as getAgentForClient(client) below.
      raw: client.user ? { __webUserId: client.user.id } : undefined,
    };

    // Run message interceptors (commands, auto-detect, skill capture)
    const intercepted = await runMessageInterceptors(context);
    if (intercepted !== null) {
      logger.debug(
        {
          clientId: client.id,
          sessionKey: client.sessionKey,
          messageId,
          responseLength: intercepted.length,
          durationMs: Date.now() - startedAt,
        },
        "WebChat message intercepted"
      );
      this.sendEvent(client.ws, "chat.delta", {
        sessionId: client.sessionId,
        delta: intercepted,
        done: false,
      } as ChatDeltaEvent);
      this.sendEvent(client.ws, "chat.delta", {
        sessionId: client.sessionId,
        delta: "",
        done: true,
      } as ChatDeltaEvent);

      // Save assistant message to transcript
      const assistantMessage: TranscriptMessage = {
        id: generateId("msg"),
        role: "assistant",
        content: intercepted,
        timestamp: Date.now(),
      };
      await store.appendTranscript(client.sessionId!, client.sessionKey!, assistantMessage);
      logger.debug(
        { clientId: client.id, sessionKey: client.sessionKey, sessionId: client.sessionId, role: "assistant", responseLength: intercepted.length },
        "WebChat intercepted reply appended"
      );

      return { messageId };
    }

    const controller = new AbortController();
    client.currentAbortController = controller;

    try {
      const agent = await this.getAgentForClient(client);
      const stream = agent.processMessageStream(context, { signal: controller.signal });
      let fullContent = "";
      let deltaCount = 0;

      for await (const delta of stream) {
        fullContent += delta;
        deltaCount += 1;
        this.sendEvent(client.ws, "chat.delta", {
          sessionId: client.sessionId,
          delta,
          done: false,
        } as ChatDeltaEvent);
      }

      client.currentAbortController = null;

      // Save assistant message to transcript
      const assistantMessage: TranscriptMessage = {
        id: generateId("msg"),
        role: "assistant",
        content: fullContent,
        timestamp: Date.now(),
      };
      await store.appendTranscript(client.sessionId!, client.sessionKey!, assistantMessage);
      logger.debug(
        {
          clientId: client.id,
          sessionKey: client.sessionKey,
          sessionId: client.sessionId,
          responseLength: fullContent.length,
          deltaCount,
        },
        "WebChat assistant transcript appended"
      );

      this.sendEvent(client.ws, "chat.delta", {
        sessionId: client.sessionId,
        delta: "",
        done: true,
      } as ChatDeltaEvent);

      // Run response observers
      await runResponseObservers(context, fullContent);

      // Auto-title the session from its first exchange (detached; never blocks
      // the reply). No-op once the session already has a label.
      void this.maybeGenerateTitle(client, context.content, fullContent);

      logger.debug(
        {
          clientId: client.id,
          sessionKey: client.sessionKey,
          messageId,
          responseLength: fullContent.length,
          deltaCount,
          durationMs: Date.now() - startedAt,
        },
        "WebChat chat.send completed"
      );
    } catch (error) {
      client.currentAbortController = null;
      const isAborted =
        error instanceof Error &&
        (error.name === "AbortError" || error.message === "Aborted" || (error as { code?: string }).code === "ABORT_ERR");
      if (isAborted) {
        logger.debug({ clientId: client.id, sessionKey: client.sessionKey, messageId, durationMs: Date.now() - startedAt }, "WebChat chat.send aborted");
        this.sendEvent(client.ws, "chat.delta", {
          sessionId: client.sessionId,
          delta: "",
          done: true,
          cancelled: true,
        } as ChatDeltaEvent);
      } else {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(
          { error, clientId: client.id, sessionKey: client.sessionKey, messageId, durationMs: Date.now() - startedAt },
          "WebChat chat.send failed"
        );
        this.sendEvent(client.ws, "chat.error", {
          sessionId: client.sessionId,
          error: errorMessage,
        });
      }
    }

    return { messageId };
  }

  /**
   * Generate a sidebar title for a WebChat session from its first exchange.
   * Runs at most once per session (guarded by the label + an in-flight set),
   * retries on a later reply if the LLM call failed, and pushes a `session.title`
   * event so the sidebar updates live.
   */
  private async maybeGenerateTitle(client: WsClient, userText: string, assistantText: string): Promise<void> {
    const sessionKey = client.sessionKey;
    if (!sessionKey || this.titleInFlight.has(sessionKey)) return;
    const store = getSessionStore();
    const existing = await store.get(sessionKey);
    if (!existing || existing.label) return;

    this.titleInFlight.add(sessionKey);
    try {
      const label = await generateSessionTitle({
        provider: this.config.agent.defaultProvider,
        model: this.config.agent.defaultModel,
        userText,
        assistantText,
      });
      if (!label) return;
      await store.setLabel(sessionKey, label);
      this.sendEvent(client.ws, "session.title", { sessionKey, label });
      logger.debug({ clientId: client.id, sessionKey, label }, "WebChat session titled");
    } catch (error) {
      logger.debug({ error, sessionKey }, "WebChat session title generation failed");
    } finally {
      this.titleInFlight.delete(sessionKey);
    }
  }

  /** Cancel current client's chat request */
  private handleChatCancel(client: WsClient): { cancelled: boolean } {
    if (client.currentAbortController) {
      client.currentAbortController.abort();
      client.currentAbortController = null;
      return { cancelled: true };
    }
    return { cancelled: false };
  }

  /** Handle clear session */
  private async handleChatClear(client: WsClient): Promise<{ success: boolean; sessionKey: string; sessionId: string }> {
    // Ensure session exists
    await this.ensureSession(client);

    const store = getSessionStore();
    const oldSessionKey = client.sessionKey!;

    // Reset session
    const newSession = await store.reset(client.sessionKey!);

    // Update client session ID and sessionKey
    client.sessionKey = newSession.sessionKey;
    client.sessionId = newSession.sessionId;

    logger.info(
      { clientId: client.id, oldSessionKey, newSessionKey: newSession.sessionKey, newSessionId: newSession.sessionId },
      "Chat cleared, new session created"
    );

    return {
      success: true,
      sessionKey: newSession.sessionKey,
      sessionId: newSession.sessionId,
    };
  }

  /** Handle session list */
  private sessionOwnerPrefix(client: WsClient): string {
    return client.user ? `${WEBCHAT_SESSION_PREFIX}${client.user.id}:` : WEBCHAT_SESSION_PREFIX;
  }

  private assertSessionAccess(client: WsClient, sessionKey: string): void {
    if (!sessionKey.startsWith(this.sessionOwnerPrefix(client))) {
      throw new Error("Session not found");
    }
  }

  private async handleSessionsList(client: WsClient, params?: SessionsListParams): Promise<unknown> {
    const store = getSessionStore();
    const sessions = await store.list({
      activeMinutes: params?.activeMinutes,
      search: params?.search,
    });
    return { sessions: filterWebChatSessions(sessions, params?.limit, client.user?.id) };
  }

  /** Handle get session history */
  private async handleSessionsHistory(client: WsClient, params: SessionsHistoryParams): Promise<unknown> {
    this.assertSessionAccess(client, params.sessionKey);
    const store = getSessionStore();
    const session = await store.get(params.sessionKey);
    if (!session) {
      throw new Error(`Session not found: ${params.sessionKey}`);
    }
    const messages = await store.loadTranscript(session.sessionId);
    return {
      sessionKey: params.sessionKey,
      sessionId: session.sessionId,
      messages,
    };
  }

  /** Handle delete session */
  private async handleSessionsDelete(client: WsClient, params: SessionsDeleteParams): Promise<{ success: boolean }> {
    this.assertSessionAccess(client, params.sessionKey);
    const store = getSessionStore();
    await store.delete(params.sessionKey);
    return { success: true };
  }

  /** Handle reset session */
  private async handleSessionsReset(client: WsClient, params: SessionsResetParams): Promise<unknown> {
    this.assertSessionAccess(client, params.sessionKey);
    const store = getSessionStore();
    const session = await store.reset(params.sessionKey);
    return {
      success: true,
      sessionKey: session.sessionKey,
      sessionId: session.sessionId,
    };
  }

  /** Handle restore session */
  private async handleSessionsRestore(client: WsClient, params: SessionsRestoreParams): Promise<unknown> {
    this.assertSessionAccess(client, params.sessionKey);
    const store = getSessionStore();
    const session = await store.get(params.sessionKey);
    if (!session) {
      throw new Error(`Session not found: ${params.sessionKey}`);
    }

    // Update client session. Pointing the client at this sessionKey is all the
    // agent needs: the runtime derives its session key from the same key (see
    // chat.send's stableSenderId), and pi's SessionManager reloads that session's
    // persisted transcript on the next turn. The UI's own transcript is returned
    // below for display; there is no separate "replay into the agent" step.
    client.sessionKey = session.sessionKey;
    client.sessionId = session.sessionId;

    // Load history messages for the UI to render.
    const messages = await store.loadTranscript(session.sessionId);

    return {
      sessionKey: session.sessionKey,
      sessionId: session.sessionId,
      messages,
    };
  }

  /** Get system status */
  private getSystemStatus(client: WsClient): SystemStatus {
    const providers = getAllProviders().map((p) => ({
      id: p.id,
      name: p.name,
      available: true,
    }));

    const channels: SystemStatus["channels"] = getAllChannels().map((c) => ({
      id: c.id,
      name: c.id,  // Use id as name
      connected: true,  // Simplification: assume configured channels are all connected
    }));
    const userWeixin = client.user ? this.getUserWeixinStatus?.(client.user.id) : undefined;
    if (userWeixin?.configured && !channels.some((channel) => channel.id === "weixin")) {
      channels.push({
        id: "weixin",
        name: "Personal WeChat",
        connected: userWeixin.connected,
      });
    }

    return {
      version: "1.0.0",
      uptime: Date.now() - this.startTime,
      providers,
      channels,
      sessions: this.clients.size,
    };
  }

  /** Get session info */
  private async getSessionInfo(client: WsClient): Promise<unknown> {
    const context = {
      channelId: "webchat" as const,
      chatId: client.sessionKey || `webchat:${client.id}`,
      messageId: "",
      senderId: client.id,
      senderName: "",
      content: "",
      chatType: "direct" as const,
      timestamp: Date.now(),
    };

    const agent = await this.getAgentForClient(client);
    const info = agent.getSessionInfo(context);
    return {
      sessionKey: client.sessionKey,
      sessionId: client.sessionId,
      ...info,
    };
  }


  /** Send response */
  private sendResponse(
    ws: WebSocket,
    id: string,
    ok: boolean,
    payload?: unknown,
    error?: { code: string; message: string; status?: number }
  ): void {
    const frame: WsResponseFrame = { type: "res", id, ok, payload, error };
    ws.send(JSON.stringify(frame));
  }

  /** Send event */
  private sendEvent(ws: WebSocket, event: string, payload?: unknown): void {
    const frame: WsEventFrame = { type: "event", event, payload };
    ws.send(JSON.stringify(frame));
  }

  /** Broadcast event */
  broadcast(event: string, payload?: unknown): void {
    const frame: WsEventFrame = { type: "event", event, payload };
    const data = JSON.stringify(frame);

    for (const client of this.clients.values()) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(data);
      }
    }
  }

  /** Heartbeat check */
  private checkHeartbeat(): void {
    const now = Date.now();

    for (const [clientId, client] of this.clients) {
      if (now - client.lastPing > this.clientTimeout) {
        logger.info({ clientId }, "Client timeout, disconnecting");
        client.ws.terminate();
        this.clients.delete(clientId);
      } else {
        client.ws.ping();
      }
    }
  }

  /** Close server */
  close(): void {
    for (const client of this.clients.values()) {
      client.ws.close();
    }
    this.wss.close();
    logger.info("WebSocket server closed");
  }
}
