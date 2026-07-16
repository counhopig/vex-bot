/**
 * Channel registry
 */

import type { ChannelId } from "../../types/index.js";
import type { ChannelAdapter } from "./base.js";
import { getChildLogger } from "../../utils/logger.js";

export * from "./base.js";

const logger = getChildLogger("channels");

/** Channel registry (deliberately process-global: channels are process-level
 *  transports; per-user weixin channels are managed by the Gateway, not here) */
const channels = new Map<ChannelId, ChannelAdapter>();

/** Register a channel. The caller is responsible for setting the message
 *  handler on the channel before registering it. */
export function registerChannel(channel: ChannelAdapter): void {
  channels.set(channel.id, channel);
  logger.info({ channel: channel.id }, "Channel registered");
}

/** Get a channel by ID */
export function getChannel(id: ChannelId): ChannelAdapter | undefined {
  return channels.get(id);
}

/** Get all channels */
export function getAllChannels(): ChannelAdapter[] {
  return Array.from(channels.values());
}

