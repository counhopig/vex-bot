/**
 * Gateway server - HTTP webhook processing + WebChat
 */

import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { createServer, type Server as HttpServer } from "http";
import NodeCache from "node-cache";
import type { VexConfig, InboundMessageContext } from "../types/index.js";
import { createWeixinChannel, type WeixinChannel } from "../channels/weixin/index.js";
import { registerChannel, getChannel } from "../channels/common/index.js";
import { createAgent, type Agent } from "../agents/agent.js";
import { initializeProviders } from "../providers/index.js";
import { getChildLogger, setLogger, createLogger } from "../utils/logger.js";
import { WsServer } from "../web/websocket.js";
import { handleStaticRequest } from "../web/static.js";
import { runMessageInterceptors, runResponseObservers } from "../pipeline/index.js";

const logger = getChildLogger("gateway");

export class Gateway {
  private app: Express;
  private httpServer: HttpServer;
  private config: VexConfig;
  private agent!: Agent;
  private weixinChannel?: WeixinChannel;
  private wsServer?: WsServer;
  private processedMessages: NodeCache;
  private readonly MESSAGE_CACHE_TTL_SEC = 300;
  private readonly MESSAGE_CACHE_MAX_KEYS = 10000;

  constructor(config: VexConfig) {
    this.config = config;
    this.app = express();
    this.httpServer = createServer(this.app);
    this.processedMessages = new NodeCache({
      stdTTL: this.MESSAGE_CACHE_TTL_SEC,
      maxKeys: this.MESSAGE_CACHE_MAX_KEYS,
      useClones: false,
    });

    this.setupMiddleware();
    this.setupRoutes();
  }

  async initAgent(): Promise<void> {
    this.agent = await createAgent(this.config);
  }

