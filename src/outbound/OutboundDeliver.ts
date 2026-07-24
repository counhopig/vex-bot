/**
 * OutboundDeliver — unified cross-channel message delivery.
 *
 * Architecture doc (§10): Routes Agent responses through the correct Channel
 * adapter. Receives OutboundMessage and resolves the target channel via
 * ChannelRegistry (with per-user fallback), enforcing a configurable timeout.
 *
 * This is the downstream half of the Dispatcher's deliver callback — the
 * Dispatcher calls deliver() which this module implements.
 */

import type { ChannelRegistry, ChannelId, OutboundMessage, SendResult } from "../channels/ChannelAdapter.js";
import { getChildLogger } from "../utils/logger.js";

const logger = getChildLogger("outbound");

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface SendTextOptions {
  /** Per-user channel override (for user-scoped WeChat instances). */
  webUserId?: string;
  /** Delivery timeout in milliseconds (default: 30s). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendWithTimeout(
  send: Promise<SendResult>,
  timeoutMs: number,
  label: string,
): Promise<SendResult> {
  return new Promise<SendResult>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Channel send timed out after ${timeoutMs}ms (${label})`)),
      timeoutMs,
    );
    timer.unref?.();
    send.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

// ---------------------------------------------------------------------------
// OutboundDeliver
// ---------------------------------------------------------------------------

export class OutboundDeliver {
  constructor(private readonly registry: ChannelRegistry) {}

  /** Convenience: send a text message to a channel. */
  async sendText(
    channelId: ChannelId,
    chatId: string,
    content: string,
    options?: SendTextOptions,
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    const channel = options?.webUserId
      ? this.registry.getChannelForUser(options.webUserId, channelId)
      : this.registry.getChannel(channelId);

    if (!channel) {
      const msg = `Channel not found: ${channelId}`;
      logger.warn({ channelId }, msg);
      return { success: false, error: msg };
    }

    const message: OutboundMessage = { chatId, content };
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    try {
      const result = await sendWithTimeout(
        channel.sendMessage(message),
        timeoutMs,
        `${channelId}:${chatId}`,
      );

      if (result.success) {
        logger.info({ channelId, chatId, messageId: result.messageId }, "Message delivered");
        return { success: true, messageId: result.messageId };
      }

      logger.warn({ channelId, chatId, error: result.error }, "Message delivery failed");
      return { success: false, error: result.error ?? "Unknown error" };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error({ channelId, chatId, error }, "Message delivery error");
      return { success: false, error };
    }
  }
}
