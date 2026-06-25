/**
 * Personal WeChat QR Code Login Flow
 * Implements QR code scan login via iLink OC API, automatically polls QR code status until user confirms or timeout.
 */

import { getChildLogger } from "../../utils/logger.js";
import { WeixinClient, DEFAULT_WEIXIN_OC_BASE_URL } from "./client.js";
import type { QRStatusResponse } from "./client.js";

const logger = getChildLogger("weixin-login");

/** Maximum number of QR code refreshes */
const MAX_QR_REFRESHES = 3;
/** Default poll interval (milliseconds) */
const DEFAULT_POLL_INTERVAL_MS = 1500;
/** Default long poll timeout (milliseconds) */
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
/** Default bot type */
const DEFAULT_BOT_TYPE = "3";

export interface LoginResult {
  token: string;
  accountId: string;
  baseUrl: string;
  userId?: string;
}

/** Parse QR status response into an action instruction */
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
      throw new Error("Login successful but token not returned");
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
    throw new Error("User cancelled login");
  }

  return { kind: "wait" };
}

function displayQRCode(qrcode: string): void {
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qrcode)}`;
  logger.info("Scan QR code with WeChat on your phone to log in (valid for 5 minutes)");
  logger.info(`QR code link: ${qrUrl}`);
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
  logger.info("Starting personal WeChat QR code login flow");

  let refreshCount = 0;
  const defaultBaseUrl = DEFAULT_WEIXIN_OC_BASE_URL;

  while (refreshCount < MAX_QR_REFRESHES) {
    logger.info(`Getting QR code (attempt ${refreshCount + 1}/${MAX_QR_REFRESHES})`);
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
        if (errMsg.includes("User cancelled") || errMsg.includes("token not returned")) {
          throw error;
        }
        logger.warn({ error: errMsg }, "Poll failed, retrying after delay");
        await sleep(DEFAULT_POLL_INTERVAL_MS);
        continue;
      }

      if (action.kind === "confirmed") {
        logger.info({ accountId: action.result.accountId }, "Personal WeChat login successful");
        return action.result;
      }

      if (action.kind === "expired") {
        logger.warn("QR code expired, refreshing");
        break;
      }

      logger.debug("Waiting for user to scan...");
      await sleep(DEFAULT_POLL_INTERVAL_MS);
    }

    refreshCount++;
  }

  throw new Error(
    `QR code login failed: attempted ${MAX_QR_REFRESHES} refreshes without success`,
  );
}