  private setupMiddleware(): void {
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));
    this.app.use((req, res, next) => {
      logger.debug({ method: req.method, path: req.path }, "Incoming request");
      next();
    });
  }

  private setupRoutes(): void {
    this.app.get("/health", (req, res) => {
      res.json({ status: "ok", timestamp: new Date().toISOString() });
    });

    if (this.config.channels.weixin) {
      this.weixinChannel = createWeixinChannel(this.config.channels.weixin);
      this.weixinChannel.setMessageHandler(this.handleMessage.bind(this));
      registerChannel(this.weixinChannel);
      logger.info("Weixin (Personal WeChat) channel enabled");
    }

    this.app.use((req, res, next) => {
      const handled = handleStaticRequest(req, res, { config: this.config });
      if (!handled) {
        next();
      }
    });

    this.app.use((req, res) => {
      res.status(404).json({ error: "Not found" });
    });

    this.app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
      logger.error({ error: err }, "Unhandled error");
      res.status(500).json({ error: "Internal server error" });
    });
  }

  private async handleMessage(context: InboundMessageContext): Promise<void> {
    const startedAt = Date.now();
    if (this.isDuplicateMessage(context.messageId)) {
      logger.debug(
        { messageId: context.messageId, channel: context.channelId, chatId: context.chatId, senderId: context.senderId },
        "Skipping duplicate message"
      );
      return;
    }

    logger.info(
      { channel: context.channelId, chatId: context.chatId, senderId: context.senderId, content: context.content.slice(0, 100) },
      "Received message"
    );

    if (!context.content.trim()) {
      logger.debug(
        { channel: context.channelId, chatId: context.chatId, senderId: context.senderId, messageId: context.messageId },
        "Skipping empty message"
      );
      return;
    }

    // Run message interceptors (commands, auto-detect, skill capture)
    logger.debug(
      {
        channel: context.channelId,
        chatId: context.chatId,
        senderId: context.senderId,
        messageId: context.messageId,
        contentLength: context.content.length,
      },
      "Running gateway interceptors"
    );
    const intercepted = await runMessageInterceptors(context);
    if (intercepted !== null) {
      await this.sendReply(context, intercepted);
      logger.info(
        {
          channel: context.channelId,
          chatId: context.chatId,
          responseLength: intercepted.length,
          durationMs: Date.now() - startedAt,
        },
        "Interceptor reply sent"
      );
      return;
    }

    try {
      logger.debug(
        { channel: context.channelId, chatId: context.chatId, senderId: context.senderId, messageId: context.messageId },
        "Dispatching message to agent"
      );
      const response = await this.agent.processMessage(context);
      await this.sendReply(context, response.content);
      logger.info(
        {
          channel: context.channelId,
          chatId: context.chatId,
          responseLength: response.content.length,
          provider: response.provider,
          model: response.model,
          usage: response.usage,
          durationMs: Date.now() - startedAt,
        },
        "Reply sent"
      );

      // Run response observers
      await runResponseObservers(context, response.content);
      logger.debug(
        { channel: context.channelId, chatId: context.chatId, senderId: context.senderId, responseLength: response.content.length },
        "Gateway response observers completed"
      );
    } catch (error) {
      logger.error(
        {
          error,
          channel: context.channelId,
          chatId: context.chatId,
          senderId: context.senderId,
          messageId: context.messageId,
          durationMs: Date.now() - startedAt,
        },
        "Failed to process message"
      );
      await this.sendReply(context, "Sorry, an error occurred while processing your message. Please try again later.");
    }
  }

  private async sendReply(context: InboundMessageContext, text: string): Promise<void> {
    const channel = getChannel(context.channelId);
    if (!channel) {
      logger.warn({ channelId: context.channelId }, "No channel registered for reply");
      return;
    }
    try {
      await channel.replyToContext(context, text);
    } catch (error) {
      logger.error({ error, channelId: context.channelId, chatId: context.chatId }, "Failed to send reply");
    }
  }

  private isDuplicateMessage(messageId: string): boolean {
    if (this.processedMessages.has(messageId)) return true;
    this.processedMessages.set(messageId, 1);
    return false;
  }

  async initialize(): Promise<void> {
    logger.info("Initializing gateway...");
    initializeProviders(this.config);

    this.wsServer = new WsServer({
      server: this.httpServer,
      agent: this.agent,
      config: this.config,
      weixinChannel: this.weixinChannel,
    });

    if (this.weixinChannel) {
      await this.weixinChannel.initialize();
    }

    logger.info("Gateway initialized");
  }

  async start(): Promise<void> {
    await this.initialize();

    const { port, host } = this.config.server;

    this.httpServer.listen(port, host || "0.0.0.0", () => {
      logger.info({ port, host: host || "0.0.0.0" }, "Gateway server started");
      console.log(`\n🚀 Vex Gateway started`);
      console.log(`   Address: http://${host || "localhost"}:${port}`);
      console.log(`   WebChat: http://${host || "localhost"}:${port}/`);
      console.log(`   Control Panel: http://${host || "localhost"}:${port}/control`);
      if (this.weixinChannel) {
        console.log(`   Personal WeChat: iLink OC API ready`);
      }
      console.log("");
    });
  }

  async shutdown(): Promise<void> {
    logger.info("Shutting down gateway...");
    if (this.wsServer) this.wsServer.close();
    if (this.weixinChannel) await this.weixinChannel.shutdown();
    this.httpServer.close();
    logger.info("Gateway shut down");
  }

  getApp(): Express {
    return this.app;
  }
}

export async function createGateway(config: VexConfig): Promise<Gateway> {
  const gateway = new Gateway(config);
  await gateway.initAgent();
  return gateway;
}

export async function startGateway(config: VexConfig): Promise<Gateway> {
  setLogger(createLogger({ level: config.logging.level }));
  const gateway = await createGateway(config);
  await gateway.start();
  process.on("SIGINT", async () => { console.log("\nReceived SIGINT, shutting down..."); await gateway.shutdown(); process.exit(0); });
  process.on("SIGTERM", async () => { console.log("\nReceived SIGTERM, shutting down..."); await gateway.shutdown(); process.exit(0); });
  return gateway;
}
