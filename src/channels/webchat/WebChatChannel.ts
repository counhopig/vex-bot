/**
 * WebChatChannel — WebSocket transport + protocol translation for the
 * WebChat SPA.
 *
 * Split out of _archive/src/web/websocket.ts (1145 LOC) per the rewrite plan:
 * this file is the channel (transport + frame protocol + chat.* methods);
 * sessions/config/admin/weixin/logs method handlers are injected route
 * handlers owned by web/.
 *
 * Key architecture decision: the new Agent has no processMessageStream, so
 * WebChat is NON-streaming. `chat.send` constructs an InboundMessageContext
 * and calls the injected `dispatch` (= Dispatcher.dispatch); the reply comes
 * back through OutboundDeliver → this channel's `sendMessage`, which pushes
 * a single `chat.delta {done:true}` frame to the owning connection. This
 * matches rewrite-plan data flow scenario 1 exactly.
 */

import { WebSocketServer, WebSocket } from "ws";
import type { Server as HttpServer, IncomingMessage } from "http";
import { z } from "zod";
import { getChildLogger } from "../../utils/logger.js";
import { generateId } from "../../utils/index.js";
import type {
  ChannelAdapter,
  ChannelMeta,
  InboundMessageContext,
  OutboundMessage,
  SendResult,
} from "../ChannelAdapter.js";
import type { WebAuthStore, PublicWebUser } from "../../web/routes/auth.js";
import type { FileSessionStore } from "../../sessions/store.js";
import type { TranscriptMessage } from "../../sessions/types.js";
import { generateSessionTitle, type LlmCompleteLike } from "../../sessions/title.js";

const logger = getChildLogger("webchat");

const WEBCHAT_SESSION_PREFIX = "webchat:";

/** The backend log stream is an operator/admin view — any authenticated user
 *  must not be able to read it. Single-user mode (web auth disabled) has one
 *  operator, so there's nothing to gate. */
export function canAccessBackendLogs(webAuthEnabled: boolean, role?: string): boolean {
  return !webAuthEnabled || role === "admin";
}

/** Keep the browser UI scoped to sessions created by WebChat itself. */
export function filterWebChatSessions(
  sessions: readonly { sessionKey: string; sessionId: string; label?: string; updatedAt: number }[],
  limit?: number,
  userId?: string,
): { sessionKey: string; sessionId: string; label?: string; updatedAt: number }[] {
  const prefix = userId ? `${WEBCHAT_SESSION_PREFIX}${userId}:` : WEBCHAT_SESSION_PREFIX;
  const webchatSessions = sessions.filter((session) => session.sessionKey.startsWith(prefix));
  return limit ? webchatSessions.slice(0, limit) : webchatSessions;
}

// ---------------------------------------------------------------------------
// Frame protocol (pure helpers)
// ---------------------------------------------------------------------------

const RequestFrameSchema = z.object({
  type: z.literal("req"),
  id: z.string().min(1),
  method: z.string().min(1),
  params: z.unknown().optional(),
});

const EmptyParamsSchema = z.object({}).passthrough().default({});
const ChatSendParamsSchema = z.object({
  message: z.string().min(1).max(100_000),
});

function formatZodError(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "frame"}: ${issue.message}`).join("; ");
}

/** Parse + validate a WS request frame. Throws on malformed input. */
export function parseRequestFrame(data: string): {
  type: "req";
  id: string;
  method: string;
  params?: unknown;
} {
  const raw = JSON.parse(data);
  const result = RequestFrameSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid request frame: ${formatZodError(result.error)}`);
  }
  return result.data;
}

/** Validate request params through a zod schema. Throws on invalid input. */
export function parseParams<T>(schema: z.ZodType<T>, params: unknown): T {
  const result = schema.safeParse(params);
  if (!result.success) {
    throw new Error(`Invalid params: ${formatZodError(result.error)}`);
  }
  return result.data;
}

