/**
 * ConfigStore — resolves EffectiveConfig for each (userId, channelId) pair.
 *
 * Architecture doc (§9, §4):
 *   "Any code path that needs config reads from EffectiveConfig."
 *   "Config resolution at runtime — System defaults (YAML) merge with
 *    user overrides (SQLite) at dispatch time."
 *
 * Resolution order:
 *   1. Built-in defaults (BUILT_IN_DEFAULTS in EffectiveConfig.ts)
 *   2. config.local.yaml (system-level via YamlLoader)
 *   3. SQLite web_user_settings (user-level, passed as sqliteOverrides)
 *
 * Usage from Dispatcher:
 *   const config = await configStore.resolve(userId, ctx.channelId);
 */

import type { EffectiveConfig } from "./EffectiveConfig.js";
import { BUILT_IN_DEFAULTS } from "./EffectiveConfig.js";
import type { YamlLoader } from "./resolvers/YamlLoader.js";

// ---------------------------------------------------------------------------
// Deep-merge helpers (purely data, no Zod runtime)
// ---------------------------------------------------------------------------

/** Merge partial data into a target, mutating the target. Handles nested
 *  objects (one level deep for top-level sections like agent, server, etc.). */
function mergeSection<T extends Record<string, unknown>>(
  target: T,
  source: Partial<T> | undefined | null,
): T {
  if (!source) return target;
  for (const key of Object.keys(source) as (keyof T)[]) {
    const val = source[key];
    if (val !== undefined) {
      (target as Record<string, unknown>)[key as string] = val;
    }
  }
  return target;
}

// ---------------------------------------------------------------------------
// ConfigStore
// ---------------------------------------------------------------------------

export class ConfigStore {
  private readonly yamlLoader: YamlLoader;

  constructor(options: { yamlLoader: YamlLoader }) {
    this.yamlLoader = options.yamlLoader;
  }

  /**
   * Resolve the effective config for a (userId, channelId) pair.
   *
   * @param userId - Web user ID (or synthetic ID for non-auth flows).
   * @param channelId - "webchat" | "weixin" | etc.
   * @param sqliteOverrides - Optional user-level overrides from SQLite
   *                          web_user_settings.settings_json.
   */
  async resolve(
    userId: string,
    channelId: string,
    sqliteOverrides?: Record<string, unknown>,
  ): Promise<EffectiveConfig> {
    // Tier 1: built-in defaults
    const config: Record<string, unknown> = {
      ...BUILT_IN_DEFAULTS,
      providers: { ...BUILT_IN_DEFAULTS.providers },
      agent: { ...BUILT_IN_DEFAULTS.agent },
      server: { ...BUILT_IN_DEFAULTS.server },
      logging: { ...BUILT_IN_DEFAULTS.logging },
    };

    // Tier 2: YAML file (system-level)
    const yamlData = this.yamlLoader.load();
    this.applyTo(config, yamlData);

    // Tier 3: SQLite user-level overrides
    if (sqliteOverrides) {
      this.applyTo(config, sqliteOverrides);
    }

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    return {
      userId,
      channelId,
      ...(this.stampConfig(config) as Omit<EffectiveConfig, "userId" | "channelId">),
    } as EffectiveConfig;
  }

  /** Apply a partial config on top of the accumulator (one-level deep merge). */
  private applyTo(acc: Record<string, unknown>, layer: Record<string, unknown>): void {
    for (const key of Object.keys(layer)) {
      const layerVal = layer[key];
      if (layerVal === undefined) continue;

      const accVal = acc[key];
      if (
        accVal != null &&
        typeof accVal === "object" &&
        !Array.isArray(accVal) &&
        typeof layerVal === "object" &&
        !Array.isArray(layerVal)
      ) {
        // Nested section: merge field by field
        acc[key] = { ...(accVal as Record<string, unknown>), ...(layerVal as Record<string, unknown>) };
      } else {
        acc[key] = layerVal;
      }
    }
  }

  /** Ensure all required EffectiveConfig fields are present after resolution. */
  private stampConfig(raw: Record<string, unknown>): Record<string, unknown> {
    // Agent defaults (any missing scalar gets the built-in default)
    const agent = (raw.agent as Record<string, unknown>) ?? {};
    raw.agent = {
      defaultModel: agent.defaultModel ?? BUILT_IN_DEFAULTS.agent.defaultModel,
      defaultProvider: agent.defaultProvider ?? BUILT_IN_DEFAULTS.agent.defaultProvider,
      temperature: (agent.temperature as number) ?? BUILT_IN_DEFAULTS.agent.temperature,
      maxTokens: (agent.maxTokens as number) ?? BUILT_IN_DEFAULTS.agent.maxTokens,
      ...agent,
    };

    // Server defaults
    const server = (raw.server as Record<string, unknown>) ?? {};
    raw.server = {
      port: (server.port as number) ?? BUILT_IN_DEFAULTS.server.port,
      host: (server.host as string) ?? BUILT_IN_DEFAULTS.server.host,
      ...server,
    };

    // Logging defaults
    const logging = (raw.logging as Record<string, unknown>) ?? {};
    raw.logging = {
      level: (logging.level as string) ?? BUILT_IN_DEFAULTS.logging.level,
      pretty: (logging.pretty as boolean) ?? BUILT_IN_DEFAULTS.logging.pretty,
      ...logging,
    };

    return raw;
  }
}
