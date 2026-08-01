/**
 * WeChatClient tests — iLink OC API client hardening.
 *
 * Ported from _archive/tests/weixin-adapter.test.ts, client-side cases only:
 *  - F1: sendMessage must not report success on an API error body.
 *  - F2: API error envelopes are checked in the client, once, for every
 *    endpoint (WeixinApiError carries ret/errcode).
 * (The channel adapter cases F3/F4 move with WeChatChannel in part 2.)
 */

import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../src/utils/logger.js", () => ({
  getChildLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { WeChatClient, WeixinApiError } from "../src/channels/wechat/WeChatClient.js";

function makeClient(): WeChatClient {
  return new WeChatClient("weixin", "https://example.test", "https://cdn.test", 1000, "token");
}

describe("WeChatClient hardening", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("F1: sendMessage must not report success on an API error body", () => {
    it("rejects when the response body carries a non-zero errcode", async () => {
      const client = makeClient();
      vi.spyOn((client as unknown as { http: { post: (...a: unknown[]) => Promise<unknown> } }).http, "post").mockResolvedValue({
        data: { ret: 0, errcode: -14, errmsg: "session timeout" },
      });

      await expect(client.sendMessage("user-1", "ctx", [{ type: 1 }])).rejects.toThrow(/-14|session timeout|failed/i);
    });

    it("resolves on a success body", async () => {
      const client = makeClient();
      vi.spyOn((client as unknown as { http: { post: (...a: unknown[]) => Promise<unknown> } }).http, "post").mockResolvedValue({
        data: { ret: 0, errcode: 0 },
      });

      await expect(client.sendMessage("user-1", "ctx", [{ type: 1 }])).resolves.toBeDefined();
    });
  });

  describe("F2: API error envelopes are checked in the client for every endpoint", () => {
    it("pollMessages rejects with a WeixinApiError carrying the errcode", async () => {
      const client = makeClient();
      vi.spyOn((client as unknown as { http: { post: (...a: unknown[]) => Promise<unknown> } }).http, "post").mockResolvedValue({
        data: { ret: 0, errcode: -14, errmsg: "session timeout" },
      });

      await expect(client.pollMessages()).rejects.toSatisfy((err: unknown) => {
        return err instanceof WeixinApiError && err.errcode === -14;
      });
    });

    it("sendMessage rejects with a WeixinApiError carrying ret", async () => {
      const client = makeClient();
      vi.spyOn((client as unknown as { http: { post: (...a: unknown[]) => Promise<unknown> } }).http, "post").mockResolvedValue({
        data: { ret: 1, errcode: 0, errmsg: "bad context" },
      });

      await expect(client.sendMessage("u", "ctx", [])).rejects.toSatisfy((err: unknown) => {
        return err instanceof WeixinApiError && err.ret === 1;
      });
    });
  });

  describe("basic API shape", () => {
    it("strips trailing slashes from base and CDN URLs", () => {
      const client = new WeChatClient("weixin", "https://x.test/", "https://cdn.test/", 1000);
      expect((client as unknown as { baseUrl: string }).baseUrl).toBe("https://x.test");
      expect((client as unknown as { cdnBaseUrl: string }).cdnBaseUrl).toBe("https://cdn.test");
    });

    it("checkHealth reflects token presence", () => {
      expect(new WeChatClient("w", "u", "c", 1, "tok").checkHealth()).toBe(true);
      expect(new WeChatClient("w", "u", "c", 1).checkHealth()).toBe(false);
    });

    it("setToken updates the token and getToken reads it back", () => {
      const client = new WeChatClient("w", "u", "c", 1);
      client.setToken("new-token");
      expect(client.getToken()).toBe("new-token");
    });

    it("generateXWechatUin produces a base64 string of a decimal uint32", () => {
      const uin = WeChatClient.generateXWechatUin();
      expect(typeof uin).toBe("string");
      const decoded = Buffer.from(uin, "base64").toString("utf-8");
      expect(decoded).toMatch(/^\d+$/);
      expect(Number(decoded)).toBeGreaterThanOrEqual(0);
    });
  });
});
