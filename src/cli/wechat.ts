import { WeChatClient } from "../channels/wechat/client.js";
import { loginWithQr, type LoginOptions } from "../channels/wechat/login.js";
import { WeChatStore } from "../channels/wechat/store.js";
import { loadConfig } from "../config/load.js";
import type { VexPaths } from "../paths.js";

export async function runWeChatLogin(
  print: (text: string) => void,
  paths: VexPaths,
  opts: LoginOptions & { baseUrl?: string; restartHint?: boolean } = {},
): Promise<void> {
  const { config } = await loadConfig(paths);
  const baseUrl = opts.baseUrl ?? config.wechat.baseUrl;
  const client = new WeChatClient({ baseUrl });
  const result = await loginWithQr(client, print, opts);
  await new WeChatStore(paths.wechat).saveCredentials({
    token: result.token,
    accountId: result.accountId,
    baseUrl: isHttpsUrl(result.baseUrl) ? result.baseUrl : baseUrl,
    userId: result.userId,
  });
  print(result.userId ? `已绑定微信，主人是扫码的这个微信号（${result.userId}）。` : "已绑定微信。");
  if (!result.userId && !config.wechat.ownerId) {
    print("没有拿到扫码人的微信 id：请在 config.yaml 中设置 wechat.ownerId，否则 vexd 不会回复任何微信消息。");
  }
  if (opts.restartHint !== false) print("重启 vexd 后生效：vex stop && vex start -d");
}

// The stored base URL later receives the bearer token.
function isHttpsUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
