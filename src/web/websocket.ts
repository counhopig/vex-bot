/**
 * WebSocket server - real-time communication
 */

import { WebSocketServer, WebSocket } from "ws";
import type { Server as HttpServer } from "http";
import { z } from "zod";
import { getChildLogger } from "../utils/logger.js";
import { generateId } from "../utils/index.js";
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
} from "./types.js";
import type { Agent } from "../agents/agent.js";
import type { VexConfig } from "../types/index.js";
import type { WeixinChannel } from "../channels/weixin/index.js";
import { getAllProviders } from "../providers/index.js";
import { getAllChannels } from "../channels/index.js";
import { getSessionStore, type TranscriptMessage } from "../sessions/index.js";
import { runMessageInterceptors, runResponseObservers } from "../pipeline/index.js";
import { getConfigInfo, validateConfig, saveConfig } from "./config-handlers.js";
const logger = getChildLogger("websocket");

const EmptyParamsSchema = z.object({}).passthrough().default({});
const ChatSendParamsSchema = z.object({
  message: z.string().min(1),
  sessionKey: z.string().optional(),
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
  id: z.string().min(1),
  name: z.string(),
  hasConfig: z.boolean(),
  enabled: z.boolean().optional(),
  baseUrl: z.string().optional(),
  botType: z.string().optional(),
  hasToken: z.boolean().optional(),
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
  ignore_group_chat: z.boolean().optional(),
  greeting_on_first_chat: z.boolean().optional(),
  goodnight_hint_enabled: z.boolean().optional(),
  proactive_nudge_enabled: z.boolean().optional(),
  proactive_nudge_cron: z.string().optional(),
  rest_enabled: z.boolean().optional(),
  rest_sleep_hour: z.number().optional(),
  rest_wake_hour: z.number().optional(),
  storage_cache_max: z.number().int().optional(),
  debug_log_enabled: z.boolean().optional(),
  admin_ids: z.array(z.string()).optional(),
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
  sessions: SessionsConfigSchema.optional(),
  rawJson5: z.string().optional(),
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
  lastPing: number;
  /** AbortController for current chat, used for cancellation */
  currentAbortController: AbortController | null;
}

/** WebSocket server options */
export interface WsServerOptions {
  server: HttpServer;
  agent: Agent;
  config: VexConfig;
  weixinChannel?: WeixinChannel;
  heartbeatInterval?: number;
  clientTimeout?: number;
}

/** WebSocket server class */
export class WsServer {
  private wss: WebSocketServer;
  private clients = new Map<string, WsClient>();
  private agent: Agent;
  private config: VexConfig;
  private weixinChannel?: WeixinChannel;
  private startTime = Date.now();
  private heartbeatInterval: number;
  private clientTimeout: number;

  constructor(options: WsServerOptions) {
    this.agent = options.agent;
    this.config = options.config;
    this.weixinChannel = options.weixinChannel;
    this.heartbeatInterval = options.heartbeatInterval ?? 30000;
    this.clientTimeout = options.clientTimeout ?? 60000;

    this.wss = new WebSocketServer({
      server: options.server,
      path: "/ws",
    });

    this.wss.on("connection", (ws, req) => {
      this.handleConnection(ws);
    });

    // Heartbeat check
    setInterval(() => this.checkHeartbeat(), this.heartbeatInterval);

    logger.info("WebSocket server initialized");
  }

  /** Handle new connection */
  private async handleConnection(ws: WebSocket): Promise<void> {
    const clientId = generateId("client");

    // Don't create session immediately; wait for client to send sessions.restore or chat.send
    const client: WsClient = {
      id: clientId,
      ws,
      sessionKey: null,
      sessionId: null,
      lastPing: Date.now(),
      currentAbortController: null,
    };

    this.clients.set(clientId, client);
    logger.info({ clientId }, "Client connected");

    // Send welcome message - no session info, wait for client to decide
    this.sendEvent(ws, "connected", {
      clientId,
      version: "1.0.0",
    });

    ws.on("message", (data) => {
      this.handleMessage(client, data.toString());
    });

    ws.on("close", () => {
      this.clients.delete(clientId);
      logger.info({ clientId }, "Client disconnected");
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
        const message = error instanceof Error ? error.message : String(error);
        this.sendResponse(client.ws, id, false, undefined, {
          code: "BAD_REQUEST",
          message,
        });
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
          result = await this.handleSessionsList(parseParams(SessionsListParamsSchema, params));
          break;
        case "sessions.history":
          result = await this.handleSessionsHistory(parseParams(SessionKeyParamsSchema, params));
          break;
        case "sessions.delete":
          result = await this.handleSessionsDelete(parseParams(SessionKeyParamsSchema, params));
          break;
        case "sessions.reset":
          result = await this.handleSessionsReset(parseParams(SessionKeyParamsSchema, params));
          break;
        case "sessions.restore":
          result = await this.handleSessionsRestore(client, parseParams(SessionKeyParamsSchema, params));
          break;
        case "status.get":
          parseParams(EmptyParamsSchema, params);
          result = this.getSystemStatus();
          break;
        case "session.info":
          parseParams(EmptyParamsSchema, params);
          result = this.getSessionInfo(client);
          break;
        case "config.get":
          parseParams(EmptyParamsSchema, params);
          result = getConfigInfo(this.config);
          break;
        case "config.validate":
          result = validateConfig(parseParams(ConfigSaveParamsSchema, params) ?? {});
          break;
        case "config.save":
          result = saveConfig(this.config, parseParams(ConfigSaveParamsSchema, params) ?? {});
          break;
        case "ping":
          parseParams(EmptyParamsSchema, params);
          result = { pong: Date.now() };
          break;
        case "weixin.qr":
          parseParams(EmptyParamsSchema, params);
          result = await this.handleWeixinQR();
          break;
        case "weixin.qr.status":
          result = await this.handleWeixinQRStatus(parseParams(WeixinQrStatusParamsSchema, params));
          break;
        default:
          throw new Error(`Unknown method: ${method}`);
      }

      this.sendResponse(client.ws, id, true, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.sendResponse(client.ws, id, false, undefined, {
        code: "ERROR",
        message,
      });
    }
  }

  private async handleWeixinQR(): Promise<{ qrcode_url: string; qrcode: string } | { error: string }> {
    if (!this.weixinChannel) {
      return { error: "Personal WeChat channel not enabled" };
    }
    const result = await this.weixinChannel.getLoginQRCode();
    if (!result) {
      return { error: "Failed to get QR code" };
    }
    const qrcode_url = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(result.qrcodeImgContent)}`;
    return { qrcode_url, qrcode: result.qrcode };
  }

  private async handleWeixinQRStatus(params: { qrcode: string }): Promise<{
    status: string;
    message: string;
    accountId?: string;
  }> {
    if (!this.weixinChannel) {
      return { status: "error", message: "Personal WeChat channel not enabled" };
    }
    const result = await this.weixinChannel.checkQRStatus(params.qrcode);
    const statusMessages: Record<string, string> = {
      wait: "Waiting for scan...",
      confirmed: "Login successful!",
      expired: "QR code expired",
      canceled: "User cancelled login",
      denied: "User denied login",
    };
    return {
      status: result.status,
      message: statusMessages[result.status] ?? result.status,
      accountId: result.accountId,
    };
  }

  /** Ensure client has a session; create if none */
  private async ensureSession(client: WsClient): Promise<void> {
    if (client.sessionKey && client.sessionId) {
      return;
    }

    const store = getSessionStore();
    const sessionKey = `webchat:${client.id}`;
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
      const stream = this.agent.processMessageStream(context, { signal: controller.signal });
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
  private async handleSessionsList(params?: SessionsListParams): Promise<unknown> {
    const store = getSessionStore();
    const sessions = await store.list({
      limit: params?.limit,
      activeMinutes: params?.activeMinutes,
      search: params?.search,
    });
    return { sessions };
  }

  /** Handle get session history */
  private async handleSessionsHistory(params: SessionsHistoryParams): Promise<unknown> {
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
  private async handleSessionsDelete(params: SessionsDeleteParams): Promise<{ success: boolean }> {
    const store = getSessionStore();
    await store.delete(params.sessionKey);
    return { success: true };
  }

  /** Handle reset session */
  private async handleSessionsReset(params: SessionsResetParams): Promise<unknown> {
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
    const store = getSessionStore();
    const session = await store.get(params.sessionKey);
    if (!session) {
      throw new Error(`Session not found: ${params.sessionKey}`);
    }

    // Update client session
    client.sessionKey = session.sessionKey;
    client.sessionId = session.sessionId;

    // Load history messages
    const messages = await store.loadTranscript(session.sessionId);

    // Restore Agent's session context
    // Agent uses "webchat:{senderId}" as sessionKey for direct chat
    // senderId extracted from sessionKey (remove "webchat:" prefix)
    const agentSessionKey = session.sessionKey; // webchat:session_xxx
    const transcriptMessages = messages
      .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content as string }));

    if (transcriptMessages.length > 0) {
      this.agent.restoreSessionFromTranscript(agentSessionKey, transcriptMessages);
    }

    return {
      sessionKey: session.sessionKey,
      sessionId: session.sessionId,
      messages,
    };
  }

  /** Get system status */
  private getSystemStatus(): SystemStatus {
    const providers = getAllProviders().map((p) => ({
      id: p.id,
      name: p.name,
      available: true,
    }));

    const channels = getAllChannels().map((c) => ({
      id: c.id,
      name: c.id,  // Use id as name
      connected: true,  // Simplification: assume configured channels are all connected
    }));

    return {
      version: "1.0.0",
      uptime: Date.now() - this.startTime,
      providers,
      channels,
      sessions: this.clients.size,
    };
  }

  /** Get session info */
  private getSessionInfo(client: WsClient): unknown {
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

    const info = this.agent.getSessionInfo(context);
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
    error?: { code: string; message: string }
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
