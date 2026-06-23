/**
 * 个人微信二维码登录流程
 * 通过 iLink OC API 实现扫码登录，自动轮询二维码状态直到用户确认或超时。
 */

import { getChildLogger } from "../../utils/logger.js";
import { WeixinClient, DEFAULT_WEIXIN_OC_BASE_URL } from "./client.js";
import type { QRStatusResponse } from "./client.js";

const logger = getChildLogger("weixin-login");

/** 二维码刷新的最大次数 */
const MAX_QR_REFRESHES = 3;
/** 默认轮询间隔（毫秒） */
const DEFAULT_POLL_INTERVAL_MS = 1500;
/** 默认长轮询超时（毫秒） */
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
/** 默认 Bot 类型 */
const DEFAULT_BOT_TYPE = "3";

export interface LoginResult {
  token: string;
  accountId: string;
  baseUrl: string;
  userId?: string;
}

/** 解析 QR 状态响应为操作指令 */
type QRPollAction =
  | { kind: "confirmed"; result: LoginResult }
  | { kind: "expired" }
  | { kind: "wait" };

function mapQRStatus(
  statusResp: QRStatusResponse,
  defaultBaseUrl: string,
): QRPollAction {
  const rawStatus = String(statusResp.status || "wait");

  if (rawStatus === "confirmed") {
    const botToken = statusResp.botToken ?? "";
    if (!botToken) {
      throw new Error("登录成功但未返回 token");
    }
    const baseUrl = statusResp.baseUrl || defaultBaseUrl;
    return {
      kind: "confirmed",
      result: {
        token: botToken,
        accountId: statusResp.accountId ?? "",
        baseUrl,
        userId: statusResp.userId,
      },
    };
  }

  if (rawStatus === "expired") {
    return { kind: "expired" };
  }

  if (["cancel", "canceled", "denied"].includes(rawStatus)) {
    throw new Error("用户取消登录");
  }

  return { kind: "wait" };
}

function displayQRCode(qrcode: string): void {
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qrcode)}`;
  logger.info("请使用手机微信扫描二维码登录，有效期5分钟");
  logger.info(`二维码链接: ${qrUrl}`);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollOnce(
  client: WeixinClient,
  qrcode: string,
  longPollTimeoutMs: number,
  defaultBaseUrl: string,
): Promise<QRPollAction> {
  const statusResp = await client.pollQRStatus(qrcode, longPollTimeoutMs);
  return mapQRStatus(statusResp, defaultBaseUrl);
}

export async function startQRLogin(
  client: WeixinClient,
  botType: string = DEFAULT_BOT_TYPE,
): Promise<LoginResult> {
  logger.info("开始个人微信二维码登录流程");

  let refreshCount = 0;
  const defaultBaseUrl = DEFAULT_WEIXIN_OC_BASE_URL;

  while (refreshCount < MAX_QR_REFRESHES) {
    logger.info(`获取二维码 (第 ${refreshCount + 1}/${MAX_QR_REFRESHES} 次)`);
    const { qrcode, qrcodeImgContent } = await client.getQRCode(botType);

    displayQRCode(qrcodeImgContent);

    for (;;) {
      let action: QRPollAction;
      try {
        action = await pollOnce(
          client,
          qrcode,
          DEFAULT_LONG_POLL_TIMEOUT_MS,
          defaultBaseUrl,
        );
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        if (errMsg.includes("用户取消") || errMsg.includes("未返回 token")) {
          throw error;
        }
        logger.warn({ error: errMsg }, "轮询失败，等待后重试");
        await sleep(DEFAULT_POLL_INTERVAL_MS);
        continue;
      }

      if (action.kind === "confirmed") {
        logger.info({ accountId: action.result.accountId }, "个人微信登录成功");
        return action.result;
      }

      if (action.kind === "expired") {
        logger.warn("二维码已过期，尝试刷新");
        break;
      }

      logger.debug("等待用户扫码...");
      await sleep(DEFAULT_POLL_INTERVAL_MS);
    }

    refreshCount++;
  }

  throw new Error(
    `二维码登录失败：已尝试 ${MAX_QR_REFRESHES} 次刷新，均未成功`,
  );
}
