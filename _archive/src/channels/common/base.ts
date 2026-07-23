/**
 * Channel base class and interfaces
 */

import type {
  ChannelId,
  ChannelMeta,
  ChannelCapabilities,
  InboundMessageContext,
  OutboundMessage,
  SendResult,
} from "../../types/index.js";
import { getChildLogger } from "../../utils/logger.js";

/** Channel adapter interface */
export interface ChannelAdapter {
  /** Channel ID */
  id: ChannelId;

  /** Channel metadata */
  meta: ChannelMeta;

  /** Initialize the channel */
  initialize(): Promise<void>;

  /** Shut down the channel */
  shutdown(): Promise<void>;

  /** Send a message */
  sendMessage(message: OutboundMessage): Promise<SendResult>;

  /** Send a text message */
  sendText(chatId: string, text: string, replyToId?: string): Promise<SendResult>;

  /**
   * Reply based on inbound message context (called by Gateway uniformly;
   * channels may override for session-level replies, etc.)
   */
  replyToContext(context: InboundMessageContext, text: string): Promise<SendResult>;

  /** Check channel health status */
  isHealthy(): Promise<boolean>;
}

/** Message handler type */
export type MessageHandler = (context: InboundMessageContext) => Promise<void>;

/** Channel base class */
export abstract class BaseChannelAdapter implements ChannelAdapter {
  abstract id: ChannelId;
  abstract meta: ChannelMeta;

  protected logger = getChildLogger("channel");
  protected messageHandler?: MessageHandler;

  /** Set the message handler */
  setMessageHandler(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  /** Handle an inbound message */
  protected async handleInboundMessage(context: InboundMessageContext): Promise<void> {
    if (this.messageHandler) {
      await this.messageHandler(context);
    } else {
      this.logger.warn("No message handler registered");
    }
  }

  abstract initialize(): Promise<void>;
  abstract shutdown(): Promise<void>;
  abstract sendMessage(message: OutboundMessage): Promise<SendResult>;
  abstract sendText(chatId: string, text: string, replyToId?: string): Promise<SendResult>;

  /** Default implementation: calls sendText with chatId and messageId */
  async replyToContext(context: InboundMessageContext, text: string): Promise<SendResult> {
    return this.sendText(context.chatId, text, context.messageId);
  }

  abstract isHealthy(): Promise<boolean>;
}
