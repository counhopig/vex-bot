/**
 * ChannelAdapter — interface and shared types for external protocol adapters.
 *
 * Architecture doc (§1): Channels are dumb pipes. They only translate
 * protocols; they don't know about agents, personas, or business logic.
 *
 * This file defines the types used by the Dispatcher and Outbound modules
 * to communicate with channels. The full ChannelAdapter interface and
 * ChannelRegistry will be completed when the channel module is built.
 *
 * Interface definitions per rewrite-plan §3 (关键接口定义).
 */

export type ChannelId = "weixin" | "webchat";
export type ChatType = "direct" | "group";

export interface InboundMessageContext {
  channelId: ChannelId;
  messageId: string;
  chatId: string;
  chatType: ChatType;
  senderId: string;
  senderName?: string;
  content: string;
  mediaUrls?: string[];
  replyToId?: string;
  mentions?: string[];
  timestamp: number;
  /** Set by Dispatcher after resolving the (channel, sender) → web user mapping. */
  webUserId?: string;
  raw?: unknown;
}

export interface OutboundMessage {
  chatId: string;
  content: string;
  replyToId?: string;
  mediaUrls?: string[];
  mentions?: string[];
}

export interface SendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}
