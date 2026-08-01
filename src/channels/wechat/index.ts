/**
 * Personal WeChat channel — adapter, iLink OC API client, QR login, qr.
 */

export {
  WeChatChannel,
  createWeChatChannel,
  type WeixinConfig,
} from "./WeChatChannel.js";

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
