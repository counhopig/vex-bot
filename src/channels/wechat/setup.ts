import type { Logger } from "pino";
import type { VexConfig } from "../../config/schema.js";
import type { EventBus } from "../../core/events.js";
import type { VexPaths } from "../../paths.js";
import type { ApprovalManager } from "../../policy/approvals.js";
import { WeChatChannel, type WeChatSessions } from "./channel.js";
import { WeChatClient } from "./client.js";
import { WeChatStore } from "./store.js";

export async function startWeChatChannel(opts: {
  config: VexConfig;
  paths: VexPaths;
  sessions: WeChatSessions;
  approvals: ApprovalManager;
  bus: EventBus;
  log: Logger;
}): Promise<WeChatChannel | undefined> {
  const { config, log } = opts;
  if (!config.wechat.enabled) return undefined;
  const store = new WeChatStore(opts.paths.wechat);
  const credentials = await store.loadCredentials();
  if (!credentials) {
    log.info("wechat not linked; run `vex wechat login` to link it");
    return undefined;
  }
  const ownerId = config.wechat.ownerId ?? credentials.userId;
  if (!ownerId) {
    log.warn("wechat owner unknown; set wechat.ownerId in config.yaml");
    return undefined;
  }
  const channel = new WeChatChannel({
    client: new WeChatClient({ baseUrl: credentials.baseUrl, token: credentials.token }),
    store,
    ownerId,
    sessions: opts.sessions,
    approvals: opts.approvals,
    bus: opts.bus,
    log,
  });
  await channel.start();
  log.info({ ownerId }, "wechat channel started");
  return channel;
}
