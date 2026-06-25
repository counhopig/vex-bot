/**
 * Hooks system - event hooks
 */

import { getChildLogger } from "../utils/logger.js";
import type { InboundMessageContext, ChatMessage, ProviderId } from "../types/index.js";

const logger = getChildLogger("hooks");

// ============== Event Types ==============

/** Hook event type */
export type HookEventType =
  | "message_received"      // Message received
  | "message_sending"       // Message about to be sent
  | "message_sent"          // Message sent
  | "agent_start"           // Agent started processing
  | "agent_end"             // Agent finished processing
  | "tool_start"            // Tool started executing
  | "tool_end"              // Tool finished executing
  | "session_start"         // Session started
  | "session_end"           // Session ended
  | "compaction_start"      // Compaction started
  | "compaction_end"        // Compaction finished
  | "error";                // Error occurred

/** Hook event base data */
interface HookEventBase {
  type: HookEventType;
  timestamp: number;
  sessionKey?: string;
}

/** Message received event */
export interface MessageReceivedEvent extends HookEventBase {
  type: "message_received";
  context: InboundMessageContext;
}

/** Message sending event */
export interface MessageSendingEvent extends HookEventBase {
  type: "message_sending";
  channelId: string;
  chatId: string;
  content: string;
  replyToId?: string;
}

/** Message sent event */
export interface MessageSentEvent extends HookEventBase {
  type: "message_sent";
  channelId: string;
  chatId: string;
  messageId?: string;
  success: boolean;
}

/** Agent start event */
export interface AgentStartEvent extends HookEventBase {
  type: "agent_start";
  provider: ProviderId;
  model: string;
  messages: ChatMessage[];
}

/** Agent end event */
export interface AgentEndEvent extends HookEventBase {
  type: "agent_end";
  provider: ProviderId;
  model: string;
  response: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  durationMs: number;
}

/** Tool start event */
export interface ToolStartEvent extends HookEventBase {
  type: "tool_start";
  toolName: string;
  toolCallId: string;
  arguments: unknown;
}

/** Tool end event */
export interface ToolEndEvent extends HookEventBase {
  type: "tool_end";
  toolName: string;
  toolCallId: string;
  result: unknown;
  isError: boolean;
  durationMs: number;
}

/** Session start event */
export interface SessionStartEvent extends HookEventBase {
  type: "session_start";
  channelId: string;
  chatId: string;
  senderId: string;
}

/** Session end event */
export interface SessionEndEvent extends HookEventBase {
  type: "session_end";
  messageCount: number;
  totalTokens: number;
}

/** Compaction start event */
export interface CompactionStartEvent extends HookEventBase {
  type: "compaction_start";
  messageCount: number;
  estimatedTokens: number;
}

/** Compaction end event */
export interface CompactionEndEvent extends HookEventBase {
  type: "compaction_end";
  compactedMessages: number;
  summaryLength: number;
  durationMs: number;
}

/** Error event */
export interface ErrorEvent extends HookEventBase {
  type: "error";
  error: Error;
  context?: string;
}

/** All event types */
export type HookEvent =
  | MessageReceivedEvent
  | MessageSendingEvent
  | MessageSentEvent
  | AgentStartEvent
  | AgentEndEvent
  | ToolStartEvent
  | ToolEndEvent
  | SessionStartEvent
  | SessionEndEvent
  | CompactionStartEvent
  | CompactionEndEvent
  | ErrorEvent;

// ============== Hook Handlers ==============

/** Hook handler */
export type HookHandler<T extends HookEvent = HookEvent> = (
  event: T
) => void | Promise<void>;

/** Hook handler with return value (for modifying events) */
export type HookTransformer<T extends HookEvent = HookEvent> = (
  event: T
) => T | Promise<T>;

/** Hook registry */
const hookRegistry = new Map<HookEventType, Array<HookHandler>>();

// ============== Hook Management ==============

/** Register a hook */
export function registerHook<T extends HookEventType>(
  eventType: T,
  handler: HookHandler
): () => void {
  const handlers = hookRegistry.get(eventType) ?? [];
  handlers.push(handler);
  hookRegistry.set(eventType, handlers);

  logger.debug({ eventType }, "Hook registered");

  // Return unregister function
  return () => {
    const currentHandlers = hookRegistry.get(eventType);
    if (currentHandlers) {
      const index = currentHandlers.indexOf(handler);
      if (index >= 0) {
        currentHandlers.splice(index, 1);
      }
    }
  };
}

