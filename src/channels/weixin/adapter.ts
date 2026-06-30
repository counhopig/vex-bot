import yaml from "yaml";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import type {
  WeixinConfig,
  ChannelMeta,
  InboundMessageContext,
  OutboundMessage,
  SendResult,
} from "../../types/index.js";
import { BaseChannelAdapter } from "../common/base.js";
import {
  WeixinClient,
  DEFAULT_WEIXIN_OC_BASE_URL,
  DEFAULT_WEIXIN_OC_CDN_BASE_URL,
  DEFAULT_WEIXIN_OC_BOT_TYPE,
  DEFAULT_WEIXIN_OC_API_TIMEOUT_MS,
} from "./client.js";
import { startQRLogin } from "./login.js";
import type { LoginResult } from "./login.js";
import { getChildLogger } from "../../utils/logger.js";

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35000;

const WEIXIN_META: ChannelMeta = {
  id: "weixin",
  name: "Personal WeChat",
  description: "Personal WeChat bot (iLink OC API)",
  capabilities: {
    chatTypes: ["direct", "group"],
    supportsMedia: true,
    supportsReply: true,
    supportsMention: false,
    supportsReaction: false,
    supportsThread: false,
    supportsEdit: false,
    maxMessageLength: 2048,
  },
};

interface WeixinMessageItem {
  type: number;
  text_item?: { text: string };
  image_item?: { media?: Record<string, unknown>; aeskey?: string; mid_size?: number };
  voice_item?: { media?: Record<string, unknown>; text?: string };
  file_item?: { media?: Record<string, unknown>; file_name?: string; len?: string };
  video_item?: { media?: Record<string, unknown>; video_size?: number };
  ref_msg?: Record<string, unknown>;
}

interface WeixinInboundMessage {
  from_user_id: string;
  context_token: string;
  item_list: WeixinMessageItem[];
  message_id?: string;
  msg_id?: string;
  create_time_ms?: number;
  create_time?: number;
}

interface WeixinPollResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: Array<WeixinInboundMessage | Record<string, unknown>>;
}

export class WeixinChannel extends BaseChannelAdapter {
  readonly id = "weixin" as const;
  readonly meta = WEIXIN_META;

  private config: WeixinConfig;
  private client: WeixinClient;
  private readonly configPath?: string;
  private pollingActive = false;
  private pollingTimer: ReturnType<typeof setTimeout> | null = null;
  private loginResult: LoginResult | null = null;
  private contextTokens: Map<string, string> = new Map();

  constructor(config: WeixinConfig, options?: { configPath?: string }) {
    super();
    this.config = config;
    this.configPath = options?.configPath;
    this.logger = getChildLogger("weixin");

    const baseUrl = config.baseUrl ?? DEFAULT_WEIXIN_OC_BASE_URL;
    const cdnBaseUrl = config.cdnBaseUrl ?? DEFAULT_WEIXIN_OC_CDN_BASE_URL;
    const apiTimeoutMs = config.apiTimeoutMs ?? DEFAULT_WEIXIN_OC_API_TIMEOUT_MS;

    this.client = new WeixinClient(
      "weixin",
      baseUrl,
      cdnBaseUrl,
      apiTimeoutMs,
      config.token ?? undefined,
    );
  }

  async initialize(): Promise<void> {
    if (this.pollingActive) return;

    this.logger.info("Initializing Weixin (Personal WeChat) channel");

    if (this.config.token) {
      this.logger.info("Weixin channel using existing token from config");
    } else {
      this.logger.info("No token configured, starting QR code login");
      const botType = this.config.botType ?? DEFAULT_WEIXIN_OC_BOT_TYPE;
      try {
        this.loginResult = await startQRLogin(this.client, botType);
        this.config.token = this.loginResult.token;
        this.client.setToken(this.loginResult.token);
        this.persistToken();
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error({ error: errorMessage }, "Weixin QR login failed");
        throw new Error("Weixin QR login failed: " + errorMessage);
      }
    }

    this.pollingActive = true;
    this.startPollingLoop();
  }

  async shutdown(): Promise<void> {
    this.logger.info("Shutting down Weixin channel");
    this.pollingActive = false;

    if (this.pollingTimer !== null) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = null;
    }

