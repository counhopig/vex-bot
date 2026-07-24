/**
 * ChannelRegistry tests — per-user channel instances with flat fallback.
 *
 * Verifies:
 *   - register / unregister / getChannel / getAllChannels
 *   - registerForUser / unregisterForUser / getChannelForUser
 *   - getChannelForUser falls back to flat getChannel when no per-user instance
 *   - Per-user instance shadows flat instance for the same (userId, channelId)
 */

import { describe, it, expect } from "vitest";
import { ChannelRegistryImpl } from "../src/channels/ChannelRegistry.js";
import type { ChannelAdapter, ChannelId } from "../src/channels/ChannelAdapter.js";
import type { InboundMessageContext, OutboundMessage, SendResult, ChannelMeta } from "../src/channels/ChannelAdapter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockChannel(id: ChannelId, name?: string): ChannelAdapter {
  const meta: ChannelMeta = {
    id,
    name: name ?? id,
    description: "",
    capabilities: {
      chatTypes: ["direct"],
      supportsMedia: false,
      supportsReply: false,
      supportsMention: false,
      supportsReaction: false,
      supportsThread: false,
      supportsEdit: false,
      maxMessageLength: 4096,
    },
  };
  return {
    id,
    meta,
    initialize: async () => {},
    shutdown: async () => {},
    sendMessage: async (_msg: OutboundMessage): Promise<SendResult> => ({ success: true }),
    replyToContext: async (_ctx: InboundMessageContext, _text: string): Promise<SendResult> => ({ success: true }),
    isHealthy: async () => true,
    onMessage: (_handler: (ctx: InboundMessageContext) => Promise<void>) => {},
  } as ChannelAdapter;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("ChannelRegistry", () => {
  // -- flat registry -------------------------------------------------------

  it("registers and returns a channel by ChannelId", () => {
    const reg = new ChannelRegistryImpl();
    const ch = mockChannel("webchat");
    reg.register(ch);

    expect(reg.getChannel("webchat")).toBe(ch);
  });

  it("returns undefined for an unknown ChannelId", () => {
    const reg = new ChannelRegistryImpl();
    expect(reg.getChannel("weixin")).toBeUndefined();
  });

  it("unregisters a channel", () => {
    const reg = new ChannelRegistryImpl();
    const ch = mockChannel("webchat");
    reg.register(ch);
    reg.unregister("webchat");

    expect(reg.getChannel("webchat")).toBeUndefined();
  });

  it("getAllChannels returns all registered channels", () => {
    const reg = new ChannelRegistryImpl();
    const wc = mockChannel("webchat");
    const wx = mockChannel("weixin");
    reg.register(wc);
    reg.register(wx);

    const all = reg.getAllChannels();
    expect(all).toHaveLength(2);
    expect(all).toContain(wc);
    expect(all).toContain(wx);
  });

  // -- per-user registry ---------------------------------------------------

  it("registerForUser stores a per-user channel", () => {
    const reg = new ChannelRegistryImpl();
    const ch = mockChannel("weixin");
    reg.registerForUser("user1", "weixin", ch);

    expect(reg.getChannelForUser("user1", "weixin")).toBe(ch);
  });

  it("unregisterForUser removes a per-user channel", () => {
    const reg = new ChannelRegistryImpl();
    const ch = mockChannel("weixin");
    reg.registerForUser("user1", "weixin", ch);
    reg.unregisterForUser("user1", "weixin");

    expect(reg.getChannelForUser("user1", "weixin")).toBeUndefined();
  });

  // -- fallback: per-user miss → flat default ------------------------------

  it("getChannelForUser falls back to flat getChannel when no per-user instance", () => {
    const reg = new ChannelRegistryImpl();
    const flat = mockChannel("weixin");
    reg.register(flat);

    // No per-user instance for user1 → should return the flat one
    expect(reg.getChannelForUser("user1", "weixin")).toBe(flat);
  });

  it("per-user instance shadows the flat instance for the same (userId, channelId)", () => {
    const reg = new ChannelRegistryImpl();
    const flat = mockChannel("weixin");
    const perUser = mockChannel("weixin");
    reg.register(flat);
    reg.registerForUser("user1", "weixin", perUser);

    // user1 should get the per-user instance
    expect(reg.getChannelForUser("user1", "weixin")).toBe(perUser);
    // Different user (no per-user) should get the flat instance
    expect(reg.getChannelForUser("user2", "weixin")).toBe(flat);
  });

  it("returns undefined for completely unknown channel", () => {
    const reg = new ChannelRegistryImpl();
    expect(reg.getChannelForUser("user1", "webchat")).toBeUndefined();
  });
});
