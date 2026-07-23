/**
 * Dispatcher tests — single entry point for all inbound messages.
 *
 * Verifies:
 *   - dispatch() resolves user → config → agent → process → deliver
 *   - dispatchSynthetic() fills synthetic messageId/timestamp
 *   - webUserId from ctx is used for resolution
 *   - Error in agent processing propagates
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Dispatcher, type DispatchOutboundMessage } from "../src/dispatcher/Dispatcher.js";
import type { InboundMessageContext } from "../src/channels/ChannelAdapter.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function mockCtx(overrides?: Partial<InboundMessageContext>): InboundMessageContext {
  return {
    channelId: "webchat",
    messageId: "msg-001",
    chatId: "webchat:user1",
    chatType: "direct",
    senderId: "user1",
    content: "hello",
    timestamp: 1000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Dispatcher", () => {
  let configStore: { resolve: ReturnType<typeof vi.fn> };
  let agentRegistry: { getOrCreate: ReturnType<typeof vi.fn> };
  let deliver: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    configStore = { resolve: vi.fn() };
    agentRegistry = { getOrCreate: vi.fn() };
    deliver = vi.fn().mockResolvedValue(undefined);
  });

  // -- basic dispatch path -------------------------------------------------

  it("resolves user, fetches config, gets agent, processes, and delivers", async () => {
    const mockConfig = { userId: "user1", channelId: "webchat" };
    const mockAgent = { processMessage: vi.fn().mockResolvedValue({ content: "Hi there!" }) };

    configStore.resolve.mockResolvedValue(mockConfig);
    agentRegistry.getOrCreate.mockResolvedValue(mockAgent);

    const dispatcher = new Dispatcher(configStore as any, agentRegistry as any, deliver);
    await dispatcher.dispatch(mockCtx());

    expect(configStore.resolve).toHaveBeenCalledWith("user1", "webchat");
    expect(agentRegistry.getOrCreate).toHaveBeenCalledWith("user1", "webchat", mockConfig);
    expect(mockAgent.processMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: "hello", webUserId: "user1" }),
    );
    expect(deliver).toHaveBeenCalledWith({
      channelId: "webchat",
      webUserId: "user1",
      ctx: expect.objectContaining({ content: "hello" }),
      text: "Hi there!",
    });
  });

  // -- resolveUserId: uses webUserId when present on ctx -------------------

  it("uses ctx.webUserId when present for user resolution", async () => {
    const mockAgent = { processMessage: vi.fn().mockResolvedValue({ content: "ok" }) };
    configStore.resolve.mockResolvedValue({ userId: "webuser99", channelId: "webchat" });
    agentRegistry.getOrCreate.mockResolvedValue(mockAgent);

    const dispatcher = new Dispatcher(configStore as any, agentRegistry as any, deliver);
    await dispatcher.dispatch(mockCtx({ webUserId: "webuser99" }));

    expect(configStore.resolve).toHaveBeenCalledWith("webuser99", "webchat");
  });

  // -- dispatchSynthetic --------------------------------------------------

  it("dispatchSynthetic fills synthetic messageId and timestamp", async () => {
    const mockAgent = { processMessage: vi.fn().mockResolvedValue({ content: "synthetic reply" }) };
    configStore.resolve.mockResolvedValue({ userId: "cron", channelId: "weixin" });
    agentRegistry.getOrCreate.mockResolvedValue(mockAgent);

    const dispatcher = new Dispatcher(configStore as any, agentRegistry as any, deliver);
    await dispatcher.dispatchSynthetic({
      channelId: "weixin",
      chatId: "wx-chat",
      chatType: "direct",
      senderId: "cron-system",
      content: "time to check",
    });

    const ctxArg = mockAgent.processMessage.mock.calls[0]![0] as InboundMessageContext;
    expect(ctxArg.messageId).toMatch(/^synthetic-/);
    expect(ctxArg.timestamp).toBeGreaterThan(0);
    expect(ctxArg.content).toBe("time to check");
  });

  // -- error handling -----------------------------------------------------

  it("propagates errors from agent processing", async () => {
    const mockAgent = {
      processMessage: vi.fn().mockRejectedValue(new Error("LLM failure")),
    };
    configStore.resolve.mockResolvedValue({ userId: "user1", channelId: "webchat" });
    agentRegistry.getOrCreate.mockResolvedValue(mockAgent);

    const dispatcher = new Dispatcher(configStore as any, agentRegistry as any, deliver);

    await expect(dispatcher.dispatch(mockCtx())).rejects.toThrow("LLM failure");
    // Deliver should NOT be called on failure
    expect(deliver).not.toHaveBeenCalled();
  });

  it("propagates errors from configStore.resolve", async () => {
    configStore.resolve.mockRejectedValue(new Error("config error"));
    agentRegistry.getOrCreate.mockResolvedValue({ processMessage: vi.fn() });

    const dispatcher = new Dispatcher(configStore as any, agentRegistry as any, deliver);

    await expect(dispatcher.dispatch(mockCtx())).rejects.toThrow("config error");
    expect(deliver).not.toHaveBeenCalled();
  });

  it("propagates errors from agentRegistry.getOrCreate", async () => {
    configStore.resolve.mockResolvedValue({ userId: "user1", channelId: "webchat" });
    agentRegistry.getOrCreate.mockRejectedValue(new Error("registry error"));

    const dispatcher = new Dispatcher(configStore as any, agentRegistry as any, deliver);

    await expect(dispatcher.dispatch(mockCtx())).rejects.toThrow("registry error");
    expect(deliver).not.toHaveBeenCalled();
  });
});
