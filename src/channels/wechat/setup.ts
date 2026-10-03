import { stat } from "node:fs/promises";
import type { Logger } from "pino";
import type { VexConfig } from "../../config/schema.js";
import type { EventBus } from "../../core/events.js";
import type { VexPaths } from "../../paths.js";
import type { ApprovalManager } from "../../policy/approvals.js";
import { WeChatChannel, type WeChatSessions } from "./channel.js";
import { WeChatClient } from "./client.js";
import { linkWeChat } from "./link.js";
import type { LoginOptions } from "./login.js";
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

export interface WeChatRuntime {
  readonly channel: WeChatChannel | undefined;
  stop(): Promise<void>;
}

type WeChatOptions = Parameters<typeof startWeChatChannel>[0];

/**
 * Owns the channel lifecycle. Credentials.json is the source of truth: whoever writes it (this
 * daemon's own QR login, `vex wechat login`, another container sharing the volume) takes effect
 * without a restart. When WeChat is unlinked or the session has expired, the daemon shows a QR
 * code itself.
 */
export async function runWeChat(
  opts: WeChatOptions & { print?: (text: string) => void; login?: LoginOptions },
  pollMs = 3000,
): Promise<WeChatRuntime> {
  const { config, paths, log } = opts;
  const print = opts.print ?? ((text: string) => console.log(text));
  const file = new WeChatStore(paths.wechat).credentialsFile;
  const stamp = () => stat(file).then((info) => info.mtimeMs, () => undefined);
  const start = () => startWeChatChannel(opts).catch((err: unknown) => {
    log.error({ err }, "wechat failed to start; running without wechat");
    return undefined;
  });
  let seen = await stamp();
  let channel = await start();
  let busy: Promise<void> | undefined;
  let loginFailed = false;
  let closed = false;
  const stopping = new AbortController();

  const link = async () => {
    log.info("wechat needs a QR login; scan the code below");
    try {
      await linkWeChat({ paths, baseUrl: config.wechat.baseUrl, print, login: { ...opts.login, signal: stopping.signal } });
    } catch (err) {
      if (closed) return;
      loginFailed = true;
      log.warn({ err }, "wechat QR login did not finish; run `vex wechat login` to retry");
    }
  };
  const reconcile = async () => {
    const current = await stamp();
    if (closed) return;
    if (current !== undefined && current !== seen) {
      seen = current;
      loginFailed = false;
      const previous = channel;
      channel = undefined;
      await previous?.stop();
      channel = await start();
      return;
    }
    const needsLogin = current === undefined || channel?.expired === true;
    if (needsLogin && !loginFailed) await link();
  };
  const tick = () => {
    if (busy || closed) return;
    busy = reconcile().catch((err: unknown) => log.error({ err }, "wechat reconcile failed")).finally(() => { busy = undefined; });
  };
  const timer = config.wechat.enabled ? setInterval(tick, pollMs) : undefined;
  timer?.unref();
  if (config.wechat.enabled) tick();
  return {
    get channel() { return channel; },
    async stop() { closed = true; stopping.abort(); clearInterval(timer); await busy; await channel?.stop(); },
  };
}