/** Register multiple hooks at once */
export function registerHooks(
  hooks: Partial<Record<HookEventType, HookHandler>>
): () => void {
  const unsubscribers: Array<() => void> = [];

  for (const [eventType, handler] of Object.entries(hooks)) {
    if (handler) {
      unsubscribers.push(registerHook(eventType as HookEventType, handler));
    }
  }

  return () => {
    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
  };
}

/** Trigger a hook */
export async function triggerHook(event: HookEvent): Promise<void> {
  const handlers = hookRegistry.get(event.type);
  if (!handlers || handlers.length === 0) return;

  for (const handler of handlers) {
    try {
      await handler(event);
    } catch (error) {
      logger.error({ error, eventType: event.type }, "Hook handler error");
    }
  }
}

/** Trigger a hook synchronously (fire-and-forget) */
export function triggerHookSync(event: HookEvent): void {
  triggerHook(event).catch((error) => {
    logger.error({ error, eventType: event.type }, "Hook trigger error");
  });
}

/** Clear all hooks */
export function clearHooks(): void {
  hookRegistry.clear();
}

/** Get the number of registered hooks */
export function getHookCount(eventType?: HookEventType): number {
  if (eventType) {
    return hookRegistry.get(eventType)?.length ?? 0;
  }
  let count = 0;
  for (const handlers of hookRegistry.values()) {
    count += handlers.length;
  }
  return count;
}

// ============== Convenience Functions ==============

/** Create event base data */
function createEventBase<T extends HookEventType>(
  type: T,
  sessionKey?: string
): HookEventBase & { type: T } {
  return {
    type,
    timestamp: Date.now(),
    sessionKey,
  };
}

/** Emit message received event */
export function emitMessageReceived(context: InboundMessageContext): void {
  triggerHookSync({
    ...createEventBase("message_received"),
    context,
  });
}

/** Emit message sending event */
export function emitMessageSending(params: {
  channelId: string;
  chatId: string;
  content: string;
  replyToId?: string;
  sessionKey?: string;
}): void {
  triggerHookSync({
    ...createEventBase("message_sending", params.sessionKey),
    channelId: params.channelId,
    chatId: params.chatId,
    content: params.content,
    replyToId: params.replyToId,
  });
}

/** Emit agent start event */
export function emitAgentStart(params: {
  provider: ProviderId;
  model: string;
  messages: ChatMessage[];
  sessionKey?: string;
}): void {
  triggerHookSync({
    ...createEventBase("agent_start", params.sessionKey),
    provider: params.provider,
    model: params.model,
    messages: params.messages,
  });
}

/** Emit agent end event */
export function emitAgentEnd(params: {
  provider: ProviderId;
  model: string;
  response: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  durationMs: number;
  sessionKey?: string;
}): void {
  triggerHookSync({
    ...createEventBase("agent_end", params.sessionKey),
    provider: params.provider,
    model: params.model,
    response: params.response,
    usage: params.usage,
    durationMs: params.durationMs,
  });
}

/** Emit tool start event */
export function emitToolStart(params: {
  toolName: string;
  toolCallId: string;
  arguments: unknown;
  sessionKey?: string;
}): void {
  triggerHookSync({
    ...createEventBase("tool_start", params.sessionKey),
    toolName: params.toolName,
    toolCallId: params.toolCallId,
    arguments: params.arguments,
  });
}

/** Emit tool end event */
export function emitToolEnd(params: {
  toolName: string;
  toolCallId: string;
  result: unknown;
  isError: boolean;
  durationMs: number;
  sessionKey?: string;
}): void {
  triggerHookSync({
    ...createEventBase("tool_end", params.sessionKey),
    toolName: params.toolName,
    toolCallId: params.toolCallId,
    result: params.result,
    isError: params.isError,
    durationMs: params.durationMs,
  });
}

/** Emit error event */
export function emitError(error: Error, context?: string): void {
  triggerHookSync({
    ...createEventBase("error"),
    error,
    context,
  });
}
