import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../src/utils/logger.js", () => ({
  getChildLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { WeixinChannel, WeixinClient, WeixinApiError } from "../src/channels/weixin/index.js";
import type { InboundMessageContext } from "../src/types/index.js";

function makeClient(): WeixinClient {
  return new WeixinClient("weixin", "https://example.test", "https://cdn.test", 1000, "token");
}

describe("weixin adapter hardening", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("F1: sendMessage must not report success on an API error body", () => {
    it("client.sendMessage rejects when the response body carries a non-zero errcode", async () => {
      const client = makeClient();
      vi.spyOn((client as unknown as { client: { post: unknown } }).client, "post").mockResolvedValue({
        data: { ret: 0, errcode: -14, errmsg: "session timeout" },
      });

      await expect(client.sendMessage("user-1", "ctx", [{ type: 1 }])).rejects.toThrow(/-14|session timeout|failed/i);
    });

    it("client.sendMessage resolves on a success body", async () => {
      const client = makeClient();
      vi.spyOn((client as unknown as { client: { post: unknown } }).client, "post").mockResolvedValue({
        data: { ret: 0, errcode: 0 },
      });

      await expect(client.sendMessage("user-1", "ctx", [{ type: 1 }])).resolves.toBeDefined();
    });

    it("adapter.sendMessage returns success:false when the client reports an API error", async () => {
      const channel = new WeixinChannel({ token: "t" });
      (channel as unknown as { contextTokens: Map<string, string> }).contextTokens.set("user-1", "ctx");
      vi.spyOn(WeixinClient.prototype, "sendMessage").mockRejectedValue(new Error("Weixin sendMessage failed: errcode=-14"));

      const result = await channel.sendMessage({ chatId: "user-1", content: "hi" });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/-14|failed/i);
    });
  });

  describe("F2: API error envelopes are checked in the client, once, for every endpoint", () => {
    it("client.pollMessages rejects with a WeixinApiError carrying the errcode", async () => {
      const client = makeClient();
      vi.spyOn((client as unknown as { client: { post: unknown } }).client, "post").mockResolvedValue({
        data: { ret: 0, errcode: -14, errmsg: "session timeout" },
      });

      await expect(client.pollMessages()).rejects.toSatisfy((err: unknown) => {
        return err instanceof WeixinApiError && err.errcode === -14;
      });
    });

    it("client.sendMessage rejects with a WeixinApiError", async () => {
      const client = makeClient();
      vi.spyOn((client as unknown as { client: { post: unknown } }).client, "post").mockResolvedValue({
        data: { ret: 1, errcode: 0, errmsg: "bad context" },
      });

      await expect(client.sendMessage("u", "ctx", [])).rejects.toSatisfy((err: unknown) => {
        return err instanceof WeixinApiError && err.ret === 1;
      });
    });

    it("adapter reacts to a thrown errcode -14 by resetting the session", async () => {
      const channel = new WeixinChannel({ token: "t" });
      (channel as unknown as { pollingActive: boolean }).pollingActive = true;
      vi.spyOn(WeixinClient.prototype, "pollMessages").mockRejectedValue(
        new WeixinApiError("pollMessages", 0, -14, "session timeout"),
      );
      const timeoutSpy = vi
        .spyOn(channel as unknown as { handleSessionTimeout: () => Promise<void> }, "handleSessionTimeout")
        .mockResolvedValue(undefined);

      await (channel as unknown as { pollingLoop: () => Promise<void> }).pollingLoop();

      expect(timeoutSpy).toHaveBeenCalledTimes(1);
    });

    it("adapter retries after a non-session API error without resetting", async () => {
      const channel = new WeixinChannel({ token: "t" });
      (channel as unknown as { pollingActive: boolean }).pollingActive = true;

      let calls = 0;
      vi.spyOn(WeixinClient.prototype, "pollMessages").mockImplementation(async () => {
        calls++;
        if (calls >= 2) (channel as unknown as { pollingActive: boolean }).pollingActive = false;
        throw new WeixinApiError("pollMessages", 0, -1, "server hiccup");
      });
      const timeoutSpy = vi
        .spyOn(channel as unknown as { handleSessionTimeout: () => Promise<void> }, "handleSessionTimeout")
        .mockResolvedValue(undefined);
      const delaySpy = vi
        .spyOn(channel as unknown as { delay: (ms: number) => Promise<void> }, "delay")
        .mockResolvedValue(undefined);

      await (channel as unknown as { pollingLoop: () => Promise<void> }).pollingLoop();

      expect(timeoutSpy).not.toHaveBeenCalled();
      expect(delaySpy).toHaveBeenCalledWith(5000);
    });
  });

  describe("F3: id-less inbound messages get a stable messageId", () => {
    it("assigns the same messageId to a redelivered id-less message and differs by content", async () => {
      const channel = new WeixinChannel({ token: "t" });
      const seen: string[] = [];
      channel.setMessageHandler(async (ctx: InboundMessageContext) => {
        seen.push(ctx.messageId);
      });

      const msg = {
        from_user_id: "user-1",
        context_token: "ctx",
        create_time: 1_700_000_000,
        item_list: [{ type: 1, text_item: { text: "hello" } }],
      };

      const handle = (m: unknown) =>
        (channel as unknown as { handleInboundWeixinMessage: (m: unknown) => Promise<void> }).handleInboundWeixinMessage(m);

      await handle(msg);
      await handle(msg); // redelivery of the identical message
      await handle({ ...msg, item_list: [{ type: 1, text_item: { text: "different" } }] });

      expect(seen[0]).toBe(seen[1]); // stable across redelivery
      expect(seen[2]).not.toBe(seen[0]); // distinct content → distinct id
    });
  });

  describe("F4: non-empty polls re-poll immediately, only empty polls back off", () => {
    it("does not sleep the long-poll timeout after a non-empty poll", async () => {
      const channel = new WeixinChannel({ token: "t" });
      channel.setMessageHandler(async () => {});
      (channel as unknown as { pollingActive: boolean }).pollingActive = true;

      const oneMsg = {
        from_user_id: "user-1",
        context_token: "ctx",
        message_id: "m1",
        item_list: [{ type: 1, text_item: { text: "hi" } }],
      };

      let calls = 0;
      vi.spyOn(WeixinClient.prototype, "pollMessages").mockImplementation(async () => {
        calls++;
        if (calls >= 3) (channel as unknown as { pollingActive: boolean }).pollingActive = false;
        const nonEmpty = calls === 1 || calls === 3;
        return { ret: 0, errcode: 0, msgs: nonEmpty ? [oneMsg] : [] };
      });
      const delaySpy = vi
        .spyOn(channel as unknown as { delay: (ms: number) => Promise<void> }, "delay")
        .mockResolvedValue(undefined);

      await (channel as unknown as { pollingLoop: () => Promise<void> }).pollingLoop();

      // Only the single empty poll (call 2) should trigger the long-poll backoff.
      const longBackoffs = delaySpy.mock.calls.filter((c) => c[0] === 35000);
      expect(longBackoffs).toHaveLength(1);
    });
  });
});
