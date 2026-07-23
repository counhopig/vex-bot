/**
 * Build a ShareLink platform registry from a resolved config. Shared by the
 * auto-detect interceptor and the sharelink_parse tool so both use the same
 * (per-owner / per-agent) bilibili cookie instead of a global singleton.
 */

import type { ShareLinkConfig } from "../../types/index.js";
import { PlatformRegistry } from "./platforms/registry.js";
import { BilibiliAdapter } from "./platforms/bilibili.js";
import { YouTubeAdapter } from "./platforms/youtube.js";

export function buildShareLinkRegistry(cfg: ShareLinkConfig | undefined): PlatformRegistry {
  const cookie = cfg?.bilibiliCookie ?? {};
  const registry = new PlatformRegistry();
  registry.register(new BilibiliAdapter(cookie.sessdata ?? "", cookie.biliJct ?? ""));
  registry.register(new YouTubeAdapter());
  return registry;
}
