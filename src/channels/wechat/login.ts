import { setTimeout as delay } from "node:timers/promises";
import { toString as renderQr } from "qrcode";
import type { WeChatClient } from "./client.js";

export interface LoginResult {
  token: string;
  accountId: string;
  baseUrl?: string;
  userId?: string;
}

export interface LoginOptions {
  pollIntervalMs?: number;
  maxQrRefreshes?: number;
  maxConsecutiveErrors?: number;
  botType?: string;
}

export class WeChatLoginError extends Error {}

export async function loginWithQr(
  client: WeChatClient,
  print: (text: string) => void,
  opts: LoginOptions = {},
): Promise<LoginResult> {
  const pollIntervalMs = opts.pollIntervalMs ?? 1500;
  const maxQrRefreshes = opts.maxQrRefreshes ?? 3;
  const maxConsecutiveErrors = opts.maxConsecutiveErrors ?? 5;

  for (let attempt = 1; attempt <= maxQrRefreshes; attempt++) {
    const qr = await client.getQrCode(opts.botType);
    print("用手机微信扫描下面的二维码登录：");
    print(await renderQr(qr.url, { type: "terminal", small: true }));

    let errors = 0;
    for (;;) {
      let status;
      try {
        status = await client.getQrStatus(qr.qrcode);
        errors = 0;
      } catch (err) {
        errors++;
        if (errors >= maxConsecutiveErrors) throw err;
        await delay(pollIntervalMs);
        continue;
      }
      if (status.status === "confirmed") {
        return { token: status.token, accountId: status.accountId, baseUrl: status.baseUrl, userId: status.userId };
      }
      if (status.status === "cancelled") throw new WeChatLoginError("已在手机上取消登录");
      if (status.status === "expired") {
        if (attempt < maxQrRefreshes) print("二维码已过期，正在刷新…");
        break;
      }
      await delay(pollIntervalMs);
    }
  }
  throw new WeChatLoginError(`二维码连续 ${maxQrRefreshes} 次过期，登录失败`);
}
