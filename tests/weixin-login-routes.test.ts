/**
 * WS method handler tests — weixin.qr / weixin.qr.status / weixin.unbind.
 *
 * These are pure handler factories injected into WebChatChannel.handlers.
 * WeChatClient is module-mocked (the factory news one up internally for
 * authenticated users), WebAuthStore and the legacy WeChatChannel are
 * structural mocks. Covers: legacy single-user QR flow, authenticated-user
 * QR flow, ownership enforcement, confirmed-scan credential save + client
 * rebind + onUserWeixinLogin, terminal-status cleanup, unbind.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted module mock: the handler factory constructs WeChatClient internally.
const mocks = vi.hoisted(() => ({
  getQRCode: vi.fn(),
  pollQRStatus: vi.fn(),
}));

vi.mock("../src/channels/wechat/WeChatClient.js", () => ({
  WeChatClient: vi.fn(() => ({
    getQRCode: mocks.getQRCode,
    pollQRStatus: mocks.pollQRStatus,
  })),
  DEFAULT_WEIXIN_OC_BASE_URL: "https://ilinkai.weixin.qq.com",
  DEFAULT_WEIXIN_OC_CDN_BASE_URL: "https://novac2c.cdn.weixin.qq.com/c2c",
  DEFAULT_WEIXIN_OC_API_TIMEOUT_MS: 120_000,
  DEFAULT_WEIXIN_OC_BOT_TYPE: "3",
}));

import { createWeixinLoginHandlers } from "../src/web/routes/weixin-login.js";
import type { WeixinLoginHandlersOptions } from "../src/web/routes/weixin-login.js";
import type { WsClientView } from "../src/channels/webchat/WebChatChannel.js";
import type { WeChatChannel, WeixinConfig } from "../src/channels/wechat/WeChatChannel.js";
import type { PublicWebUser } from "../src/web/routes/auth.js";

function makeView(overrides?: Partial<WsClientView>): WsClientView & { events: unknown[] } {
  const events: unknown[] = [];
  return {
    id: "client-1",
    user: null,
    sessionKey: null,
    sessionId: null,
    sendEvent: (event, payload) => events.push({ event, payload }),
    onDisconnect: () => {},
    events,
    ...overrides,
  } as WsClientView & { events: unknown[] };
}

function makeUser(id: string, role: "admin" | "user" = "user"): PublicWebUser {
  return { id, username: `user-${id}`, role, createdAt: 1, hasWeixin: false };
}

function makeAuth(): {
  saveUserWeixinLogin: ReturnType<typeof vi.fn>;
  deleteUserWeixinLogin: ReturnType<typeof vi.fn>;
} {
  return {
    saveUserWeixinLogin: vi.fn((userId: string) => ({ ...makeUser(userId), hasWeixin: true })),
    deleteUserWeixinLogin: vi.fn((userId: string) => ({ ...makeUser(userId), hasWeixin: false })),
  };
}

function makeWeixinChannel(): WeChatChannel & {
  getLoginQRCode: ReturnType<typeof vi.fn>;
  checkQRStatus: ReturnType<typeof vi.fn>;
} {
  return {
    getLoginQRCode: vi.fn(async () => ({ qrcode: "qr-legacy", qrcodeImgContent: "img-legacy" })),
    checkQRStatus: vi.fn(async () => ({ status: "wait" })),
  } as unknown as WeChatChannel & {
    getLoginQRCode: ReturnType<typeof vi.fn>;
    checkQRStatus: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => {
  mocks.getQRCode.mockReset();
  mocks.pollQRStatus.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("weixin handlers — legacy single-user flow (web auth disabled)", () => {
  it("weixin.qr returns a QR payload via the legacy channel when no user", async () => {
    const weixinChannel = makeWeixinChannel();
    const handlers = createWeixinLoginHandlers({
      auth: makeAuth() as unknown as WeixinLoginHandlersOptions["auth"],
      getWeixinConfig: () => undefined,
      weixinChannel,
    });

    const result = (await handlers["weixin.qr"](makeView(), {})) as { qrcode_url: string; qrcode: string };
    expect(weixinChannel.getLoginQRCode).toHaveBeenCalledTimes(1);
    expect(result.qrcode).toBe("qr-legacy");
    expect(result.qrcode_url).toMatch(/^data:image\/svg\+xml;base64,/);
  });

  it("weixin.qr errors when no user and no legacy channel", async () => {
    const handlers = createWeixinLoginHandlers({
      auth: makeAuth() as unknown as WeixinLoginHandlersOptions["auth"],
      getWeixinConfig: () => undefined,
    });

    const result = await handlers["weixin.qr"](makeView(), {});
    expect(result).toEqual({ error: "Personal WeChat channel not enabled" });
  });

  it("weixin.qr.status polls the legacy channel when there is no pending user login", async () => {
    const weixinChannel = makeWeixinChannel();
    weixinChannel.checkQRStatus.mockResolvedValue({ status: "confirmed" });
    const handlers = createWeixinLoginHandlers({
      auth: makeAuth() as unknown as WeixinLoginHandlersOptions["auth"],
      getWeixinConfig: () => undefined,
      weixinChannel,
    });

    const result = (await handlers["weixin.qr.status"](makeView(), { qrcode: "qr-legacy" })) as {
      status: string;
      message: string;
    };
    expect(weixinChannel.checkQRStatus).toHaveBeenCalledWith("qr-legacy");
    expect(result.status).toBe("confirmed");
    expect(result.message).toBe("Login successful!");
  });
});

describe("weixin handlers — authenticated user flow", () => {
  it("weixin.qr issues a per-user QR and records a pending login", async () => {
    mocks.getQRCode.mockResolvedValue({ qrcode: "qr-user", qrcodeImgContent: "img-user" });
    const handlers = createWeixinLoginHandlers({
      auth: makeAuth() as unknown as WeixinLoginHandlersOptions["auth"],
      getWeixinConfig: () => ({ baseUrl: "https://custom.example" }),
    });
    const view = makeView({ user: makeUser("u1") });

    const result = (await handlers["weixin.qr"](view, {})) as { qrcode_url: string; qrcode: string };
    expect(mocks.getQRCode).toHaveBeenCalledWith("3");
    expect(result.qrcode).toBe("qr-user");
    expect(result.qrcode_url).toMatch(/^data:image\/svg\+xml;base64,/);
  });

  it("weixin.qr.status confirmed saves credentials, rebinds the user, and fires onUserWeixinLogin", async () => {
    const user = makeUser("u1");
    mocks.pollQRStatus.mockResolvedValue({
      status: "confirmed",
      botToken: "tok-1",
      accountId: "acc-1",
      baseUrl: "https://ilink.example",
      userId: "ilink-u1",
    });
    const auth = makeAuth();
    const onUserWeixinLogin = vi.fn(async () => {});
    const handlers = createWeixinLoginHandlers({
      auth: auth as unknown as WeixinLoginHandlersOptions["auth"],
      getWeixinConfig: () => ({ botType: "7" }),
      onUserWeixinLogin,
    });
    const view = makeView({ user });

    // Issue a QR first so the pending map has an entry for this user.
    mocks.getQRCode.mockResolvedValue({ qrcode: "qr-user", qrcodeImgContent: "img" });
    await handlers["weixin.qr"](view, {});

    const result = (await handlers["weixin.qr.status"](view, { qrcode: "qr-user" })) as {
      status: string;
      message: string;
      user?: PublicWebUser;
    };

    expect(result.status).toBe("confirmed");
    expect(auth.saveUserWeixinLogin).toHaveBeenCalledWith("u1", {
      token: "tok-1",
      accountId: "acc-1",
      baseUrl: "https://ilink.example",
      userId: "ilink-u1",
    });
    expect(result.user?.hasWeixin).toBe(true);
    expect(view.user?.hasWeixin).toBe(true); // client rebound to saved user
    expect(onUserWeixinLogin).toHaveBeenCalledWith("u1", expect.objectContaining({ token: "tok-1", botType: "7" }));
  });

  it("weixin.qr.status rejects a QR code belonging to another user", async () => {
    mocks.getQRCode.mockResolvedValue({ qrcode: "qr-u1", qrcodeImgContent: "img" });
    const handlers = createWeixinLoginHandlers({
      auth: makeAuth() as unknown as WeixinLoginHandlersOptions["auth"],
      getWeixinConfig: () => undefined,
    });
    const owner = makeView({ user: makeUser("u1") });
    await handlers["weixin.qr"](owner, {});

    const intruder = makeView({ user: makeUser("u2") });
    const result = (await handlers["weixin.qr.status"](intruder, { qrcode: "qr-u1" })) as {
      status: string;
      message: string;
    };
    expect(result).toEqual({ status: "error", message: "QR code belongs to another user" });
    expect(mocks.pollQRStatus).not.toHaveBeenCalled();
  });

  it("weixin.qr.status with a pending login but no matching QR returns channel error", async () => {
    const handlers = createWeixinLoginHandlers({
      auth: makeAuth() as unknown as WeixinLoginHandlersOptions["auth"],
      getWeixinConfig: () => undefined,
    });
    const result = (await handlers["weixin.qr.status"](makeView({ user: makeUser("u1") }), {
      qrcode: "unknown-qr",
    })) as { status: string; message: string };
    expect(result).toEqual({ status: "error", message: "Personal WeChat channel not enabled" });
  });

  it("weixin.qr.status expired clears the pending entry", async () => {
    mocks.getQRCode.mockResolvedValue({ qrcode: "qr-user", qrcodeImgContent: "img" });
    mocks.pollQRStatus.mockResolvedValue({ status: "expired" });
    const handlers = createWeixinLoginHandlers({
      auth: makeAuth() as unknown as WeixinLoginHandlersOptions["auth"],
      getWeixinConfig: () => undefined,
    });
    const view = makeView({ user: makeUser("u1") });
    await handlers["weixin.qr"](view, {});

    const result = (await handlers["weixin.qr.status"](view, { qrcode: "qr-user" })) as {
      status: string;
      message: string;
    };
    expect(result.status).toBe("expired");
    // Pending entry is gone: a second status call falls through to the
    // (absent) legacy channel and reports the channel error instead.
    const second = (await handlers["weixin.qr.status"](view, { qrcode: "qr-user" })) as {
      status: string;
      message: string;
    };
    expect(second.status).toBe("error");
  });
});

describe("weixin handlers — unbind", () => {
  it("weixin.unbind requires a logged-in user", async () => {
    const handlers = createWeixinLoginHandlers({
      auth: makeAuth() as unknown as WeixinLoginHandlersOptions["auth"],
      getWeixinConfig: () => undefined,
    });
    await expect(handlers["weixin.unbind"](makeView(), {})).rejects.toThrow(/Login required/);
  });

  it("weixin.unbind deletes credentials, rebinds the user, and fires onUserWeixinUnbind", async () => {
    const auth = makeAuth();
    const onUserWeixinUnbind = vi.fn(async () => {});
    const handlers = createWeixinLoginHandlers({
      auth: auth as unknown as WeixinLoginHandlersOptions["auth"],
      getWeixinConfig: () => undefined,
      onUserWeixinUnbind,
    });
    const view = makeView({ user: makeUser("u1") });

    const result = (await handlers["weixin.unbind"](view, {})) as { user: PublicWebUser };
    expect(auth.deleteUserWeixinLogin).toHaveBeenCalledWith("u1");
    expect(result.user.hasWeixin).toBe(false);
    expect(view.user?.hasWeixin).toBe(false); // client rebound
    expect(onUserWeixinUnbind).toHaveBeenCalledWith("u1");
  });
});