    this.contextTokens.clear();
    this.loginResult = null;
  }

  async sendMessage(message: OutboundMessage): Promise<SendResult> {
    try {
      const userId = message.chatId;
      const contextToken = this.contextTokens.get(userId);

      if (!contextToken) {
        const msg =
          "Missing context_token for user " +
          userId +
          ". Send a message to this user first to obtain it.";
        this.logger.warn({ userId }, msg);
        return { success: false, error: msg };
      }

      const itemList: unknown[] = [
        { type: 1, text_item: { text: message.content } },
      ];

      await this.client.sendMessage(userId, contextToken, itemList);
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error({ error: errorMessage, message }, "Failed to send message");
      return { success: false, error: errorMessage };
    }
  }

  async sendText(
    chatId: string,
    text: string,
    replyToId?: string,
  ): Promise<SendResult> {
    return this.sendMessage({ chatId, content: text, replyToId });
  }

  async isHealthy(): Promise<boolean> {
    return this.client.checkHealth();
  }

  private startPollingLoop(): void {
    this.pollingLoop().catch((error: unknown) => {
      this.logger.error({ error }, "Polling loop crashed");
      if (this.pollingActive) {
        this.pollingTimer = setTimeout(() => this.startPollingLoop(), 5000);
      }
    });
  }

  private async pollingLoop(): Promise<void> {
    const longPollTimeoutMs =
      this.config.longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;

    while (this.pollingActive) {
      try {
        const response = (await this.client.pollMessages()) as WeixinPollResponse;

        const ret = response.ret ?? 0;
        const errcode = response.errcode ?? 0;
        if (ret !== 0 || errcode !== 0) {
          const errmsg = response.errmsg ?? "unknown error";
          this.logger.warn(
            { ret, errcode, errmsg },
            "Weixin pollMessages returned error",
          );

          if (errcode === -14) {
            this.logger.warn("Weixin session timed out, clearing state");
            await this.handleSessionTimeout();
            return;
          }

          await this.delay(5000);
          continue;
        }

        const msgs = response.msgs ?? [];
        for (const rawMsg of msgs) {
          if (!this.pollingActive) return;
          if (rawMsg === null || typeof rawMsg !== "object") continue;

          const msg = rawMsg as WeixinInboundMessage;
          await this.handleInboundWeixinMessage(msg);
        }

        await this.delay(longPollTimeoutMs);
      } catch (error) {
        if (!this.pollingActive) return;

        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          { error: errorMessage },
          "Polling error, retrying after delay",
        );
        await this.delay(5000);
      }
    }
  }

  private async handleInboundWeixinMessage(
    msg: WeixinInboundMessage,
  ): Promise<void> {
    const fromUserId = (msg.from_user_id ?? "").trim();
    if (!fromUserId) {
      this.logger.debug("Skipping message with empty from_user_id");
      return;
    }

    const contextToken = (msg.context_token ?? "").trim();
    if (contextToken) {
      this.contextTokens.set(fromUserId, contextToken);
    }

    const content = this.extractTextContent(msg.item_list ?? []);
    const messageId = msg.message_id ?? msg.msg_id ?? "wx_" + String(Date.now());

    let timestamp: number;
    if (
      msg.create_time_ms !== undefined &&
      msg.create_time_ms > 1_000_000_000_000
    ) {
      timestamp = Math.floor(msg.create_time_ms / 1000);
    } else if (msg.create_time !== undefined && msg.create_time > 0) {
      timestamp = msg.create_time;
    } else {
      timestamp = Math.floor(Date.now() / 1000);
    }

    const context: InboundMessageContext = {
      channelId: "weixin",
      messageId,
      chatId: fromUserId,
      chatType: "direct",
      senderId: fromUserId,
      content,
      timestamp,
      raw: msg,
    };

    await this.handleInboundMessage(context);
  }

  private extractTextContent(items: WeixinMessageItem[]): string {
    const textParts: string[] = [];

    for (const item of items) {
      switch (item.type) {
        case 1: {
          const text = item.text_item?.text ?? "";
          if (text.trim()) {
            textParts.push(text);
          }
          break;
        }
        case 2:
          textParts.push("[Image]");
          break;
        case 3: {
          const voiceText = item.voice_item?.text ?? "";
          if (voiceText.trim()) {
            textParts.push(voiceText);
          } else {
            textParts.push("[Voice]");
          }
          break;
        }
        case 4:
          textParts.push("[File]");
          break;
        case 5:
          textParts.push("[Video]");
          break;
      }
    }

    return textParts.join("\n").trim();
  }

  private async handleSessionTimeout(): Promise<void> {
    this.config.token = undefined;
    this.loginResult = null;
    this.contextTokens.clear();

    this.pollingActive = false;
    if (this.pollingTimer !== null) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = null;
    }

    try {
      this.logger.info("Re-initializing after session timeout");
      await this.initialize();
    } catch (error) {
      this.logger.error(
        { error },
        "Failed to re-initialize after session timeout",
      );
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private persistToken(): void {
    try {
      const configPath = this.configPath;
      if (!configPath) {
        this.logger.warn("No config path available, skipping Weixin token persistence");
        return;
      }
      let existing: Record<string, unknown> = {};
      if (existsSync(configPath)) {
        existing = (yaml.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown> | null) ?? {};
      }
      const channels = (existing.channels as Record<string, unknown>) ?? {};
      channels.weixin = {
        ...(channels.weixin as Record<string, unknown> ?? {}),
        token: this.config.token,
        accountId: this.config.accountId ?? this.loginResult?.accountId,
        enabled: true,
      };
      existing.channels = channels;
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, yaml.stringify(existing), "utf-8");
      this.logger.info({ configPath }, "Weixin token persisted to config");
    } catch (error) {
      this.logger.error({ error }, "Failed to persist Weixin token");
    }
  }

  /** Get login QR code (for WebUI use) */
  async getLoginQRCode(): Promise<{ qrcode: string; qrcodeImgContent: string } | null> {
    try {
      const botType = this.config.botType ?? DEFAULT_WEIXIN_OC_BOT_TYPE;
      return await this.client.getQRCode(botType);
    } catch (error) {
      this.logger.error({ error }, "Failed to get QR code");
      return null;
    }
  }

  /** Poll QR code status (for WebUI use) */
  async checkQRStatus(qrcode: string): Promise<{
    status: string;
    botToken?: string;
    accountId?: string;
    baseUrl?: string;
    userId?: string;
  }> {
    const result = await this.client.pollQRStatus(qrcode, 15000);
    if (result.status === "confirmed" && result.botToken) {
      this.config.token = result.botToken;
      this.client.setToken(result.botToken);
      if (result.accountId) {
        this.config.accountId = result.accountId;
      }
      this.persistToken();
    }
    return result;
  }
}

export function createWeixinChannel(config: WeixinConfig, options?: { configPath?: string }): WeixinChannel {
  return new WeixinChannel(config, options);
}
