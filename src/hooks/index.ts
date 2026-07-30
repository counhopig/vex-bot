/**
 * Hooks module — barrel.
 *
 * Re-exports types, the EventBus class + defaultBus, and the
 * convenience `emit*` functions ported from _archive/src/hooks/index.ts.
 * The convenience functions dispatch to `defaultBus.emitSync()`.
 */

export * from "./types.js";
export { EventBus, defaultBus } from "./EventBus.js";
import { defaultBus } from "./EventBus.js";
import type {
  ChatMessage,
} from "../agent/messages.js";
import type { InboundMessageContext } from "../channels/ChannelAdapter.js";

/** Build the shared base (timestamp + optional sessionKey). */
function base(
  type: import("./types.js").HookEventType,
  sessionKey?: string,
) {
  return {
    type,
    timestamp: Date.now(),
    sessionKey,
  };
}

/** Emit a `message_received` event. */
export function emitMessageReceived(context: InboundMessageContext): void {
  defaultBus.emitSync({
    ...base("message_received"),
    type: "message_received",
    context,
  });
}

/** Emit a `message_sending` event. */
export function emitMessageSending(params: {
  channelId: string;
  chatId: string;
  content: string;
  replyToId?: string;
  sessionKey?: string;
}): void {
  defaultBus.emitSync({
    ...base("message_sending", params.sessionKey),
    type: "message_sending",
    channelId: params.channelId,
    chatId: params.chatId,
    content: params.content,
    replyToId: params.replyToId,
  });
}

/** Emit a `message_sent` event. */
export function emitMessageSent(params: {
  channelId: string;
  chatId: string;
  messageId?: string;
  success: boolean;
  sessionKey?: string;
}): void {
  defaultBus.emitSync({
    ...base("message_sent", params.sessionKey),
    type: "message_sent",
    channelId: params.channelId,
    chatId: params.chatId,
    messageId: params.messageId,
    success: params.success,
  });
}

/** Emit an `agent_start` event. */
export function emitAgentStart(params: {
  provider: string;
  model: string;
  messages: ChatMessage[];
  sessionKey?: string;
}): void {
  defaultBus.emitSync({
    ...base("agent_start", params.sessionKey),
    type: "agent_start",
    provider: params.provider,
    model: params.model,
    messages: params.messages,
  });
}

/** Emit an `agent_end` event. */
export function emitAgentEnd(params: {
  provider: string;
  model: string;
  response: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  durationMs: number;
  sessionKey?: string;
}): void {
  defaultBus.emitSync({
    ...base("agent_end", params.sessionKey),
    type: "agent_end",
    provider: params.provider,
    model: params.model,
    response: params.response,
    usage: params.usage,
    durationMs: params.durationMs,
  });
}

/** Emit a `tool_start` event. */
export function emitToolStart(params: {
  toolName: string;
  toolCallId: string;
  arguments: unknown;
  sessionKey?: string;
}): void {
  defaultBus.emitSync({
    ...base("tool_start", params.sessionKey),
    type: "tool_start",
    toolName: params.toolName,
    toolCallId: params.toolCallId,
    arguments: params.arguments,
  });
}

/** Emit a `tool_end` event. */
export function emitToolEnd(params: {
  toolName: string;
  toolCallId: string;
  result: unknown;
  isError: boolean;
  durationMs: number;
  sessionKey?: string;
}): void {
  defaultBus.emitSync({
    ...base("tool_end", params.sessionKey),
    type: "tool_end",
    toolName: params.toolName,
    toolCallId: params.toolCallId,
    result: params.result,
    isError: params.isError,
    durationMs: params.durationMs,
  });
}

/** Emit an `error` event. */
export function emitError(error: Error, context?: string): void {
  defaultBus.emitSync({
    ...base("error"),
    type: "error",
    error,
    context,
  });
}