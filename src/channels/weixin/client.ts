/**
 * Personal WeChat (iLink OC) API Client
 * Based on WeChat iLink OC API, for personal WeChat bot HTTP communication.
 * Reference: AstrBot weixin_oc module implementation.
 */

import axios, { type AxiosInstance } from "axios";
import crypto from "crypto";
import { getChildLogger } from "../../utils/logger.js";

const logger = getChildLogger("weixin-client");

/** Default API base URL */
export const DEFAULT_WEIXIN_OC_BASE_URL = "https://ilinkai.weixin.qq.com";
/** Default CDN base URL */
export const DEFAULT_WEIXIN_OC_CDN_BASE_URL =
  "https://novac2c.cdn.weixin.qq.com/c2c";
/** Default bot type */
export const DEFAULT_WEIXIN_OC_BOT_TYPE = "3";
/** Default API timeout (milliseconds) */
export const DEFAULT_WEIXIN_OC_API_TIMEOUT_MS = 120_000;

/** Error for a 200 response whose body carries a non-zero ret/errcode.
 *  The OC API signals failures (session timeout, invalid context_token, ...)
 *  in the body, so HTTP success alone never means the call succeeded. */
export class WeixinApiError extends Error {
  constructor(
    readonly endpoint: string,
    readonly ret: number,
    readonly errcode: number,
    readonly errmsg: string,
  ) {
    super(`Weixin ${endpoint} failed: ret=${ret} errcode=${errcode} ${errmsg}`);
    this.name = "WeixinApiError";
  }
}

/** Throw a WeixinApiError when a response body carries a non-zero ret/errcode. */
function assertOkEnvelope(endpoint: string, data: Record<string, unknown>): void {
  const ret = typeof data.ret === "number" ? data.ret : 0;
  const errcode = typeof data.errcode === "number" ? data.errcode : 0;
  if (ret !== 0 || errcode !== 0) {
    const errmsg = typeof data.errmsg === "string" ? data.errmsg : "unknown error";
    throw new WeixinApiError(endpoint, ret, errcode, errmsg);
  }
}

/** QR code status polling response */
export interface QRStatusResponse {
  status: string;
  botToken?: string;
  accountId?: string;
  baseUrl?: string;
  userId?: string;
}

/** Message polling generic response */
export type PollMessagesResponse = Record<string, unknown>;

/** Message structure in send message request body */
interface SendMessageBody {
  from_user_id: string;
  to_user_id: string;
  client_id: string;
  message_type: number;
  message_state: number;
  context_token: string;
  item_list: unknown[];
}

/** Full send message request body */
interface SendMessageRequest {
  base_info: {
    channel_version: string;
  };
  msg: SendMessageBody;
}

/** Personal WeChat iLink OC API HTTP client */
export class WeixinClient {
  private adapterId: string;
  private baseUrl: string;
  private cdnBaseUrl: string;
  private apiTimeoutMs: number;
  private token: string | null;
  private client: AxiosInstance;

  constructor(
    adapterId: string,
    baseUrl: string,
    cdnBaseUrl: string,
    apiTimeoutMs: number,
    token?: string,
  ) {
    this.adapterId = adapterId;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.cdnBaseUrl = cdnBaseUrl.replace(/\/$/, "");
    this.apiTimeoutMs = apiTimeoutMs;
    this.token = token ?? null;
    this.client = axios.create({
      timeout: this.apiTimeoutMs,
    });
  }

  /** Generate X-WECHAT-UIN header value.
   *  Generate a random 32-bit unsigned integer, convert to decimal string, then Base64 encode.
   */
  static generateXWechatUin(): string {
    const randomBytes = crypto.randomBytes(4);
    const randomInt = randomBytes.readUInt32BE(0);
    const decimalStr = String(randomInt);
    return Buffer.from(decimalStr, "utf-8").toString("base64");
  }

