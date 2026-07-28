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

export interface ChannelMeta {
  id: ChannelId;
  name: string;
  description: string;
  capabilities: ChannelCapabilities;
}

export interface ChannelCapabilities {
  chatTypes: ChatType[];
  supportsMedia: boolean;
  supportsReply: boolean;
  supportsMention: boolean;
  supportsReaction: boolean;
  supportsThread: boolean;
  supportsEdit: boolean;
  maxMessageLength: number;
}

export interface ChannelAdapter {
  readonly id: ChannelId;
  readonly meta: ChannelMeta;

  initialize(): Promise<void>;
  shutdown(): Promise<void>;

  sendMessage(message: OutboundMessage): Promise<SendResult>;
  replyToContext(ctx: InboundMessageContext, text: string): Promise<SendResult>;

  isHealthy(): Promise<boolean>;

  /** Registers the single callback Dispatcher uses to receive messages from this channel. */
  onMessage(handler: (ctx: InboundMessageContext) => Promise<void>): void;
}

export interface ChannelRegistry {
  register(channel: ChannelAdapter): void;
  unregister(channelId: ChannelId): void;
  getChannel(channelId: ChannelId): ChannelAdapter | undefined;
  getAllChannels(): ChannelAdapter[];

  /** Per-user dynamic instances (e.g. a user's own WeChat login), scoped
   *  on top of the flat registry above. Falls back to getChannel() when
   *  no per-user instance is registered. */
  registerForUser(userId: string, channelId: ChannelId, channel: ChannelAdapter): void;
  unregisterForUser(userId: string, channelId: ChannelId): void;
  getChannelForUser(userId: string, channelId: ChannelId): ChannelAdapter | undefined;
}