/** Extract the request id for an error response, or undefined if unparseable. */
export function getRequestId(data: string): string | undefined {
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

// ---------------------------------------------------------------------------
// Channel
// ---------------------------------------------------------------------------

export interface WebChatChannelOptions {
  /** HTTP server the WebSocket server attaches to (path /ws). */
  server: HttpServer;
  /** Authentication — getRequestUser(req) resolves the Web user from the cookie. */
  auth: WebAuthStore;
  /** Session store for WebChat session binding + transcripts. */
  sessionStore: FileSessionStore;
  /** Dispatcher.dispatch — the single entry point for chat messages. */
  dispatch: (ctx: InboundMessageContext) => Promise<void>;
  /**
   * Non-chat method handlers (sessions.* / config.* / logs.* / weixin.* /
   * status.get / session.info), keyed by WS method name. Injected by the
   * web/server.ts bootstrap so the channel stays protocol-only. Each handler
   * receives the owning client view + validated params and returns the res
   * payload.
   */
  handlers?: Record<string, WsMethodHandler>;
  /**
   * Auto-titles a session's sidebar label from its first exchange (archive
   * parity: _archive/src/web/websocket.ts's maybeGenerateTitle). Optional —
   * when absent, sessions keep their derived fallback label (the frontend
   * falls back to a truncated sessionKey) and no LLM call is made. The
   * bootstrap wires this from ModelResolver + the system's default
   * provider/model, matching the archive's choice of a fixed system model
   * rather than the per-user resolved one (titling is a cheap, unpersonalized
   * summary, not part of the conversation).
   */
  titleGenerator?: { provider: string; model: string; complete: LlmCompleteLike };
  heartbeatIntervalMs?: number;
  clientTimeoutMs?: number;
}

/** A client-facing view exposed to injected method handlers. */
export interface WsClientView {
  readonly id: string;
  /** Mutable: a handler (e.g. weixin.qr.status confirmed, weixin.unbind) can
   *  rebind the client to a new user identity and the change takes effect for
   *  subsequent requests on this connection. */
  user: PublicWebUser | null;
  sessionKey: string | null;
  sessionId: string | null;
  /** Push an event frame to this client's connection. */
  sendEvent(event: string, payload?: unknown): void;
  /** Register a cleanup function called when this client disconnects
   *  (e.g. the log-stream unsubscribe). */
  onDisconnect(cleanup: () => void): void;
}

/** Handler for a non-chat WS method. Returns the res payload. */
export type WsMethodHandler = (
  client: WsClientView,
  params: unknown,
) => Promise<unknown> | unknown;

interface WsClient {
  id: string;
  ws: WebSocket;
  sessionKey: string | null;
  sessionId: string | null;
  user: PublicWebUser | null;
  lastPing: number;
  /** Cleanups registered by injected handlers (e.g. log-stream unsubscribe). */
  cleanups: Array<() => void>;
  /** The user text from the chat.send currently in flight, stashed here so
   *  sendMessage() (called later, from a separate Dispatcher → Outbound call
   *  chain) can pair it with the assistant's reply for maybeGenerateTitle. */
  pendingUserText: string | null;
}

export class WebChatChannel implements ChannelAdapter {
  readonly id = "webchat" as const;
  readonly meta: ChannelMeta = {
    id: "webchat",
    name: "WebChat",
    description: "Server-rendered WebChat SPA over WebSocket",
    capabilities: {
      chatTypes: ["direct"],
      supportsMedia: false,
      supportsReply: false,
      supportsMention: false,
      supportsReaction: false,
      supportsThread: false,
      supportsEdit: false,
      maxMessageLength: 100_000,
    },
  };

  private readonly server: HttpServer;
  private readonly auth: WebAuthStore;
  private readonly sessionStore: FileSessionStore;
  private readonly dispatch: (ctx: InboundMessageContext) => Promise<void>;
  private readonly handlers?: Record<string, WsMethodHandler>;
  private readonly titleGenerator?: { provider: string; model: string; complete: LlmCompleteLike };
  private readonly heartbeatIntervalMs: number;
  private readonly clientTimeoutMs: number;

  private wss?: WebSocketServer;
  private clients = new Map<string, WsClient>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private startTime = Date.now();
  /** Sessions with a title generation currently in flight — guards against
   *  duplicate LLM calls when a reply is slower than the next chat.send. */
  private titleInFlight = new Set<string>();

  constructor(options: WebChatChannelOptions) {
    this.server = options.server;
    this.auth = options.auth;
    this.sessionStore = options.sessionStore;
    this.dispatch = options.dispatch;
    this.handlers = options.handlers;
    this.titleGenerator = options.titleGenerator;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
    this.clientTimeoutMs = options.clientTimeoutMs ?? 60_000;
  }

  async initialize(): Promise<void> {
    if (this.wss) return;
    this.wss = new WebSocketServer({ server: this.server, path: "/ws" });
    this.wss.on("connection", (ws, req) => {
      this.handleConnection(ws, req);
    });
    this.heartbeatTimer = setInterval(() => this.checkHeartbeat(), this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
    logger.info("WebSocket server initialized");
  }

  async shutdown(): Promise<void> {
    for (const client of this.clients.values()) {
      client.ws.close();
    }
    this.clients.clear();
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.wss?.close();
    this.wss = undefined;
    logger.info("WebSocket server closed");
  }

  async isHealthy(): Promise<boolean> {
    return this.wss !== undefined;
  }

  onMessage(_handler: (ctx: InboundMessageContext) => Promise<void>): void {
    // WebChat messages are dispatched synchronously via the injected
    // `dispatch` in chat.send; the Dispatcher does not register a channel
    // callback for this channel type. Kept for ChannelAdapter parity.
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const user = this.auth.getRequestUser(req);
    if (this.auth.isEnabled && !user) {
      ws.close(1008, "Authentication required");
      return;
    }

    const clientId = generateId("client");
    const client: WsClient = {
      id: clientId,
      ws,
      sessionKey: null,
      sessionId: null,
      user,
      lastPing: Date.now(),
      cleanups: [],
      pendingUserText: null,
    };
    this.clients.set(clientId, client);
    logger.info({ clientId, userId: user?.id }, "Client connected");

    this.sendEvent(ws, "connected", { clientId, version: "1.0.0", user });

    ws.on("message", (data) => {
      this.handleMessage(client, data.toString());
    });
    ws.on("close", () => {
      for (const cleanup of client.cleanups) {
        try {
          cleanup();
        } catch (error) {
          logger.error({ clientId, error }, "Client cleanup failed");
        }
      }
      client.cleanups = [];
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

  private async handleMessage(client: WsClient, data: string): Promise<void> {
    try {
      const frame = parseRequestFrame(data);
      await this.handleRequest(client, frame);
    } catch (error) {
      logger.error({ error, data }, "Failed to handle message");
      const id = getRequestId(data);
      if (id) {
        const message = error instanceof Error ? error.message : String(error);
        this.sendResponse(client.ws, id, false, undefined, { code: "BAD_REQUEST", message });
      }
    }
  }

  private async handleRequest(
    client: WsClient,
    frame: { type: "req"; id: string; method: string; params?: unknown },
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
        case "ping":
          parseParams(EmptyParamsSchema, params);
          result = { pong: Date.now() };
          break;
        default: {
          const handler = this.handlers?.[method];
          if (handler) {
            // Live view: sessionKey/sessionId/user are getters/setters over
            // the internal client so a handler (e.g. sessions.restore,
            // weixin.qr.status) can rebind the connection and the change
            // takes effect for subsequent chat.send calls.
            const view: WsClientView = {
              id: client.id,
              get user() {
                return client.user;
              },
              set user(value: PublicWebUser | null) {
                client.user = value;
              },
              get sessionKey() {
                return client.sessionKey;
              },
              set sessionKey(value: string | null) {
                client.sessionKey = value;
              },
              get sessionId() {
                return client.sessionId;
              },
              set sessionId(value: string | null) {
                client.sessionId = value;
              },
              sendEvent: (event, payload) => this.sendEvent(client.ws, event, payload),
              onDisconnect: (cleanup) => {
                client.cleanups.push(cleanup);
              },
            };
            result = await handler(view, params);
            break;
          }
          throw new Error(`Unknown method: ${method}`);
        }
      }

      this.sendResponse(client.ws, id, true, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.sendResponse(client.ws, id, false, undefined, { code: "ERROR", message });
    }
  }

  // -------------------------------------------------------------------------
  // chat.* methods
  // -------------------------------------------------------------------------

  private async ensureSession(client: WsClient): Promise<void> {
    if (client.sessionKey && client.sessionId) return;

    const sessionKey = client.user
      ? `${WEBCHAT_SESSION_PREFIX}${client.user.id}:${client.id}`
      : `${WEBCHAT_SESSION_PREFIX}${client.id}`;
    const session = await this.sessionStore.getOrCreate(sessionKey);

    client.sessionKey = sessionKey;
    client.sessionId = session.sessionId;
    logger.info({ clientId: client.id, sessionKey, sessionId: session.sessionId }, "Session created");
  }

  private async handleChatSend(
    client: WsClient,
    params: { message: string },
  ): Promise<{ messageId: string }> {
    await this.ensureSession(client);

    const { message } = params;
    client.pendingUserText = message;
    const messageId = generateId("msg");
    const stableSenderId = client.sessionKey!.replace("webchat:", "");

    const userMessage: TranscriptMessage = {
      id: messageId,
      role: "user",
      content: message,
      timestamp: Date.now(),
    };
    await this.sessionStore.appendTranscript(client.sessionId!, client.sessionKey!, userMessage);

    const context: InboundMessageContext = {
      channelId: "webchat",
      messageId,
      chatId: client.sessionKey!,
      chatType: "direct",
      senderId: stableSenderId,
      senderName: "WebChat User",
      content: message,
      timestamp: Date.now(),
      // The top-level webUserId is what Dispatcher.resolveUserId reads to key
      // per-user config/persona/agent resolution (a browser tab must share the
      // user's Agent, not mint a fresh one per clientId). The raw.__webUserId
      // tag mirrors the archive's convention for pipeline extensions that
      // resolve the owning web user from ctx.raw.
      webUserId: client.user?.id,
      raw: client.user ? { __webUserId: client.user.id } : undefined,
    };

    await this.dispatch(context);

    return { messageId };
  }

  private handleChatCancel(client: WsClient): { cancelled: boolean } {
    // Non-streaming: nothing is in flight to cancel.
    logger.debug({ clientId: client.id }, "chat.cancel (no-op, non-streaming)");
    return { cancelled: false };
  }

  // -------------------------------------------------------------------------
  // Outbound delivery
  // -------------------------------------------------------------------------

  async sendMessage(message: OutboundMessage): Promise<SendResult> {
    const client = [...this.clients.values()].find((c) => c.sessionKey === message.chatId);
    if (!client || !client.sessionId) {
      return { success: false, error: `No WebChat connection for session ${message.chatId}` };
    }

    this.sendEvent(client.ws, "chat.delta", {
      sessionId: client.sessionId,
      delta: message.content,
      done: true,
    });

    const assistantMessage: TranscriptMessage = {
      id: generateId("msg"),
      role: "assistant",
      content: message.content,
      timestamp: Date.now(),
    };
    await this.sessionStore.appendTranscript(client.sessionId, client.sessionKey!, assistantMessage);

    // Auto-title the session from its first exchange (detached; never blocks
    // the reply). No-op once the session already has a label, or if no
    // titleGenerator was injected.
    const userText = client.pendingUserText;
    client.pendingUserText = null;
    if (userText) {
      void this.maybeGenerateTitle(client, userText, message.content);
    }

    return { success: true };
  }

  /** Generate a sidebar title for a session from its first exchange. Runs at
   *  most once per session (guarded by the label + titleInFlight), and
   *  pushes a session.title event so the sidebar updates live. Archive
   *  parity: _archive/src/web/websocket.ts's maybeGenerateTitle. */
  private async maybeGenerateTitle(client: WsClient, userText: string, assistantText: string): Promise<void> {
    const sessionKey = client.sessionKey;
    if (!this.titleGenerator || !sessionKey || this.titleInFlight.has(sessionKey)) return;

    const existing = await this.sessionStore.get(sessionKey);
    if (!existing || existing.label) return;

    this.titleInFlight.add(sessionKey);
    try {
      const label = await generateSessionTitle(
        { provider: this.titleGenerator.provider, model: this.titleGenerator.model, userText, assistantText },
        this.titleGenerator.complete,
      );
      if (!label) return;
      await this.sessionStore.setLabel(sessionKey, label);
      this.sendEvent(client.ws, "session.title", { sessionKey, label });
      logger.debug({ clientId: client.id, sessionKey, label }, "WebChat session titled");
    } catch (error) {
      logger.debug({ error, sessionKey }, "WebChat session title generation failed");
    } finally {
      this.titleInFlight.delete(sessionKey);
    }
  }

  async replyToContext(ctx: InboundMessageContext, text: string): Promise<SendResult> {
    return this.sendMessage({ chatId: ctx.chatId, content: text, replyToId: ctx.messageId });
  }

  // -------------------------------------------------------------------------
  // Frame send + heartbeat
  // -------------------------------------------------------------------------

  private sendResponse(
    ws: WebSocket,
    id: string,
    ok: boolean,
    payload?: unknown,
    error?: { code: string; message: string; status?: number },
  ): void {
    ws.send(JSON.stringify({ type: "res", id, ok, payload, error }));
  }

  private sendEvent(ws: WebSocket, event: string, payload?: unknown): void {
    ws.send(JSON.stringify({ type: "event", event, payload }));
  }

  private checkHeartbeat(): void {
    const now = Date.now();
    for (const [clientId, client] of this.clients) {
      if (now - client.lastPing > this.clientTimeoutMs) {
        logger.info({ clientId }, "Client timeout, disconnecting");
        client.ws.terminate();
        this.clients.delete(clientId);
      } else {
        client.ws.ping();
      }
    }
  }

  /** Uptime in ms since initialize — used by status.get. */
  get uptime(): number {
    return Date.now() - this.startTime;
  }

  /** Connected client count — used by status.get. */
  get clientCount(): number {
    return this.clients.size;
  }
}
