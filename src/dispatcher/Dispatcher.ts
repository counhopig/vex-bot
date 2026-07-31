/**
 * Dispatcher — single entry point for all inbound messages.
 *
 * Architecture doc (§2): Every message, regardless of channel, flows through
 * the same Dispatcher → Agent pipeline. No globalAgent vs UserRuntimeManager
 * divergence.
 *
 * Data flow (architecture doc §10):
 *   1. CHANNEL normalizes raw message → InboundMessageContext
 *   2. CHANNEL emits to Dispatcher: dispatcher.dispatch(ctx)
 *   3. DISPATCHER resolves: userId → config → agent
 *   4. AGENT processes message
 *   5. DISPATCHER sends response via deliver callback (→ OutboundDeliver)
 *
 * dispatchSynthetic() is a second entry point for Cron (and other non-channel
 * triggers) so Cron depends on this one method rather than on AgentRegistry
 * directly — keeps the dependency direction one-way (architecture doc §4).
 */

import type { ConfigStore } from "../config/ConfigStore.js";
import type { AgentRegistry } from "../agent/AgentRegistry.js";
import type { InboundMessageContext, ChannelId } from "../channels/ChannelAdapter.js";
import { getChildLogger } from "../utils/logger.js";
import { emitMessageReceived } from "../hooks/index.js";

const logger = getChildLogger("dispatcher");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DispatchOutboundMessage {
  channelId: ChannelId;
  webUserId?: string;
  ctx: InboundMessageContext;
  text: string;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export class Dispatcher {
  constructor(
    private readonly configStore: ConfigStore,
    private readonly agentRegistry: AgentRegistry<{ processMessage(ctx: InboundMessageContext): Promise<{ content: string }>; shutdown(): Promise<void> }>,
    private readonly deliver: (msg: DispatchOutboundMessage) => Promise<void>,
  ) {}

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Process an inbound message from any channel.
   * Resolves userId → config → agent → process → deliver.
   */
  async dispatch(ctx: InboundMessageContext): Promise<void> {
    emitMessageReceived(ctx);
    const userId = this.resolveUserId(ctx);
    logger.debug({ userId, channelId: ctx.channelId, content: ctx.content.slice(0, 100) }, "Dispatching message");

    const config = await this.configStore.resolve(userId, ctx.channelId);
    const agent = await this.agentRegistry.getOrCreate(userId, ctx.channelId, config);

    const response = await agent.processMessage({ ...ctx, webUserId: userId });
    logger.debug({ userId, responseLength: response.content.length }, "Message processed");

    await this.deliver({
      channelId: ctx.channelId,
      webUserId: userId,
      ctx,
      text: response.content,
    });
  }

  /**
   * Synthetic entry point for Cron (and other non-channel triggers).
   * Fills synthetic messageId and timestamp so the downstream pipeline
   * always has valid fields.
   */
  async dispatchSynthetic(
    ctx: Omit<InboundMessageContext, "messageId" | "timestamp">,
  ): Promise<void> {
    return this.dispatch({
      ...ctx,
      messageId: `synthetic-${Date.now()}`,
      timestamp: Date.now(),
    });
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  /**
   * Resolve the web user identifier from the inbound context.
   *
   * Priority:
   *   1. ctx.webUserId (set by channel or a previous resolver)
   *   2. ctx.senderId (raw sender identifier from the channel protocol)
   *
   * In the full architecture a ChannelUserMapper service handles the
   * (channelId, senderId) → webUserId mapping. For now this covers
   * the common cases without introducing a new dependency.
   */
  private resolveUserId(ctx: InboundMessageContext): string {
    return ctx.webUserId ?? ctx.senderId;
  }
}
