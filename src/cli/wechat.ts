import { linkWeChat } from "../channels/wechat/link.js";
import type { LoginOptions } from "../channels/wechat/login.js";
import { loadConfig } from "../config/load.js";
import type { VexPaths } from "../paths.js";

export async function runWeChatLogin(
  print: (text: string) => void,
  paths: VexPaths,
  opts: LoginOptions & { baseUrl?: string; restartHint?: boolean } = {},
): Promise<void> {
  const { config } = await loadConfig(paths);
  const result = await linkWeChat({ paths, baseUrl: opts.baseUrl ?? config.wechat.baseUrl, print, login: opts });
  print(result.userId ? `已绑定微信，主人是扫码的这个微信号（${result.userId}）。` : "已绑定微信。");
  if (!result.userId && !config.wechat.ownerId) {
    print("没有拿到扫码人的微信 id：请在 config.yaml 中设置 wechat.ownerId，否则 vexd 不会回复任何微信消息。");
  }
  if (opts.restartHint !== false) print("vexd 运行中会在几秒内自动接入。");
}
