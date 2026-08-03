/**
 * Build a per-config PlatformRegistry.
 *
 * Each call returns a fresh registry with fresh adapter instances — no
 * module-level caching, satisfying the instance-scoped requirement.
 */

import { PlatformRegistry } from "./platforms/registry.js";
import { BilibiliAdapter } from "./platforms/bilibili.js";
import { YouTubeAdapter } from "./platforms/youtube.js";
import type { ShareLinkConfig } from "./index.js";

export function buildShareLinkRegistry(cfg: ShareLinkConfig | undefined): PlatformRegistry {
  const cookie = cfg?.bilibiliCookie ?? {};
  const registry = new PlatformRegistry();
  registry.register(new BilibiliAdapter(cookie.sessdata ?? "", cookie.biliJct ?? ""));
  registry.register(new YouTubeAdapter());
  return registry;
}
