/**
 * Personal WeChat channel — iLink OC API client + QR login + qr rendering.
 *
 * The channel adapter (WeChatChannel) lands in part 2 of the web/ module;
 * this barrel exports the client/login layer for now.
 */

export {
  WeChatClient,
  WeixinApiError,
  DEFAULT_WEIXIN_OC_BASE_URL,
  DEFAULT_WEIXIN_OC_CDN_BASE_URL,
  DEFAULT_WEIXIN_OC_BOT_TYPE,
  DEFAULT_WEIXIN_OC_API_TIMEOUT_MS,
  type QRStatusResponse,
  type PollMessagesResponse,
} from "./WeChatClient.js";

export {
  startQRLogin,
  LoginAbortedError,
  type LoginResult,
} from "./WeChatLogin.js";

export { renderQrSvg, renderQrSvgDataUri, renderQrTerminal } from "./qr.js";