  /** Build base request headers */
  private buildBaseHeaders(tokenRequired: boolean = false): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      "X-WECHAT-UIN": WeixinClient.generateXWechatUin(),
    };
    if (tokenRequired && this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }
    return headers;
  }

  /** Build full API URL */
  private resolveUrl(endpoint: string): string {
    return `${this.baseUrl}/${endpoint.replace(/^\//, "")}`;
  }

  /** Get login QR code, returns QR code string and image content.
   * @param botType Bot type, default "3"
   */
  async getQRCode(
    botType: string,
  ): Promise<{ qrcode: string; qrcodeImgContent: string }> {
    logger.debug({ botType }, "Getting login QR code");

    const response = await this.client.get(
      this.resolveUrl("ilink/bot/get_bot_qrcode"),
      {
        params: { bot_type: botType },
        headers: this.buildBaseHeaders(false),
      },
    );

    const data = response.data as Record<string, unknown>;
    const qrcode = String(data.qrcode ?? "").trim();
    const qrcodeImgContent = String(data.qrcode_img_content ?? "").trim();

    if (!qrcode || !qrcodeImgContent) {
      throw new Error("Personal WeChat QR code response has unexpected format");
    }

    logger.debug({ qrcodePrefix: qrcode.substring(0, 20) }, "QR code obtained successfully");
    return { qrcode, qrcodeImgContent };
  }

  /** Poll QR code scan status
   * @param qrcode QR code string
   * @param longPollTimeoutMs Long poll timeout (milliseconds)
   */
  async pollQRStatus(
    qrcode: string,
    longPollTimeoutMs: number,
  ): Promise<QRStatusResponse> {
    logger.debug(
      { qrcodePrefix: qrcode.substring(0, 20) },
      "Polling QR code status",
    );

    const response = await this.client.get(
      this.resolveUrl("ilink/bot/get_qrcode_status"),
      {
        params: { qrcode },
        headers: {
          ...this.buildBaseHeaders(false),
          "iLink-App-ClientVersion": "1",
        },
        timeout: longPollTimeoutMs,
      },
    );

    const data = response.data as Record<string, unknown>;
    return {
      status: String(data.status ?? "wait"),
      botToken: data.bot_token ? String(data.bot_token) : undefined,
      accountId: data.ilink_bot_id ? String(data.ilink_bot_id) : undefined,
      baseUrl: data.baseurl ? String(data.baseurl) : undefined,
      userId: data.ilink_user_id ? String(data.ilink_user_id) : undefined,
    };
  }

  /** Fetch messages (long polling)
   *  Calls the ilink/bot/getupdates endpoint to get pending messages.
   */
  async pollMessages(): Promise<PollMessagesResponse> {
    logger.debug("Fetching messages");

    const response = await this.client.post(
      this.resolveUrl("ilink/bot/getupdates"),
      {
        base_info: {
          channel_version: "vex",
        },
      },
      {
        headers: this.buildBaseHeaders(true),
      },
    );

    const data = (response.data ?? {}) as Record<string, unknown>;
    assertOkEnvelope("pollMessages", data);
    return data as PollMessagesResponse;
  }

  /** Send a message
   * @param userId Target user ID
   * @param contextToken Context token
   * @param itemList Message content list
   */
  async sendMessage(
    userId: string,
    contextToken: string,
    itemList: unknown[],
  ): Promise<unknown> {
    logger.debug({ userId, itemCount: itemList.length }, "Sending message");

    const body: SendMessageRequest = {
      base_info: {
        channel_version: "vex",
      },
      msg: {
        from_user_id: "",
        to_user_id: userId,
        client_id: crypto.randomUUID(),
        message_type: 2,
        message_state: 2,
        context_token: contextToken,
        item_list: itemList,
      },
    };

    const response = await this.client.post(
      this.resolveUrl("ilink/bot/sendmessage"),
      body,
      {
        headers: this.buildBaseHeaders(true),
      },
    );

    const data = (response.data ?? {}) as Record<string, unknown>;
    assertOkEnvelope("sendMessage", data);
    return data;
  }

  /** Check whether the client is authenticated (has a valid token) */
  checkHealth(): boolean {
    return this.token !== null && this.token.length > 0;
  }

  /** Set token (called after successful login) */
  setToken(token: string): void {
    this.token = token;
    logger.debug("Token updated");
  }

  /** Get current token */
  getToken(): string | null {
    return this.token;
  }
}
