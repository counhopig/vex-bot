/**
 * Channel registry
 */

import type { ChannelId } from "../../types/index.js";
import type { ChannelAdapter, MessageHandler } from "./base.js";
import { getChildLogger } from "../../utils/logger.js";

export * from "./base.js";

const logger = getChildLogger("channels");

/** Channel registry */
const channels = new Map<ChannelId, ChannelAdapter>();

/** Global message handler */
let globalMessageHandler: MessageHandler | undefined;

/** Register a channel */
export function registerChannel(channel: ChannelAdapter): void {
  channels.set(channel.id, channel);

  // If there is a global message handler, set it on the channel
  if (globalMessageHandler && "setMessageHandler" in channel) {
    (channel as { setMessageHandler: (h: MessageHandler) => void }).setMessageHandler(
      globalMessageHandler
    );
  }

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

/** Check whether a channel is available */
export function hasChannel(id: ChannelId): boolean {
  return channels.has(id);
}

/** Set the global message handler */
export function setGlobalMessageHandler(handler: MessageHandler): void {
  globalMessageHandler = handler;

  // Update handlers for all registered channels
  for (const channel of channels.values()) {
    if ("setMessageHandler" in channel) {
      (channel as { setMessageHandler: (h: MessageHandler) => void }).setMessageHandler(handler);
    }
  }
}

/** Initialize all channels */
export async function initializeAllChannels(): Promise<void> {
  for (const channel of channels.values()) {
    try {
      await channel.initialize();
      logger.info({ channel: channel.id }, "Channel initialized");
    } catch (error) {
      logger.error({ channel: channel.id, error }, "Failed to initialize channel");
    }
  }
}

/** Shut down all channels */
export async function shutdownAllChannels(): Promise<void> {
  for (const channel of channels.values()) {
    try {
      await channel.shutdown();
      logger.info({ channel: channel.id }, "Channel shut down");
    } catch (error) {
      logger.error({ channel: channel.id, error }, "Failed to shut down channel");
    }
  }
}
