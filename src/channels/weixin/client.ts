/**
 * 个人微信 (iLink OC) API 客户端
 * 基于微信 iLink OC API，用于个人微信机器人的 HTTP 通信。
 * 参考 AstrBot weixin_oc 模块实现。
 */

import axios, { type AxiosInstance } from "axios";
import crypto from "crypto";
import { getChildLogger } from "../../utils/logger.js";

const logger = getChildLogger("weixin-client");

/** 默认 API 基础地址 */
export const DEFAULT_WEIXIN_OC_BASE_URL = "https://ilinkai.weixin.qq.com";
/** 默认 CDN 基础地址 */
export const DEFAULT_WEIXIN_OC_CDN_BASE_URL =
  "https://novac2c.cdn.weixin.qq.com/c2c";
/** 默认 Bot 类型 */
export const DEFAULT_WEIXIN_OC_BOT_TYPE = "3";
/** 默认 API 超时（毫秒） */
export const DEFAULT_WEIXIN_OC_API_TIMEOUT_MS = 120_000;

/** 二维码状态轮询响应 */
export interface QRStatusResponse {
  status: string;
  botToken?: string;
  accountId?: string;
  baseUrl?: string;
  userId?: string;
}

/** 消息轮询泛型响应 */
export type PollMessagesResponse = Record<string, unknown>;

/** 发送消息请求体中的消息结构 */
interface SendMessageBody {
  from_user_id: string;
  to_user_id: string;
  client_id: string;
  message_type: number;
  message_state: number;
  context_token: string;
  item_list: unknown[];
}

/** 发送消息完整请求体 */
interface SendMessageRequest {
  base_info: {
    channel_version: string;
  };
  msg: SendMessageBody;
}

/** 个人微信 iLink OC API HTTP 客户端 */
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

  /** 生成 X-WECHAT-UIN 请求头值。
   *  生成一个随机的 32 位无符号整数，转为十进制字符串后 Base64 编码。
   */
  static generateXWechatUin(): string {
    const randomBytes = crypto.randomBytes(4);
    const randomInt = randomBytes.readUInt32BE(0);
    const decimalStr = String(randomInt);
    return Buffer.from(decimalStr, "utf-8").toString("base64");
  }

  /** 构建基础请求头 */
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

  /** 拼接完整 API URL */
  private resolveUrl(endpoint: string): string {
    return `${this.baseUrl}/${endpoint.replace(/^\//, "")}`;
  }

  /** 获取登录二维码，返回二维码字符串和图片内容。
   * @param botType Bot 类型，默认 "3"
   */
  async getQRCode(
    botType: string,
  ): Promise<{ qrcode: string; qrcodeImgContent: string }> {
    logger.debug({ botType }, "获取登录二维码");

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
      throw new Error("个人微信二维码响应格式异常");
    }

    logger.debug({ qrcodePrefix: qrcode.substring(0, 20) }, "二维码获取成功");
    return { qrcode, qrcodeImgContent };
  }

  /** 轮询二维码扫码状态
   * @param qrcode 二维码字符串
   * @param longPollTimeoutMs 长轮询超时（毫秒）
   */
  async pollQRStatus(
    qrcode: string,
    longPollTimeoutMs: number,
  ): Promise<QRStatusResponse> {
    logger.debug(
      { qrcodePrefix: qrcode.substring(0, 20) },
      "轮询二维码状态",
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

  /** 拉取消息（长轮询）
   * 调用 ilink/bot/getupdates 接口获取待处理消息。
   */
  async pollMessages(): Promise<PollMessagesResponse> {
    logger.debug("拉取消息");

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

    return response.data as PollMessagesResponse;
  }

  /** 发送消息
   * @param userId 目标用户 ID
   * @param contextToken 上下文 Token
   * @param itemList 消息内容列表
   */
  async sendMessage(
    userId: string,
    contextToken: string,
    itemList: unknown[],
  ): Promise<unknown> {
    logger.debug({ userId, itemCount: itemList.length }, "发送消息");

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

    return response.data;
  }

  /** 检查客户端是否已认证（是否有有效 token） */
  checkHealth(): boolean {
    return this.token !== null && this.token.length > 0;
  }

  /** 设置 Token（登录成功后调用） */
  setToken(token: string): void {
    this.token = token;
    logger.debug("Token 已更新");
  }

  /** 获取当前 Token */
  getToken(): string | null {
    return this.token;
  }
}
