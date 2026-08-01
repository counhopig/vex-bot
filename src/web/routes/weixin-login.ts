/**
 * weixin.* WS method handlers — injected into WebChatChannel.handlers.
 *
 * Ported from the archive's WsServer.handleWeixinQR/handleWeixinQRStatus/
 * handleWeixinUnbind. The control panel drives a personal-WeChat QR login
 * from the browser: weixin.qr returns a QR payload, weixin.qr.status long-
 * polls the scan result, weixin.unbind removes the user's stored credentials.
 *
 * Security behaviors preserved from the archive:
 *  - A QR code fetched by one authenticated user cannot be confirmed by
 *    another (ownership check on the pending-login map key).
 *  - `weixin.unbind` requires an authenticated user.
 *  - Credentials are persisted through WebAuthStore (per-user SQLite rows),
 *    never returned to the client; the payload carries the redacted
 *    PublicWebUser.
 *
 * Lifecycle: the pending-login map is per-handler-instance; entries are
 * removed on confirmed/expired/canceled/denied. `onUserWeixinLogin` /
 * `onUserWeixinUnbind` are injected by the server bootstrap so the user's
 * personal WeChat channel starts/stops immediately, not at the next restart.
 */

import { getChildLogger } from "../../utils/logger.js";
import {
  WeChatClient,
  DEFAULT_WEIXIN_OC_BASE_URL,
  DEFAULT_WEIXIN_OC_CDN_BASE_URL,
  DEFAULT_WEIXIN_OC_API_TIMEOUT_MS,
  DEFAULT_WEIXIN_OC_BOT_TYPE,
} from "../../channels/wechat/WeChatClient.js";
import { renderQrSvgDataUri } from "../../channels/wechat/qr.js";
import type { WeChatChannel, WeixinConfig } from "../../channels/wechat/WeChatChannel.js";
import type { WsClientView, WsMethodHandler } from "../../channels/webchat/WebChatChannel.js";
import type { WebAuthStore, PublicWebUser } from "./auth.js";

const logger = getChildLogger("ws-weixin-login");

export interface WeixinLoginHandlersOptions {
  /** Per-user credential persistence + public-user projection. */
  auth: WebAuthStore;
  /** Resolve the current `channels.weixin` config section (defaults for the
   *  per-user client and the onUserWeixinLogin payload). */
  getWeixinConfig: () => WeixinConfig | undefined;
  /** Legacy single-user WeChat channel, used when the client is not an
   *  authenticated Web user (web auth disabled). */
  weixinChannel?: WeChatChannel;
  /** Called after a user's QR login is confirmed — the bootstrap starts the
   *  user's personal WeChat channel with the returned credentials. */
  onUserWeixinLogin?: (userId: string, login: WeixinConfig) => Promise<void> | void;
  /** Called when a user unbinds WeChat — the bootstrap stops their channel. */
  onUserWeixinUnbind?: (userId: string) => Promise<void> | void;
}

/** An in-flight QR login for an authenticated Web user. */
interface PendingUserWeixinLogin {
  userId: string;
  client: WeChatClient;
}

/** Long-poll timeout for weixin.qr.status (matches the archive). */
const QR_STATUS_POLL_TIMEOUT_MS = 15_000;

/** Map scan-result statuses to human-readable messages (archive parity). */
const QR_STATUS_MESSAGES: Record<string, string> = {
  wait: "Waiting for scan...",
  confirmed: "Login successful!",
  expired: "QR code expired",
  canceled: "User cancelled login",
  denied: "User denied login",
};

/** Statuses after which the pending QR entry is discarded. */
const TERMINAL_STATUSES = ["expired", "canceled", "cancel", "denied"];

