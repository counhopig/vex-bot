/**
 * WeChatChannel tests — channel adapter hardening.
 *
 * Ported from _archive/tests/weixin-adapter.test.ts (F1/F2 client-side cases
 * live in tests/wechat-client.test.ts; this file covers the adapter) plus the
 * token-persistence case from weixin-persistence.test.ts.
 *
 * Preserved behaviors:
 *  - F3: id-less inbound messages get a stable fallback messageId (sha1 of
 *    from/timestamp/items) so a redelivered message dedups to the same key.
 *  - F4: non-empty polls re-poll immediately; only empty polls back off.
 *  - Session timeout (WeixinApiError errcode -14) resets and re-initializes.
 *  - sendMessage reports success:false on client API errors (never throws).
 *  - replyToContext sends to the context's chatId (the from-user id).
 *  - WebUI QR confirmation persists the token to the injected config path.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import yaml from "yaml";

vi.mock("../src/utils/logger.js", () => ({
  getChildLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { WeChatChannel, WeChatClient, WeixinApiError } from "../src/channels/wechat/index.js";
import type { InboundMessageContext } from "../src/channels/ChannelAdapter.js";

describe("WeChatChannel adapter hardening", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("F1: sendMessage must not report success on an API error body", () => {
    it("returns success:false when the client reports an API error", async () => {
      const channel = new WeChatChannel({ token: "t" });
      (channel as unknown as { contextTokens: Map<string, string> }).contextTokens.set("user-1", "ctx");
      vi.spyOn(WeChatClient.prototype, "sendMessage").mockRejectedValue(new Error("Weixin sendMessage failed: errcode=-14"));

      const result = await channel.sendMessage({ chatId: "user-1", content: "hi" });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/-14|failed/i);
    });
  });

  describe("F2: adapter reacts to session-timeout and transient API errors", () => {
    it("resets the session when pollMessages throws errcode -14", async () => {
      const channel = new WeChatChannel({ token: "t" });
      (channel as unknown as { pollingActive: boolean }).pollingActive = true;
      vi.spyOn(WeChatClient.prototype, "pollMessages").mockRejectedValue(
        new WeixinApiError("pollMessages", 0, -14, "session timeout"),
      );
      const timeoutSpy = vi
        .spyOn(channel as unknown as { handleSessionTimeout: () => Promise<void> }, "handleSessionTimeout")
        .mockResolvedValue(undefined);

      await (channel as unknown as { pollingLoop: () => Promise<void> }).pollingLoop();

      expect(timeoutSpy).toHaveBeenCalledTimes(1);
    });

    it("retries after a non-session API error without resetting", async () => {
      const channel = new WeChatChannel({ token: "t" });
      (channel as unknown as { pollingActive: boolean }).pollingActive = true;

      let calls = 0;
      vi.spyOn(WeChatClient.prototype, "pollMessages").mockImplementation(async () => {
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
      const channel = new WeChatChannel({ token: "t" });
      const seen: string[] = [];
      channel.onMessage(async (ctx: InboundMessageContext) => {
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
      const channel = new WeChatChannel({ token: "t" });
      channel.onMessage(async () => {});
      (channel as unknown as { pollingActive: boolean }).pollingActive = true;

      const oneMsg = {
        from_user_id: "user-1",
        context_token: "ctx",
        message_id: "m1",
        item_list: [{ type: 1, text_item: { text: "hi" } }],
      };

      let calls = 0;
      vi.spyOn(WeChatClient.prototype, "pollMessages").mockImplementation(async () => {
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

  describe("replyToContext", () => {
    it("sends text back to the context's chatId", async () => {
      const channel = new WeChatChannel({ token: "t" });
      (channel as unknown as { contextTokens: Map<string, string> }).contextTokens.set("user-1", "ctx");
      const sendSpy = vi
        .spyOn(WeChatClient.prototype, "sendMessage")
        .mockResolvedValue({ ret: 0, errcode: 0 });

      const result = await channel.replyToContext(
        {
          channelId: "weixin",
          messageId: "m1",
          chatId: "user-1",
          chatType: "direct",
          senderId: "user-1",
          content: "hi",
          timestamp: Date.now(),
        },
        "hello back",
      );

      expect(result.success).toBe(true);
      expect(sendSpy).toHaveBeenCalledWith("user-1", "ctx", [{ type: 1, text_item: { text: "hello back" } }]);
    });

    it("returns success:false with a message when no context_token is known", async () => {
      const channel = new WeChatChannel({ token: "t" });
      const result = await channel.replyToContext(
        {
          channelId: "weixin",
          messageId: "m1",
          chatId: "stranger",
          chatType: "direct",
          senderId: "stranger",
          content: "hi",
          timestamp: Date.now(),
        },
        "hello",
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("context_token");
    });
  });

  describe("isHealthy", () => {
    it("reflects token presence", async () => {
      expect(await new WeChatChannel({ token: "t" }).isHealthy()).toBe(true);
      expect(await new WeChatChannel({}).isHealthy()).toBe(false);
    });
  });
});

describe("WeChatChannel token persistence", () => {
  let homeDir: string;
  let workDir: string;
  let originalCwd: string;
  let tmpHome = os.tmpdir();

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "vex-weixin-home-"));
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vex-weixin-work-"));
    tmpHome = homeDir;
    originalCwd = process.cwd();
    process.chdir(workDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("persists WebUI QR login tokens to the runtime config path", async () => {
    const configDir = path.join(homeDir, "custom-config");
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, "vex.yaml");
    fs.writeFileSync(
      configPath,
      yaml.stringify({
        channels: {
          weixin: {
            botType: "3",
          },
        },
      }),
      "utf-8",
    );
    vi.spyOn(WeChatClient.prototype, "pollQRStatus").mockResolvedValue({
      status: "confirmed",
      botToken: "wx-token",
      accountId: "wx-account",
    });

    const channel = new WeChatChannel({}, { configPath });

    const result = await channel.checkQRStatus("qr-code");

    expect(result.status).toBe("confirmed");
    expect(fs.existsSync(path.join(workDir, "config.local.yaml"))).toBe(false);
    const saved = yaml.parse(
      fs.readFileSync(configPath, "utf-8"),
    ) as { channels?: { weixin?: { token?: string; accountId?: string; enabled?: boolean; botType?: string } } };
    expect(saved.channels?.weixin).toEqual({
      botType: "3",
      token: "wx-token",
      accountId: "wx-account",
      enabled: true,
    });
  });
});
