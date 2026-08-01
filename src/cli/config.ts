/**
 * CLI config loading — reads config.local.yaml into a SystemConfig-shaped
 * object and validates required sections.
 *
 * The archive's loadConfig (with __configPath hack + module-global singletons)
 * is replaced by YamlLoader + VexConfigSchema; the merged result is returned
 * as a plain object the CLI passes to the web/server.ts bootstrap.
 */

import { homedir } from "os";
import { join, resolve } from "path";
import { existsSync } from "fs";
import { YamlLoader } from "../config/resolvers/YamlLoader.js";
import { BUILT_IN_DEFAULTS } from "../config/EffectiveConfig.js";
import type { SystemConfig } from "../web/routes/config.js";

/** Where the CLI looks for config: explicit path, CWD, then ~/.vex/. */
export function resolveConfigPath(explicit?: string): string {
  if (explicit) return resolve(explicit);
  const cwdPath = join(process.cwd(), "config.local.yaml");
  if (existsSync(cwdPath)) return cwdPath;
  return join(homedir(), ".vex", "config.local.yaml");
}

/** Load + validate config from an explicit path, CWD, or ~/.vex/. */
export function loadConfig(options?: { configPath?: string }): SystemConfig {
  const path = resolveConfigPath(options?.configPath);
  const loader = new YamlLoader(path);
  const raw = loader.load() as SystemConfig;

  // Merge over built-in defaults so the CLI never sees undefined scalars.
  return {
    ...BUILT_IN_DEFAULTS,
    ...raw,
    agent: { ...BUILT_IN_DEFAULTS.agent, ...(raw.agent ?? {}) },
    server: { ...BUILT_IN_DEFAULTS.server, ...(raw.server ?? {}) },
    logging: { ...BUILT_IN_DEFAULTS.logging, ...(raw.logging ?? {}) },
  } as SystemConfig;
}

/** Required-config validation (webOnly skips the channel requirement). */
export function validateRequiredConfig(
  config: SystemConfig,
  options?: { webOnly?: boolean },
): string[] {
  const errors: string[] = [];

  const providers = (config.providers ?? {}) as Record<string, Record<string, unknown>>;
  const hasProvider = Object.values(providers).some((p) => p && typeof p.apiKey === "string" && p.apiKey);
  if (!hasProvider) {
    errors.push("At least one model provider must be configured with an API key");
  }

  if (!options?.webOnly) {
    const channels = (config.channels ?? {}) as Record<string, Record<string, unknown>>;
    const weixin = channels.weixin;
    const weixinEnabled = weixin && weixin.enabled !== false;
    if (!weixinEnabled) {
      errors.push("No communication channel configured. Use --web-only for WebChat only, or configure channels.weixin");
    }
  }

  return errors;
}
