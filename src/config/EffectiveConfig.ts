/**
 * EffectiveConfig — the resolved, single-source-of-truth configuration
 * for a specific (userId, channelId) pair.
 *
 * Architecture doc (§9): "Any code path that needs config reads from
 * EffectiveConfig. There is no 'global config' vs 'user config' divergence."
 *
 * Resolution order (ConfigStore.resolve):
 *   1. Built-in defaults (hardcoded below)
 *   2. config.local.yaml (system-level)
 *   3. SQLite web_user_settings (user-level overrides, per-field)
 */

import type { EffectiveWeatherConfig } from "./weather.js";

export interface EffectiveConfig {
  readonly userId: string;
  readonly channelId: string;

  providers: Record<string, { baseUrl?: string; apiKey?: string; headers?: Record<string, string> }>;
  agent: {
    defaultModel: string;
    defaultProvider: string;
    temperature: number;
    maxTokens: number;
    workingDirectory?: string;
    systemPrompt?: string;
    bashEnvPassthrough?: string[];
  };
  server: {
    port: number;
    host: string;
  };
  logging: {
    level: "debug" | "info" | "warn" | "error";
    pretty?: boolean;
  };
  memory?: {
    enabled?: boolean;
    directory?: string;
  };
  skills?: {
    enabled?: boolean;
    userDir?: string;
    workspaceDir?: string;
    disabled?: string[];
    only?: string[];
  };
  persona?: Record<string, unknown>; // absent = disabled (opt-in)
  /** Normalized (camelCase) per-user weather section; snake_case sources are
   *  converted by ConfigStore at the EffectiveConfig boundary. */
  weather?: EffectiveWeatherConfig;
  /** Per-user session settings. Only `file` persistence exists; directory is
   *  honored with path-containment validation (see buildAgentFactory). */
  sessions?: {
    type?: "file";
    directory?: string;
    ttlMs?: number;
  };
  /** Per-user ShareLink extension settings (camelCase, panel shape). */
  sharelink?: Record<string, unknown>;
  /** Per-user SkillLearner extension settings (camelCase, panel shape). */
  skillLearner?: Record<string, unknown>;
  webAuth?: {
    enabled?: boolean;
    database?: string;
  };
}

/** Hardcoded built-in defaults (tier 1 of config resolution). */
export const BUILT_IN_DEFAULTS: Omit<EffectiveConfig, "userId" | "channelId"> = {
  providers: {},
  agent: {
    defaultModel: "deepseek-chat",
    defaultProvider: "deepseek",
    temperature: 0.7,
    maxTokens: 4096,
  },
  server: {
    port: 3000,
    host: "127.0.0.1",
  },
  logging: {
    level: "info",
    pretty: true,
  },
};