export function createWeixinLoginHandlers(options: WeixinLoginHandlersOptions): Record<string, WsMethodHandler> {
  const { auth, getWeixinConfig, weixinChannel, onUserWeixinLogin, onUserWeixinUnbind } = options;
  const pendingUserWeixinLogins = new Map<string, PendingUserWeixinLogin>();

  /** Build a per-user WeChatClient from the current channels.weixin section. */
  function createUserWeixinClient(): WeChatClient {
    const config = getWeixinConfig() ?? {};
    return new WeChatClient(
      "weixin",
      config.baseUrl ?? DEFAULT_WEIXIN_OC_BASE_URL,
      config.cdnBaseUrl ?? DEFAULT_WEIXIN_OC_CDN_BASE_URL,
      config.apiTimeoutMs ?? DEFAULT_WEIXIN_OC_API_TIMEOUT_MS,
    );
  }

  return {
    async "weixin.qr"(client) {
      if (client.user) {
        const weixinClient = createUserWeixinClient();
        const botType = getWeixinConfig()?.botType ?? DEFAULT_WEIXIN_OC_BOT_TYPE;
        const result = await weixinClient.getQRCode(botType);
        pendingUserWeixinLogins.set(result.qrcode, {
          userId: client.user.id,
          client: weixinClient,
        });
        const qrcodeUrl = renderQrSvgDataUri(result.qrcodeImgContent);
        logger.debug({ clientId: client.id }, "User Weixin QR code issued");
        return { qrcode_url: qrcodeUrl, qrcode: result.qrcode };
      }

      if (!weixinChannel) {
        return { error: "Personal WeChat channel not enabled" };
      }
      const result = await weixinChannel.getLoginQRCode();
      if (!result) {
        return { error: "Failed to get QR code" };
      }
      const qrcodeUrl = renderQrSvgDataUri(result.qrcodeImgContent);
      return { qrcode_url: qrcodeUrl, qrcode: result.qrcode };
    },

    async "weixin.qr.status"(client, params) {
      const p = params as { qrcode: string };
      const pendingLogin = client.user ? pendingUserWeixinLogins.get(p.qrcode) : undefined;
      if (pendingLogin && pendingLogin.userId !== client.user?.id) {
        return { status: "error", message: "QR code belongs to another user" };
      }
      if (!pendingLogin && !weixinChannel) {
        return { status: "error", message: "Personal WeChat channel not enabled" };
      }

      const result = pendingLogin
        ? await pendingLogin.client.pollQRStatus(p.qrcode, QR_STATUS_POLL_TIMEOUT_MS)
        : await weixinChannel!.checkQRStatus(p.qrcode);

      const payload: {
        status: string;
        message: string;
        accountId?: string;
        user?: PublicWebUser;
      } = {
        status: result.status,
        message: QR_STATUS_MESSAGES[result.status] ?? result.status,
        accountId: result.accountId,
      };

      if (result.status === "confirmed" && client.user && result.botToken) {
        payload.user = auth.saveUserWeixinLogin(client.user.id, {
          token: result.botToken,
          accountId: result.accountId ?? "",
          baseUrl: result.baseUrl ?? getWeixinConfig()?.baseUrl ?? "",
          userId: result.userId,
        });
        client.user = payload.user;
        pendingUserWeixinLogins.delete(p.qrcode);
        await onUserWeixinLogin?.(client.user.id, {
          token: result.botToken,
          accountId: result.accountId,
          baseUrl: result.baseUrl ?? getWeixinConfig()?.baseUrl,
          botType: getWeixinConfig()?.botType,
          cdnBaseUrl: getWeixinConfig()?.cdnBaseUrl,
          apiTimeoutMs: getWeixinConfig()?.apiTimeoutMs,
          longPollTimeoutMs: getWeixinConfig()?.longPollTimeoutMs,
          enabled: true,
        });
      } else if (TERMINAL_STATUSES.includes(result.status)) {
        pendingUserWeixinLogins.delete(p.qrcode);
      }
      return payload;
    },

    async "weixin.unbind"(client) {
      if (!client.user) {
        throw new Error("Login required");
      }
      const user = auth.deleteUserWeixinLogin(client.user.id);
      client.user = user;
      // Shut down the user's running WeChat channel so the unbind takes effect
      // immediately, not at the next restart.
      await onUserWeixinUnbind?.(user.id);
      return { user };
    },
  };
}
