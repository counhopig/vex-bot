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
  ConfigInfo,
  ConfigSaveParams,
  ConfigValidateResult,
} from "./types.js";
import type { Agent } from "../agents/agent.js";
import type { VexConfig, ProviderId } from "../types/index.js";
import type { WeixinChannel } from "../channels/weixin/index.js";
import { getAllProviders } from "../providers/index.js";
import { getAllChannels } from "../channels/index.js";
import { getSessionStore, type TranscriptMessage } from "../sessions/index.js";
import { join } from "path";
import { homedir } from "os";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import json5 from "json5";
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
          result = this.getConfigInfo();
          break;
        case "config.validate":
          result = this.validateConfig(parseParams(ConfigSaveParamsSchema, params) ?? {});
          break;
        case "config.save":
          result = await this.saveConfig(parseParams(ConfigSaveParamsSchema, params) ?? {});
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
    // Ensure session exists
    await this.ensureSession(client);

    const { message } = params;
    const messageId = generateId("msg");
    const store = getSessionStore();

    // Construct message context
    // Use sessionKey as senderId to ensure Agent can find history after session restore
    const stableSenderId = client.sessionKey!.replace("webchat:", "");

    logger.debug(
      { clientId: client.id, sessionKey: client.sessionKey, stableSenderId, message: message.slice(0, 100) },
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

    const controller = new AbortController();
    client.currentAbortController = controller;

    try {
      const stream = this.agent.processMessageStream(context, { signal: controller.signal });
      let fullContent = "";

      for await (const delta of stream) {
        fullContent += delta;
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

      this.sendEvent(client.ws, "chat.delta", {
        sessionId: client.sessionId,
        delta: "",
        done: true,
      } as ChatDeltaEvent);
    } catch (error) {
      client.currentAbortController = null;
      const isAborted =
        error instanceof Error &&
        (error.name === "AbortError" || error.message === "Aborted" || (error as { code?: string }).code === "ABORT_ERR");
      if (isAborted) {
        this.sendEvent(client.ws, "chat.delta", {
          sessionId: client.sessionId,
          delta: "",
          done: true,
          cancelled: true,
        } as ChatDeltaEvent);
      } else {
        const errorMessage = error instanceof Error ? error.message : String(error);
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

  /** Get config info (redacted) */
  private getConfigInfo(): ConfigInfo {
    // Provider info (API key redacted)
    const providers: Record<string, ConfigInfo["providers"][string]> = {};
    for (const [id, config] of Object.entries(this.config.providers)) {
      providers[id] = {
        id,
        name: (config as any).name || id,
        baseUrl: (config as any).baseUrl,
        hasApiKey: Boolean((config as any).apiKey),
        groupId: (config as any).groupId,
      };
    }

    // Channel info (redact sensitive fields)
    const channels: Record<string, ConfigInfo["channels"][string]> = {};
    const channelNames: Record<string, string> = {
      weixin: "Personal WeChat",
    };
    for (const [id, config] of Object.entries(this.config.channels)) {
      if (config) {
        const hasConfig = (
          (id === "weixin" && Boolean((config as any).token || (config as any).accountId))
        );
        const channelConfig: ConfigInfo["channels"][string] = {
          id,
          name: channelNames[id] || id,
          hasConfig,
          enabled: hasConfig && ((config as any).enabled ?? true),
        };
        if (id === "weixin") {
          (channelConfig as any).accountId = (config as any).accountId;
          (channelConfig as any).botType = (config as any).botType;
          (channelConfig as any).baseUrl = (config as any).baseUrl;
          (channelConfig as any).hasToken = Boolean((config as any).token);
        }
        channels[id] = channelConfig;
      }
    }

    // Agent configuration
    const agent = {
      defaultProvider: this.config.agent.defaultProvider,
      defaultModel: this.config.agent.defaultModel,
      temperature: this.config.agent.temperature,
      maxTokens: this.config.agent.maxTokens,
      systemPrompt: this.config.agent.systemPrompt,
    };

    // Server configuration
    const server = {
      port: this.config.server.port,
      host: this.config.server.host || "0.0.0.0",
    };

    // Logging configuration
    const logging = {
      level: this.config.logging.level,
    };

    // Memory system configuration
    const memory = {
      enabled: this.config.memory?.enabled,
      directory: this.config.memory?.directory,
      embeddingModel: this.config.memory?.embeddingModel,
      embeddingProvider: this.config.memory?.embeddingProvider,
    };

    // Skills configuration
    const skills = {
      enabled: this.config.skills?.enabled,
      userDir: this.config.skills?.userDir,
      workspaceDir: this.config.skills?.workspaceDir,
      disabled: this.config.skills?.disabled,
      only: this.config.skills?.only,
    };

    return {
      providers,
      channels,
      agent,
      server,
      logging,
      memory: memory as ConfigInfo["memory"],
      skills: skills as ConfigInfo["skills"],
    };
  }

  /** Validate config */
  private validateConfig(params: ConfigSaveParams): ConfigValidateResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate providers
    if (params.providers) {
      let hasApiKey = false;
      for (const [id, p] of Object.entries(params.providers)) {
        if (p.hasApiKey) {
          hasApiKey = true;
        }
        // Validate custom OpenAI/Anthropic need baseUrl
        if (p.hasApiKey && (id === "custom-openai" || id === "custom-anthropic")) {
          if (!p.baseUrl) {
            errors.push(`${id} requires baseUrl configuration`);
          }
        }
      }
      if (!hasApiKey && Object.keys(params.providers).length > 0) {
        warnings.push("No API Key configured, model functions will be unavailable");
      }
    }

    // Validate channels
    if (params.channels) {
      for (const [id, c] of Object.entries(params.channels)) {
        if (c.hasConfig) {
          if (id === "weixin" && !c.hasConfig) {
            errors.push("Personal WeChat requires QR scan login");
          }
        }
      }
    }

    // Validate Agent configuration
    if (params.agent) {
      const validProviders = [
        "deepseek", "doubao", "minimax", "kimi", "stepfun", "modelscope",
        "dashscope", "zhipu", "openai", "ollama", "openrouter",
        "together", "groq", "custom-openai", "custom-anthropic",
      ];
      if (params.agent.defaultProvider && !validProviders.includes(params.agent.defaultProvider)) {
        errors.push(`Invalid provider: ${params.agent.defaultProvider}`);
      }
      if (params.agent.temperature !== undefined && (params.agent.temperature < 0 || params.agent.temperature > 2)) {
        errors.push("temperature must be between 0 and 2");
      }
      if (params.agent.maxTokens !== undefined && params.agent.maxTokens < 1) {
        errors.push("maxTokens must be greater than 0");
      }
    }

    // Validate server configuration
    if (params.server) {
      if (params.server.port < 1 || params.server.port > 65535) {
        errors.push("Port must be between 1 and 65535");
      }
    }

    // Validate logging configuration
    if (params.logging) {
      const validLevels = ["debug", "info", "warn", "error"];
      if (params.logging.level && !validLevels.includes(params.logging.level)) {
        errors.push(`Invalid log level: ${params.logging.level}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /** Save config to file */
  private async saveConfig(params: ConfigSaveParams): Promise<{ success: boolean; message: string; requiresRestart?: boolean }> {
    const vexDir = join(homedir(), ".vex");
    const configPath = join(vexDir, "config.local.json5");

    // Validate config
    const validation = this.validateConfig(params);
    if (!validation.valid) {
      return {
        success: false,
        message: "Config validation failed: " + validation.errors.join("; "),
      };
    }

    // Read existing config first, then merge
    let existingConfig: Partial<VexConfig> = {};
    if (existsSync(configPath)) {
      try {
        existingConfig = json5.parse(readFileSync(configPath, "utf-8"));
      } catch (e) {
        logger.warn({ error: e }, "Failed to parse existing config, creating new");
      }
    }

    // Build config to save
    const configToSave: Partial<VexConfig> = { ...existingConfig };

    // Update providers
    if (params.providers) {
      const providers: VexConfig["providers"] = {};
      // Keep existing unmodified providers
      if (existingConfig.providers) {
        for (const [id, p] of Object.entries(existingConfig.providers)) {
          if (id && p) {
            providers[id] = p;
          }
        }
      }
      // Update/add new providers
      for (const [id, p] of Object.entries(params.providers)) {
        if (!id || !p.hasApiKey) {
          // Remove provider
          delete providers[id];
          continue;
        }
        // Get apiKey from existing config
        const existing = (existingConfig.providers as any)?.[id];
        providers[id] = {
          ...existing,
          baseUrl: p.baseUrl,
          ...(p.groupId ? { groupId: p.groupId } : {}),
        };
        // Prioritize frontend-sent apiKey (for new providers), otherwise keep existing
        const apiKey = (p as any).apiKey || existing?.apiKey;
        if (apiKey) {
          (providers[id] as any).apiKey = apiKey;
        }
      }
      configToSave.providers = providers;
    }

    // Update channels
    if (params.channels) {
      const channels: VexConfig["channels"] = {
        weixin: existingConfig.channels?.weixin,
      };

      for (const [id, c] of Object.entries(params.channels)) {
        if (!c.hasConfig) {
          delete (channels as any)[id];
          continue;
        }
        const existing = (existingConfig.channels as any)?.[id];
        (channels as any)[id] = {
          ...existing,
          enabled: c.enabled,
          ...((c as any).botType && { botType: (c as any).botType }),
          ...((c as any).baseUrl && { baseUrl: (c as any).baseUrl }),
          ...((c as any).accountId && { accountId: (c as any).accountId }),
        };
      }
      configToSave.channels = channels;
    }

    // Update Agent configuration
    if (params.agent) {
      configToSave.agent = {
        ...existingConfig.agent,
        ...params.agent,
        defaultProvider: (params.agent.defaultProvider as ProviderId) || (existingConfig.agent?.defaultProvider ?? "deepseek"),
      };
    }

    // Update server configuration
    if (params.server) {
      configToSave.server = {
        ...existingConfig.server,
        ...params.server,
      };
    }

    // Update logging configuration
    if (params.logging) {
      configToSave.logging = {
        ...existingConfig.logging,
        ...params.logging,
      };
    }

    // Update memory system configuration
    if (params.memory) {
      configToSave.memory = {
        ...existingConfig.memory,
        ...params.memory,
        embeddingProvider: params.memory.embeddingProvider as ProviderId | undefined,
      };
    }

    // Update Skills configuration
    if (params.skills) {
      configToSave.skills = {
        ...existingConfig.skills,
        ...params.skills,
      };
    }

    // Ensure directory exists
    if (!existsSync(vexDir)) {
      mkdirSync(vexDir, { recursive: true });
    }

    // Generate JSON5 format
    const json5Content = this.generateJson5(configToSave);

    // Write file
    writeFileSync(configPath, json5Content, "utf-8");

    logger.info({ configPath }, "Configuration saved");

    // Check if restart required
    let requiresRestart = false;
    if (params.server?.port && params.server.port !== this.config.server.port) {
      requiresRestart = true;
    }
    if (params.channels) {
      // If channels added or removed, restart required
      for (const [id, c] of Object.entries(params.channels)) {
        const existingHasConfig = Boolean((existingConfig.channels as any)?.[id]);
        if (c.hasConfig !== existingHasConfig) {
          requiresRestart = true;
          break;
        }
      }
    }

    return {
      success: true,
      message: "Configuration saved" + (requiresRestart ? ", restart required for changes to take effect" : ""),
      requiresRestart,
    };
  }

  /** Generate JSON5 format config string */
  private generateJson5(obj: unknown, indent = 0): string {
    const spaces = "  ".repeat(indent);
    const innerSpaces = "  ".repeat(indent + 1);

    if (obj === null || obj === undefined) {
      return "null";
    }

    if (typeof obj === "string") {
      return `"${obj.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    }

    if (typeof obj === "number" || typeof obj === "boolean") {
      return String(obj);
    }

    if (Array.isArray(obj)) {
      if (obj.length === 0) return "[]";
      const items = obj.map((item) => `${innerSpaces}${this.generateJson5(item, indent + 1)}`);
      return `[\n${items.join(",\n")}\n${spaces}]`;
    }

    if (typeof obj === "object") {
      const entries = Object.entries(obj).filter(([, v]) => v !== undefined);
      if (entries.length === 0) return "{}";

      const items = entries.map(([key, value]) => {
        // Use unquoted key (if valid ECMAScript identifier)
        const safeKey = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key) ? key : `"${key}"`;
        return `${innerSpaces}${safeKey}: ${this.generateJson5(value, indent + 1)}`;
      });

      return `{\n${items.join(",\n")}\n${spaces}}`;
    }

    return String(obj);
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
