import { createHash, randomBytes, randomUUID } from "node:crypto";

export const SESSION_EXPIRED_ERRCODE = -14;

export class WeChatApiError extends Error {
  constructor(
    readonly endpoint: string,
    readonly ret: number,
    readonly errcode: number,
    readonly errmsg: string,
  ) {
    super(`WeChat API ${endpoint} failed: ret=${ret} errcode=${errcode} ${errmsg}`);
    this.name = "WeChatApiError";
  }
}

export interface QrCode {
  qrcode: string;
  url: string;
}

export type QrStatus =
  | { status: "wait" }
  | { status: "expired" }
  | { status: "cancelled" }
  | { status: "confirmed"; token: string; accountId: string; baseUrl?: string; userId?: string };

export interface InboundItem {
  type: number;
  text_item?: { text?: string };
  voice_item?: { text?: string };
}

export interface InboundMessage {
  messageId: string;
  fromUserId: string;
  contextToken: string;
  items: InboundItem[];
}

interface RequestOptions {
  query?: Record<string, string>;
  body?: unknown;
  auth: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_UPDATES_TIMEOUT_MS = 45_000;
const QR_STATUS_TIMEOUT_MS = 40_000;

export class WeChatClient {
  private readonly baseUrl: string;

  constructor(private readonly opts: { baseUrl: string; token?: string; updatesTimeoutMs?: number }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
  }

  async getQrCode(botType = "3"): Promise<QrCode> {
    const data = await this.request("GET", "ilink/bot/get_bot_qrcode", {
      query: { bot_type: botType },
      auth: false,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    const qrcode = typeof data.qrcode === "string" ? data.qrcode.trim() : "";
    const url = typeof data.qrcode_img_content === "string" ? data.qrcode_img_content.trim() : "";
    if (!qrcode || !url) throw new Error("The WeChat login QR response is malformed");
    return { qrcode, url };
  }

  async getQrStatus(qrcode: string): Promise<QrStatus> {
    const data = await this.request("GET", "ilink/bot/get_qrcode_status", {
      query: { qrcode },
      auth: false,
      timeoutMs: QR_STATUS_TIMEOUT_MS,
      headers: { "iLink-App-ClientVersion": "1" },
    });
    const status = typeof data.status === "string" ? data.status : "wait";
    if (status === "confirmed") {
      const token = typeof data.bot_token === "string" ? data.bot_token : "";
      if (!token) throw new Error("WeChat login was confirmed but returned no token");
      return {
        status: "confirmed",
        token,
        accountId: typeof data.ilink_bot_id === "string" ? data.ilink_bot_id : "",
        baseUrl: typeof data.baseurl === "string" && data.baseurl ? data.baseurl : undefined,
        userId: typeof data.ilink_user_id === "string" && data.ilink_user_id ? data.ilink_user_id : undefined,
      };
    }
    if (status === "expired") return { status: "expired" };
    if (status === "cancel" || status === "canceled" || status === "denied") return { status: "cancelled" };
    return { status: "wait" };
  }

  async getUpdates(syncBuf: string, signal?: AbortSignal): Promise<{ messages: InboundMessage[]; syncBuf?: string }> {
    const data = await this.request("POST", "ilink/bot/getupdates", {
      body: { base_info: { channel_version: "vex" }, get_updates_buf: syncBuf },
      auth: true,
      timeoutMs: this.opts.updatesTimeoutMs ?? DEFAULT_UPDATES_TIMEOUT_MS,
      signal,
    });
    const msgs = Array.isArray(data.msgs) ? data.msgs : [];
    const messages = msgs.flatMap((raw) => {
      const message = normalizeMessage(raw);
      return message ? [message] : [];
    });
    const next = typeof data.get_updates_buf === "string" ? data.get_updates_buf : "";
    return next ? { messages, syncBuf: next } : { messages };
  }

  async sendText(toUserId: string, contextToken: string, text: string, signal?: AbortSignal): Promise<void> {
    await this.request("POST", "ilink/bot/sendmessage", {
      body: {
        base_info: { channel_version: "vex" },
        msg: {
          from_user_id: "",
          to_user_id: toUserId,
          client_id: randomUUID(),
          message_type: 2,
          message_state: 2,
          context_token: contextToken,
          item_list: [{ type: 1, text_item: { text } }],
        },
      },
      auth: true,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      signal,
    });
  }

  private async request(method: string, endpoint: string, opts: RequestOptions): Promise<Record<string, unknown>> {
    const url = new URL(`${this.baseUrl}/${endpoint}`);
    for (const [key, value] of Object.entries(opts.query ?? {})) url.searchParams.set(key, value);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      "X-WECHAT-UIN": randomUin(),
      ...opts.headers,
    };
    if (opts.auth && this.opts.token) headers.Authorization = `Bearer ${this.opts.token}`;
    const timeout = AbortSignal.timeout(opts.timeoutMs);
    const response = await fetch(url, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
    });
    if (!response.ok) throw new Error(`WeChat API ${endpoint} returned HTTP ${response.status}`);
    const parsed: unknown = await response.json();
    const data = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    // The API reports failures in the body even on HTTP 200.
    const ret = typeof data.ret === "number" ? data.ret : 0;
    const errcode = typeof data.errcode === "number" ? data.errcode : 0;
    if (ret !== 0 || errcode !== 0) {
      throw new WeChatApiError(endpoint, ret, errcode, typeof data.errmsg === "string" ? data.errmsg : "");
    }
    return data;
  }
}

function randomUin(): string {
  return Buffer.from(String(randomBytes(4).readUInt32BE(0)), "utf8").toString("base64");
}

function normalizeMessage(raw: unknown): InboundMessage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const m = raw as Record<string, unknown>;
  const fromUserId = typeof m.from_user_id === "string" ? m.from_user_id.trim() : "";
  if (!fromUserId) return undefined;
  const items = Array.isArray(m.item_list) ? (m.item_list.filter((i) => i && typeof i === "object") as InboundItem[]) : [];
  const explicitId = [m.message_id, m.msg_id].find((v) => typeof v === "string" || typeof v === "number");
  return {
    messageId: explicitId !== undefined ? String(explicitId) : fallbackId(fromUserId, m.create_time_ms ?? m.create_time, items),
    fromUserId,
    contextToken: typeof m.context_token === "string" ? m.context_token.trim() : "",
    items,
  };
}

// Redelivered messages without an id must map to the same key so they dedupe.
function fallbackId(from: string, time: unknown, items: InboundItem[]): string {
  const material = JSON.stringify({ from, time: time ?? "", items });
  return `wx_${createHash("sha1").update(material).digest("hex").slice(0, 16)}`;
}
