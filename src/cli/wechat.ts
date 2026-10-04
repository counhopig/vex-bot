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
  print(result.userId ? `WeChat linked; the owner is the account that scanned the code (${result.userId}).` : "WeChat linked.");
  if (!result.userId && !config.wechat.ownerId) {
    print("Could not read the scanning account's WeChat id: set wechat.ownerId in config.yaml, otherwise vexd will not answer any WeChat message.");
  }
  if (opts.restartHint !== false) print("A running vexd will connect within a few seconds.");
}
