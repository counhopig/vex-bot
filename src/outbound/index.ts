/**
 * Outbound message delivery service
 *
 * Provides a unified message delivery interface for actively sending messages
 * across channels. Reference: moltbot's outbound module implementation.
 */

import type { ChannelId, SendResult, OutboundMessage } from "../types/index.js";
import { getChannel, getAllChannels } from "../channels/common/index.js";
import { emitMessageSending, emitMessageSent } from "../hooks/index.js";
import { getChildLogger } from "../utils/logger.js";

const logger = getChildLogger("outbound");

/** Race a channel send against a timeout. Channel.sendMessage has no timeout of
 *  its own, so a wedged transport would otherwise hang delivery indefinitely. */
function sendWithTimeout(
  send: Promise<SendResult>,
  timeoutMs: number | undefined,
): Promise<SendResult> {
  if (!timeoutMs || timeoutMs <= 0) return send;
  return new Promise<SendResult>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Channel send timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
    send.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/** Delivery target */
export interface DeliveryTarget {
  /** Channel ID */
  channel: ChannelId;
  /** Chat ID (user/group) */
  to: string;
  /** Account ID (optional, for multi-account scenarios) */
  accountId?: string;
}

/** Delivery payload */
export interface DeliveryPayload {
  /** Text content */
  text: string;
  /** Media URL list */
  mediaUrls?: string[];
  /** Reply-to message ID */
  replyToId?: string;
}

/** Delivery options */
export interface DeliveryOptions {
  /** Whether to use best-effort delivery (don't throw on error) */
  bestEffort?: boolean;
  /** Timeout (milliseconds) */
  timeoutMs?: number;
  /** Abort signal */
  abortSignal?: AbortSignal;
}

/** Delivery result */
export interface DeliveryResult {
  /** Whether delivery succeeded */
  success: boolean;
  /** Channel ID */
  channel: ChannelId;
  /** Message ID */
  messageId?: string;
  /** Error message */
  error?: string;
  /** Error details */
  errorDetails?: unknown;
}

/**
 * Parse delivery target
 * Supports "channel:chatId" format and "last" special value
 */
export function parseDeliveryTarget(
  target: string,
  fallbackChannel?: ChannelId
): DeliveryTarget | null {
  if (!target || target === "last") {
    // "last" needs to be resolved from session history; returning null means external handling
    return null;
  }

  // Try parsing "channel:chatId" format
  const colonIndex = target.indexOf(":");
  if (colonIndex > 0) {
    const channel = target.slice(0, colonIndex) as ChannelId;
    const to = target.slice(colonIndex + 1);
    if (channel && to) {
      return { channel, to };
    }
  }

  // If there is a fallback channel, use target as chatId
  if (fallbackChannel) {
    return { channel: fallbackChannel, to: target };
  }

  return null;
}

/**
 * Deliver a single message to the specified channel
 */
export async function deliverMessage(
  target: DeliveryTarget,
  payload: DeliveryPayload,
  options?: DeliveryOptions
): Promise<DeliveryResult> {
  const { channel: channelId, to } = target;
  const { bestEffort = false, timeoutMs } = options ?? {};

  logger.debug({ channelId, to, text: payload.text.slice(0, 100) }, "Delivering message");

  try {
    // Get the channel
    const channel = getChannel(channelId);
    if (!channel) {
      const error = `Channel not found: ${channelId}`;
      logger.warn({ channelId }, error);
      if (!bestEffort) {
        throw new Error(error);
      }
      return { success: false, channel: channelId, error };
    }

    // Build outbound message
    const message: OutboundMessage = {
      chatId: to,
      content: payload.text,
      replyToId: payload.replyToId,
      mediaUrls: payload.mediaUrls,
    };

    emitMessageSending({ channelId, chatId: to, content: payload.text, replyToId: payload.replyToId });

    // Send the message (bounded by timeoutMs when provided)
    const result = await sendWithTimeout(channel.sendMessage(message), timeoutMs);
    emitMessageSent({ channelId, chatId: to, messageId: result.messageId, success: result.success });

    if (result.success) {
      logger.info({ channelId, to, messageId: result.messageId }, "Message delivered");
      return {
        success: true,
        channel: channelId,
        messageId: result.messageId,
      };
    } else {
      logger.warn({ channelId, to, error: result.error }, "Message delivery failed");
      if (!bestEffort) {
        throw new Error(result.error ?? "Unknown error");
      }
      return {
        success: false,
        channel: channelId,
        error: result.error,
      };
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    emitMessageSent({ channelId, chatId: to, success: false });
    logger.error({ channelId, to, error }, "Message delivery error");

    if (!bestEffort) {
      throw err;
    }

    return {
      success: false,
      channel: channelId,
      error,
      errorDetails: err,
    };
  }
}

/**
 * Deliver multiple messages (batch)
 */
export async function deliverMessages(
  target: DeliveryTarget,
  payloads: DeliveryPayload[],
  options?: DeliveryOptions
): Promise<DeliveryResult[]> {
  const results: DeliveryResult[] = [];

  for (const payload of payloads) {
    // Check abort signal
    if (options?.abortSignal?.aborted) {
      results.push({
        success: false,
        channel: target.channel,
        error: "Aborted",
      });
      break;
    }

    try {
      // Always use bestEffort internally so we can collect results
      const result = await deliverMessage(target, payload, { ...options, bestEffort: true });
      results.push(result);

      // If not bestEffort mode and delivery failed, stop
      if (!result.success && !options?.bestEffort) {
        break;
      }
    } catch (err) {
      // This should not happen in theory since we use bestEffort internally
      const error = err instanceof Error ? err.message : String(err);
      results.push({
        success: false,
        channel: target.channel,
        error,
        errorDetails: err,
      });
      if (!options?.bestEffort) {
        break;
      }
    }
  }

  return results;
}

/**
 * Unified delivery interface - main entry point
 * Reference: moltbot's deliverOutboundPayloads
 */
export async function deliverOutboundPayloads(params: {
  /** Channel ID */
  channel: ChannelId;
  /** Target (chat ID) */
  to: string;
  /** Account ID (optional) */
  accountId?: string;
  /** Payloads to deliver */
  payloads: DeliveryPayload[];
  /** Whether to use best-effort delivery */
  bestEffort?: boolean;
  /** Abort signal */
  abortSignal?: AbortSignal;
}): Promise<DeliveryResult[]> {
  const { channel, to, payloads, bestEffort = false, abortSignal } = params;

  if (!payloads.length) {
    return [];
  }

  const target: DeliveryTarget = { channel, to, accountId: params.accountId };

  return deliverMessages(target, payloads, { bestEffort, abortSignal });
}

/**
 * Convenience method for sending a text message
 */
export async function sendText(
  channel: ChannelId,
  to: string,
  text: string,
  options?: DeliveryOptions
): Promise<DeliveryResult> {
  return deliverMessage(
    { channel, to },
    { text },
    options
  );
}

/**
 * Get all available channel IDs
 */
export function getAvailableChannels(): ChannelId[] {
  return getAllChannels().map((ch) => ch.id);
}

/**
 * Check whether a channel is available
 */
export function isChannelAvailable(channelId: ChannelId): boolean {
  return getChannel(channelId) !== undefined;
}
