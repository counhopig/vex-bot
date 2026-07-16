/**
 * Hook wiring tests — the hooks event bus must be fired by the real
 * message/agent/tool flow, not sit as a dead API that never emits.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/utils/logger.js", () => ({
  getChildLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  setLogger: vi.fn(),
  getLogDir: () => "/tmp",
  getLogFile: () => "/tmp/test.log",
}));

vi.mock("../src/channels/common/index.js", () => ({
  getChannel: vi.fn(),
  getAllChannels: vi.fn(() => []),
  registerChannel: vi.fn(),
}));

import { registerHook, clearHooks } from "../src/hooks/index.js";
import { getChannel } from "../src/channels/common/index.js";
import { deliverMessage } from "../src/outbound/index.js";
import { clearPipeline } from "../src/pipeline/index.js";
import type { InboundMessageContext } from "../src/types/index.js";

const flush = () => new Promise((r) => setTimeout(r, 20));

function makeContext(overrides?: Partial<InboundMessageContext>): InboundMessageContext {
  return {
    channelId: "weixin",
    messageId: `msg-${Math.random().toString(36).slice(2)}`,
    chatId: "chat-1",
    chatType: "direct",
    senderId: "user-1",
    content: "hello",
    timestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  } as InboundMessageContext;
}

describe("hooks wiring", () => {
  beforeEach(() => {
    clearHooks();
    clearPipeline();
    vi.clearAllMocks();
  });

  afterEach(() => {
    clearHooks();
  });

  describe("outbound deliverMessage", () => {
    it("emits message_sending and message_sent(success) around a successful send", async () => {
      (getChannel as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "weixin",
        sendMessage: vi.fn().mockResolvedValue({ success: true, messageId: "m-1" }),
      });
      const sending = vi.fn();
      const sent = vi.fn();
      registerHook("message_sending", sending);
      registerHook("message_sent", sent);

      await deliverMessage({ channel: "weixin", to: "u-1" }, { text: "hi" });
      await flush();

      expect(sending).toHaveBeenCalledWith(
        expect.objectContaining({ type: "message_sending", channelId: "weixin", chatId: "u-1", content: "hi" }),
      );
      expect(sent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "message_sent", channelId: "weixin", chatId: "u-1", success: true, messageId: "m-1" }),
      );
    });

    it("emits message_sent(success:false) when the channel send throws", async () => {
      (getChannel as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "weixin",
        sendMessage: vi.fn().mockRejectedValue(new Error("transport down")),
      });
      const sent = vi.fn();
      registerHook("message_sent", sent);

      await deliverMessage({ channel: "weixin", to: "u-1" }, { text: "hi" }, { bestEffort: true });
      await flush();

      expect(sent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "message_sent", success: false }),
      );
    });

    it("emits message_sent(success:false) when the channel send fails", async () => {
      (getChannel as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "weixin",
        sendMessage: vi.fn().mockResolvedValue({ success: false, error: "boom" }),
      });
      const sent = vi.fn();
      registerHook("message_sent", sent);

      await deliverMessage({ channel: "weixin", to: "u-1" }, { text: "hi" }, { bestEffort: true });
      await flush();

      expect(sent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "message_sent", success: false }),
      );
    });
  });

  describe("agent processMessage", () => {
    it("emits agent_start and agent_end around runtime.chat", async () => {
      const { Agent } = await import("../src/agents/agent.js");
      const fakeRuntime = {
        chat: vi.fn().mockResolvedValue({
          content: "reply",
          provider: "deepseek",
          model: "deepseek-chat",
          usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
        }),
      };
      const agent = new Agent(fakeRuntime as never, {
        model: "deepseek-chat",
        provider: "deepseek",
        enableTools: false,
      } as never);

      const start = vi.fn();
      const end = vi.fn();
      registerHook("agent_start", start);
      registerHook("agent_end", end);

      await agent.processMessage(makeContext());
      await flush();

      expect(start).toHaveBeenCalledWith(
        expect.objectContaining({ type: "agent_start", provider: "deepseek", model: "deepseek-chat" }),
      );
      expect(end).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "agent_end",
          response: "reply",
          usage: expect.objectContaining({ totalTokens: 3 }),
        }),
      );
    });
  });

  describe("tool execution", () => {
    it("wrapToolWithHookEvents emits tool_start and tool_end around execute", async () => {
      const { wrapToolWithHookEvents } = await import("../src/agents/runtime.js");
      const tool = {
        name: "demo_tool",
        description: "d",
        parameters: { type: "object" },
        execute: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }], details: {} }),
      };
      const start = vi.fn();
      const end = vi.fn();
      registerHook("tool_start", start);
      registerHook("tool_end", end);

      const wrapped = wrapToolWithHookEvents(tool as never);
      await wrapped.execute("call-1", { a: 1 } as never, undefined as never, undefined as never);
      await flush();

      expect(start).toHaveBeenCalledWith(
        expect.objectContaining({ type: "tool_start", toolName: "demo_tool", toolCallId: "call-1", arguments: { a: 1 } }),
      );
      expect(end).toHaveBeenCalledWith(
        expect.objectContaining({ type: "tool_end", toolName: "demo_tool", isError: false }),
      );
    });

    it("emits tool_end(isError:true) and rethrows when execute throws", async () => {
      const { wrapToolWithHookEvents } = await import("../src/agents/runtime.js");
      const tool = {
        name: "bad_tool",
        description: "d",
        parameters: { type: "object" },
        execute: vi.fn().mockRejectedValue(new Error("nope")),
      };
      const end = vi.fn();
      registerHook("tool_end", end);

      const wrapped = wrapToolWithHookEvents(tool as never);
      await expect(
        wrapped.execute("call-2", {} as never, undefined as never, undefined as never),
      ).rejects.toThrow("nope");
      await flush();

      expect(end).toHaveBeenCalledWith(
        expect.objectContaining({ type: "tool_end", toolName: "bad_tool", isError: true }),
      );
    });
  });

  describe("gateway handleMessage", () => {
    async function makeGateway() {
      const { Gateway } = await import("../src/gateway/server.js");
      const config = {
        server: { port: 0, host: "127.0.0.1" },
        channels: {},
        providers: {},
        agent: { defaultModel: "m", defaultProvider: "deepseek" },
        logging: { level: "error" },
      } as never;
      const gateway = new Gateway(config);
      (gateway as unknown as { agent: unknown }).agent = {
        processMessage: vi.fn().mockResolvedValue({ content: "reply", provider: "deepseek", model: "m" }),
      };
      return gateway;
    }

    it("emits message_received for a processed inbound message", async () => {
      (getChannel as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "weixin",
        replyToContext: vi.fn().mockResolvedValue({ success: true }),
      });
      const gateway = await makeGateway();
      const received = vi.fn();
      registerHook("message_received", received);

      const ctx = makeContext();
      await (gateway as unknown as { handleMessage: (c: InboundMessageContext) => Promise<void> }).handleMessage(ctx);
      await flush();

      expect(received).toHaveBeenCalledWith(
        expect.objectContaining({ type: "message_received", context: ctx }),
      );
    });

    it("emits message_sending and message_sent for the gateway reply path", async () => {
      const replyToContext = vi.fn().mockResolvedValue({ success: true });
      (getChannel as ReturnType<typeof vi.fn>).mockReturnValue({ id: "weixin", replyToContext });
      const gateway = await makeGateway();
      const sending = vi.fn();
      const sent = vi.fn();
      registerHook("message_sending", sending);
      registerHook("message_sent", sent);

      await (gateway as unknown as { handleMessage: (c: InboundMessageContext) => Promise<void> }).handleMessage(makeContext());
      await flush();

      expect(replyToContext).toHaveBeenCalled();
      expect(sending).toHaveBeenCalledWith(
        expect.objectContaining({ type: "message_sending", channelId: "weixin", content: "reply" }),
      );
      expect(sent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "message_sent", channelId: "weixin", success: true }),
      );
    });

    it("emits error when the agent throws", async () => {
      (getChannel as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "weixin",
        replyToContext: vi.fn().mockResolvedValue({ success: true }),
      });
      const gateway = await makeGateway();
      (gateway as unknown as { agent: unknown }).agent = {
        processMessage: vi.fn().mockRejectedValue(new Error("agent broke")),
      };
      const onError = vi.fn();
      registerHook("error", onError);

      await (gateway as unknown as { handleMessage: (c: InboundMessageContext) => Promise<void> }).handleMessage(makeContext());
      await flush();

      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error", error: expect.objectContaining({ message: "agent broke" }) }),
      );
    });
  });
});
