import type { VexPaths } from "../../paths.js";
import { WeChatClient } from "./client.js";
import { loginWithQr, type LoginOptions, type LoginResult } from "./login.js";
import { WeChatStore } from "./store.js";

export async function linkWeChat(opts: {
  paths: VexPaths;
  baseUrl: string;
  print: (text: string) => void;
  login?: LoginOptions;
}): Promise<LoginResult> {
  const result = await loginWithQr(new WeChatClient({ baseUrl: opts.baseUrl }), opts.print, opts.login);
  await new WeChatStore(opts.paths.wechat).saveCredentials({
    token: result.token,
    accountId: result.accountId,
    baseUrl: isHttpsUrl(result.baseUrl) ? result.baseUrl : opts.baseUrl,
    userId: result.userId,
  });
  return result;
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
