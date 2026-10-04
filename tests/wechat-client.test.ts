import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_EXPIRED_ERRCODE, WeChatApiError, WeChatClient } from "../src/channels/wechat/client.js";
import { FakeIlink, textMessage } from "./helpers/ilink.js";

let ilink: FakeIlink;
beforeEach(async () => {
  ilink = new FakeIlink();
  await ilink.start();
});
afterEach(async () => { await ilink.stop(); });

describe("WeChatClient login endpoints", () => {
  it("fetches a login QR code", async () => {
    ilink.on("/ilink/bot/get_bot_qrcode", () => ({ qrcode: "q1", qrcode_img_content: "https://login.example/q1" }));
    const client = new WeChatClient({ baseUrl: `${ilink.baseUrl}/` });
    await expect(client.getQrCode()).resolves.toEqual({ qrcode: "q1", url: "https://login.example/q1" });
    expect(ilink.requests[0]?.query.get("bot_type")).toBe("3");
    expect(ilink.requests[0]?.headers.authorization).toBeUndefined();
  });

  it("rejects a malformed QR response", async () => {
    ilink.on("/ilink/bot/get_bot_qrcode", () => ({ qrcode: "q1" }));
    await expect(new WeChatClient({ baseUrl: ilink.baseUrl }).getQrCode()).rejects.toThrow(/malformed/);
  });

  it("maps QR status values", async () => {
    const statuses: unknown[] = [
      { status: "wait" },
      { status: "scaned" },
      { status: "expired" },
      { status: "cancel" },
      { status: "confirmed", bot_token: "tok", ilink_bot_id: "bot1", baseurl: "https://api2.example", ilink_user_id: "owner1" },
      { status: "confirmed" },
    ];
    ilink.on("/ilink/bot/get_qrcode_status", () => statuses.shift());
    const client = new WeChatClient({ baseUrl: ilink.baseUrl });
    await expect(client.getQrStatus("q1")).resolves.toEqual({ status: "wait" });
    await expect(client.getQrStatus("q1")).resolves.toEqual({ status: "wait" });
    await expect(client.getQrStatus("q1")).resolves.toEqual({ status: "expired" });
    await expect(client.getQrStatus("q1")).resolves.toEqual({ status: "cancelled" });
    await expect(client.getQrStatus("q1")).resolves.toEqual({
      status: "confirmed", token: "tok", accountId: "bot1", baseUrl: "https://api2.example", userId: "owner1",
    });
    await expect(client.getQrStatus("q1")).rejects.toThrow(/returned no token/);
    expect(ilink.requests[0]?.headers["ilink-app-clientversion"]).toBe("1");
    expect(ilink.requests[0]?.query.get("qrcode")).toBe("q1");
  });
});

describe("WeChatClient messaging", () => {
  it("polls updates with the bot token and normalizes messages", async () => {
    ilink.queueUpdates(
      textMessage("owner1", "你好", { message_id: "m1" }),
      textMessage("owner1", "再见", { msg_id: 42 }),
      textMessage("owner1", "无 id", { create_time_ms: 1790000000000 }),
      { context_token: "ctx", item_list: [] },
      "garbage",
    );
    const client = new WeChatClient({ baseUrl: ilink.baseUrl, token: "tok" });
    const { messages, syncBuf } = await client.getUpdates("");
    expect(syncBuf).toBeUndefined();
    expect(messages.map((m) => m.messageId.slice(0, 3))).toEqual(["m1", "42", "wx_"]);
    expect(messages[0]).toEqual({
      messageId: "m1",
      fromUserId: "owner1",
      contextToken: "ctx-owner1",
      items: [{ type: 1, text_item: { text: "你好" } }],
    });
    const request = ilink.requests[0]!;
    expect(request.method).toBe("POST");
    expect(request.headers.authorization).toBe("Bearer tok");
    expect(request.headers.authorizationtype).toBe("ilink_bot_token");
    expect(Buffer.from(String(request.headers["x-wechat-uin"]), "base64").toString("utf8")).toMatch(/^\d+$/);
    expect(request.body).toEqual({ base_info: { channel_version: "vex" }, get_updates_buf: "" });
  });

  it("gives a redelivered id-less message the same id", async () => {
    const msg = textMessage("owner1", "重复", { create_time: 1790000000 });
    ilink.queueUpdates(msg);
    ilink.queueUpdates(msg);
    const client = new WeChatClient({ baseUrl: ilink.baseUrl, token: "tok" });
    const a = (await client.getUpdates("")).messages[0];
    const b = (await client.getUpdates("")).messages[0];
    expect(a?.messageId).toBe(b?.messageId);
  });

  it("sends the sync cursor and returns the next one", async () => {
    ilink.queueBatch("cursor-2", textMessage("owner1", "你好", { message_id: "m1" }));
    ilink.queueUpdates();
    const client = new WeChatClient({ baseUrl: ilink.baseUrl, token: "tok" });
    expect((await client.getUpdates("cursor-1")).syncBuf).toBe("cursor-2");
    expect((await client.getUpdates("cursor-2")).syncBuf).toBeUndefined();
    expect(ilink.updateBodies().map((b) => b.get_updates_buf)).toEqual(["cursor-1", "cursor-2"]);
  });

  it("times out a long poll with the configured limit", async () => {
    ilink.on("/ilink/bot/getupdates", () => new Promise(() => {}));
    const client = new WeChatClient({ baseUrl: ilink.baseUrl, token: "tok", updatesTimeoutMs: 30 });
    const err = await client.getUpdates("").catch((e: unknown) => e);
    expect((err as Error).name).toBe("TimeoutError");
  });

  it("sends a text message", async () => {
    const client = new WeChatClient({ baseUrl: ilink.baseUrl, token: "tok" });
    await client.sendText("owner1", "ctx-owner1", "收到");
    const body = ilink.requests[0]?.body as { msg: Record<string, unknown> };
    expect(body.msg).toMatchObject({
      to_user_id: "owner1",
      context_token: "ctx-owner1",
      message_type: 2,
      message_state: 2,
      item_list: [{ type: 1, text_item: { text: "收到" } }],
    });
    expect(ilink.sentTexts()).toEqual(["收到"]);
  });

  it("surfaces body-level errors and HTTP failures", async () => {
    ilink.on("/ilink/bot/getupdates", () => ({ ret: 0, errcode: SESSION_EXPIRED_ERRCODE, errmsg: "session timeout" }));
    const client = new WeChatClient({ baseUrl: ilink.baseUrl, token: "tok" });
    const err = await client.getUpdates("").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WeChatApiError);
    expect((err as WeChatApiError).errcode).toBe(SESSION_EXPIRED_ERRCODE);
    ilink.on("/ilink/bot/sendmessage", () => ({ ret: 1, errmsg: "bad context" }));
    await expect(client.sendText("owner1", "ctx", "x")).rejects.toThrow(/ret=1/);
    ilink.on("/ilink/bot/getupdates", () => 502);
    await expect(client.getUpdates("")).rejects.toThrow(/HTTP 502/);
  });

  it("stops polling when aborted", async () => {
    ilink.on("/ilink/bot/getupdates", () => new Promise(() => {}));
    const client = new WeChatClient({ baseUrl: ilink.baseUrl, token: "tok" });
    const controller = new AbortController();
    const pending = client.getUpdates("", controller.signal);
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toThrow();
  });
});
