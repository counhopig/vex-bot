/**
 * Hooks module — type definitions.
 *
 * Ported from _archive/src/hooks/index.ts. The discriminated union
 * of hook events is preserved exactly: message_received/sending/sent,
 * agent_start/end, tool_start/end, error. Each event has a `type`
 * discriminator + shared `timestamp`/`sessionKey` fields.
 */

import type { InboundMessageContext } from "../channels/ChannelAdapter.js";
import type { ChatMessage } from "../agent/messages.js";

export type HookEventType =
  | "message_received"
  | "message_sending"
  | "message_sent"
  | "agent_start"
  | "agent_end"
  | "tool_start"
  | "tool_end"
  | "error";

interface HookEventBase {
  type: HookEventType;
  timestamp: number;
  sessionKey?: string;
}

export interface MessageReceivedEvent extends HookEventBase {
  type: "message_received";
  context: InboundMessageContext;
}

export interface MessageSendingEvent extends HookEventBase {
  type: "message_sending";
  channelId: string;
  chatId: string;
  content: string;
  replyToId?: string;
}

export interface MessageSentEvent extends HookEventBase {
  type: "message_sent";
  channelId: string;
  chatId: string;
  messageId?: string;
  success: boolean;
}

export interface AgentStartEvent extends HookEventBase {
  type: "agent_start";
  provider: string;
  model: string;
  messages: ChatMessage[];
}

export interface AgentEndEvent extends HookEventBase {
  type: "agent_end";
  provider: string;
  model: string;
  response: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  durationMs: number;
}

export interface ToolStartEvent extends HookEventBase {
  type: "tool_start";
  toolName: string;
  toolCallId: string;
  arguments: unknown;
}

export interface ToolEndEvent extends HookEventBase {
  type: "tool_end";
  toolName: string;
  toolCallId: string;
  result: unknown;
  isError: boolean;
  durationMs: number;
}

export interface ErrorEvent extends HookEventBase {
  type: "error";
  error: Error;
  context?: string;
}

export type HookEvent =
  | MessageReceivedEvent
  | MessageSendingEvent
  | MessageSentEvent
  | AgentStartEvent
  | AgentEndEvent
  | ToolStartEvent
  | ToolEndEvent
  | ErrorEvent;

/** A handler subscribed to a specific event type. */
export type HookHandler<T extends HookEvent = HookEvent> = (
  event: T,
) => void | Promise<void>;

/** Convenience shape for batch subscription. */
export type HookMap = Partial<Record<HookEventType, HookHandler>>;