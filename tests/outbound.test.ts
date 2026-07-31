/**
 * OutboundDeliver tests — unified delivery through ChannelRegistry.
 *
 * Verifies:
 *   - deliverText to a flat-registered channel
 *   - deliverText to a per-user channel
 *   - fallback to flat channel when no per-user entry
 *   - unknown channel returns failure
 *   - channel send timeout is enforced
 *   - sendText convenience method
 */

import { describe, it, expect, vi } from "vitest";
import { OutboundDeliver } from "../src/outbound/OutboundDeliver.js";
import { ChannelRegistryImpl } from "../src/channels/ChannelRegistry.js";
import type { ChannelAdapter, ChannelId, InboundMessageContext, OutboundMessage, SendResult, ChannelMeta } from "../src/channels/ChannelAdapter.js";
import * as hooks from "../src/hooks/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockChannel(id: ChannelId, sendImpl?: (msg: OutboundMessage) => Promise<SendResult>): ChannelAdapter {
  const meta: ChannelMeta = {
    id,
    name: id,
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
    sendMessage: sendImpl ?? (async (_msg) => ({ success: true, messageId: "mid-1" })),
    replyToContext: async (_ctx, _text) => ({ success: true }),
    isHealthy: async () => true,
    onMessage: () => {},
  } as ChannelAdapter;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("OutboundDeliver", () => {
  // -- flat channel delivery -----------------------------------------------

  it("delivers to a flat-registered channel", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ success: true, messageId: "wx-001" });
    const registry = new ChannelRegistryImpl();
    registry.register(mockChannel("weixin", sendMessage));

    const deliver = new OutboundDeliver(registry);
    const result = await deliver.sendText("weixin", "chat-123", "Hello");

    expect(result.success).toBe(true);
    expect(result.messageId).toBe("wx-001");
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "chat-123", content: "Hello" }),
    );
  });

  // -- per-user channel delivery -------------------------------------------

  it("delivers to a per-user channel when registered", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ success: true, messageId: "user-wx-001" });
    const registry = new ChannelRegistryImpl();
    registry.registerForUser("user1", "weixin", mockChannel("weixin", sendMessage));

    const deliver = new OutboundDeliver(registry);
    const result = await deliver.sendText("weixin", "chat-123", "Hi", { webUserId: "user1" });

    expect(result.success).toBe(true);
    expect(sendMessage).toHaveBeenCalled();
  });

  // -- per-user fallback to flat -------------------------------------------

  it("falls back to flat channel when no per-user entry exists", async () => {
    const flatSend = vi.fn().mockResolvedValue({ success: true, messageId: "flat-001" });
    const registry = new ChannelRegistryImpl();
    registry.register(mockChannel("weixin", flatSend));

    const deliver = new OutboundDeliver(registry);
    const result = await deliver.sendText("weixin", "chat-123", "Hi", { webUserId: "unknown-user" });

    expect(result.success).toBe(true);
    expect(flatSend).toHaveBeenCalled();
  });

  // -- unknown channel -----------------------------------------------------

  it("returns failure for an unknown channelId", async () => {
    const registry = new ChannelRegistryImpl();
    const deliver = new OutboundDeliver(registry);

    const result = await deliver.sendText("weixin" as ChannelId, "chat-123", "Hello");

    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  // -- send timeout --------------------------------------------------------

  it("enforces a send timeout", async () => {
    vi.useFakeTimers();
    try {
      const registry = new ChannelRegistryImpl();
      registry.register(mockChannel("webchat", async () => {
        await new Promise((resolve) => setTimeout(resolve, 60_000));
        return { success: true };
      }));

      const deliver = new OutboundDeliver(registry);
      const resultPromise = deliver.sendText("webchat", "chat-1", "slow", { timeoutMs: 5_000 });

      await vi.advanceTimersByTimeAsync(6_000);
      const result = await resultPromise;

      expect(result.success).toBe(false);
      expect(result.error).toContain("timed out");
    } finally {
      vi.useRealTimers();
    }
  });

  // -- delivery error from channel -----------------------------------------

  it("propagates a channel-level send failure", async () => {
    const registry = new ChannelRegistryImpl();
    registry.register(mockChannel("webchat", async () => ({
      success: false,
      error: "rate limited",
    })));

    const deliver = new OutboundDeliver(registry);
    const result = await deliver.sendText("webchat", "chat-1", "fail");

    expect(result.success).toBe(false);
    expect(result.error).toContain("rate limited");
  });

  // -- hook wiring: emitMessageSending + emitMessageSent around the send -

  it("emits message_sending before and message_sent after a successful send", async () => {
    const sent = vi.spyOn(hooks, "emitMessageSending").mockImplementation(() => {});
    const done = vi.spyOn(hooks, "emitMessageSent").mockImplementation(() => {});
    const registry = new ChannelRegistryImpl();
    registry.register(mockChannel("webchat", async () => ({ success: true, messageId: "m1" })));

    const deliver = new OutboundDeliver(registry);
    await deliver.sendText("webchat", "chat-1", "hi");

    expect(sent).toHaveBeenCalledTimes(1);
    expect(sent.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ channelId: "webchat", chatId: "chat-1", content: "hi" }),
    );
    expect(done).toHaveBeenCalledTimes(1);
    expect(done.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ channelId: "webchat", chatId: "chat-1", success: true }),
    );
    sent.mockRestore();
    done.mockRestore();
  });

  it("emits message_sent with success=false on a channel failure", async () => {
    const done = vi.spyOn(hooks, "emitMessageSent").mockImplementation(() => {});
    const registry = new ChannelRegistryImpl();
    registry.register(mockChannel("webchat", async () => ({ success: false, error: "boom" })));

    const deliver = new OutboundDeliver(registry);
    await deliver.sendText("webchat", "chat-1", "hi");

    expect(done.mock.calls[0]?.[0].success).toBe(false);
    done.mockRestore();
  });
});
