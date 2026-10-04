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
  signal?: AbortSignal;
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
    opts.signal?.throwIfAborted();
    const qr = await client.getQrCode(opts.botType);
    print("Scan the QR code below with WeChat on your phone to sign in:");
    print(await renderQr(qr.url, { type: "terminal", small: true }));

    let errors = 0;
    for (;;) {
      opts.signal?.throwIfAborted();
      let status;
      try {
        status = await client.getQrStatus(qr.qrcode);
        errors = 0;
      } catch (err) {
        errors++;
        if (errors >= maxConsecutiveErrors) throw err;
        await delay(pollIntervalMs, undefined, { signal: opts.signal });
        continue;
      }
      if (status.status === "confirmed") {
        return { token: status.token, accountId: status.accountId, baseUrl: status.baseUrl, userId: status.userId };
      }
      if (status.status === "cancelled") throw new WeChatLoginError("Login was cancelled on the phone");
      if (status.status === "expired") {
        if (attempt < maxQrRefreshes) print("The QR code expired; refreshing…");
        break;
      }
      await delay(pollIntervalMs, undefined, { signal: opts.signal });
    }
  }
  throw new WeChatLoginError(`The QR code expired ${maxQrRefreshes} times in a row; login failed`);
}
