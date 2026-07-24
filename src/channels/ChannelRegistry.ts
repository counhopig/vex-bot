/**
 * ChannelRegistry — shared channel lookup for Dispatcher, Outbound, and
 * web/server.ts lifecycle management.
 *
 * Architecture doc: "Lives in channels/ (not dispatcher/) precisely because
 * Outbound needs it too, and neither Dispatcher nor Outbound should import
 * from the other."
 *
 * Per-user dynamic instances (e.g. a user's own WeChat login) are scoped on
 * top of the flat registry. getChannelForUser() falls back to getChannel()
 * when no per-user instance is registered.
 */

import type { ChannelAdapter, ChannelId, ChannelRegistry } from "./ChannelAdapter.js";

export class ChannelRegistryImpl implements ChannelRegistry {
  private readonly channels = new Map<ChannelId, ChannelAdapter>();
  /** Key: `${channelId}:${userId}` */
  private readonly userChannels = new Map<string, ChannelAdapter>();

  // -----------------------------------------------------------------------
  // Flat registry
  // -----------------------------------------------------------------------

  register(channel: ChannelAdapter): void {
    this.channels.set(channel.id, channel);
  }

  unregister(channelId: ChannelId): void {
    this.channels.delete(channelId);
  }

  getChannel(channelId: ChannelId): ChannelAdapter | undefined {
    return this.channels.get(channelId);
  }

  getAllChannels(): ChannelAdapter[] {
    return [...this.channels.values()];
  }

  // -----------------------------------------------------------------------
  // Per-user registry
  // -----------------------------------------------------------------------

  registerForUser(userId: string, channelId: ChannelId, channel: ChannelAdapter): void {
    this.userChannels.set(this.userKey(userId, channelId), channel);
  }

  unregisterForUser(userId: string, channelId: ChannelId): void {
    this.userChannels.delete(this.userKey(userId, channelId));
  }

  getChannelForUser(userId: string, channelId: ChannelId): ChannelAdapter | undefined {
    return this.userChannels.get(this.userKey(userId, channelId)) ?? this.channels.get(channelId);
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private userKey(userId: string, channelId: ChannelId): string {
    return `${channelId}:${userId}`;
  }
}
