/**
 * Configuration loading and management
 */

import { z } from "zod";
import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import yaml from "yaml";
import type { VexConfig, ProviderId } from "../types/index.js";
import { getChildLogger } from "../utils/logger.js";
import { PROVIDER_IDS } from "../providers/metadata.js";

const logger = getChildLogger("config");

const RUNTIME_CONFIG_PATH_KEY = "__configPath";

// ============== Zod Schema ==============

const ProviderConfigSchema = z.object({
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  headers: z.record(z.string()).optional(),
}).passthrough();  // Allow extra fields (e.g. id, name, models for custom-openai and custom-anthropic)

const WeixinConfigSchema = z.object({
  baseUrl: z.string().optional(),
  token: z.string().optional(),
  accountId: z.string().optional(),
  botType: z.string().optional().default("3"),
  qrPollInterval: z.number().optional().default(1),
  longPollTimeoutMs: z.number().optional().default(35000),
  apiTimeoutMs: z.number().optional().default(120000),
  cdnBaseUrl: z.string().optional(),
  enabled: z.boolean().optional().default(true),
});

const AgentConfigSchema = z.object({
  defaultModel: z.string().default("deepseek-chat"),
  defaultProvider: z.enum(PROVIDER_IDS as [ProviderId, ...ProviderId[]]).default("deepseek"),
  systemPrompt: z.string().optional(),
  temperature: z.number().min(0).max(2).optional().default(0.7),
  maxTokens: z.number().optional().default(4096),
  workingDirectory: z.string().optional(),
  enableFunctionCalling: z.boolean().optional(),
});

const ServerConfigSchema = z.object({
  port: z.number().default(3000),
  host: z.string().optional().default("0.0.0.0"),
});

const LoggingConfigSchema = z.object({
  level: z.enum(["debug", "info", "warn", "error"]).default("info"),
  /** Colorized, human-readable console output. The log file stays JSON either way. */
  pretty: z.boolean().default(true),
});

const SessionStoreConfigSchema = z.object({
  type: z.enum(["memory", "file"]).optional().default("memory"),
  directory: z.string().optional(),
  ttlMs: z.number().optional(),
});

const MemoryConfigSchema = z.object({
  enabled: z.boolean().optional().default(true),
  directory: z.string().optional(),
  embeddingModel: z.string().optional(),
  embeddingProvider: z.string().optional(),
});

const SkillsConfigSchema = z.object({
  enabled: z.boolean().optional().default(true),
  userDir: z.string().optional(),
  workspaceDir: z.string().optional(),
  disabled: z.array(z.string()).optional(),
  only: z.array(z.string()).optional(),
});

const SkillLearnerConfigSchema = z.object({
  enabled: z.boolean().optional().default(true),
  autoTriggerKeywords: z.array(z.string()).optional().default([
    "记住这个", "保存为skill", "学习一下", "记下来", "记住", "保存技能", "学一下", "learn this",
  ]),
  maxLearningTurns: z.number().optional().default(20),
  enableAutoLearn: z.boolean().optional().default(true),
  enableProactiveSuggest: z.boolean().optional().default(true),
  proactiveThreshold: z.number().optional().default(3),
  autoDeployToSkills: z.boolean().optional().default(true),
});

const ShareLinkConfigSchema = z.object({
  enabled: z.boolean().optional().default(true),
  responseMode: z.enum(["simple", "detailed"]).optional().default("detailed"),
  includeDescription: z.boolean().optional().default(true),
  includeCover: z.boolean().optional().default(true),
  descriptionMaxLength: z.number().int().positive().optional().default(120),
  bilibiliCookie: z.object({
    sessdata: z.string().optional(),
    biliJct: z.string().optional(),
  }).optional().default({}),
  summarizeProviderId: z.string().optional(),
  sttProviderId: z.string().optional(),
  audioDownloadTimeout: z.number().int().positive().optional().default(300_000),
  subtitleMaxLength: z.number().int().positive().optional().default(5000),
  llmShortContentThreshold: z.number().int().positive().optional().default(2000),
  llmChunkSize: z.number().int().positive().optional().default(6000),
  autoDetect: z.boolean().optional().default(false),
});

const WeatherConfigSchema = z.object({
  weather_provider: z.enum(["wttr", "caiyun"]).optional().default("wttr"),
  caiyun_api_key: z.string().optional(),
  caiyun_api_version: z.enum(["v2.6", "v3"]).optional().default("v2.6"),
  wttr_base_url: z.string().optional().default("https://wttr.in"),
  default_location: z.string().optional(),
  request_timeout_ms: z.number().int().positive().optional().default(10000),
  cache_ttl_ms: z.number().int().nonnegative().optional().default(600000),
});

const PersonaConfigSchema = z.object({
  enabled: z.boolean().optional().default(true),
}).passthrough();

const VexConfigSchema = z.object({
  providers: z.record(ProviderConfigSchema).optional().default({}),
  channels: z.object({
    weixin: WeixinConfigSchema.optional(),
  }).optional().default({}),
  agent: AgentConfigSchema.optional().default({}),
  server: ServerConfigSchema.optional().default({}),
  logging: LoggingConfigSchema.optional().default({}),
  sessions: SessionStoreConfigSchema.optional(),
  memory: MemoryConfigSchema.optional(),
  skills: SkillsConfigSchema.optional(),
  skillLearner: SkillLearnerConfigSchema.optional(),
  sharelink: ShareLinkConfigSchema.optional(),
  persona: PersonaConfigSchema.optional(),
  weather: WeatherConfigSchema.optional(),
});

// ============== Configuration Loading ==============

/** Load config from a file */
function loadConfigFromFile(configPath: string): Partial<VexConfig> {
  if (!configPath.endsWith(".yaml")) {
    throw new Error(`Unsupported config file format: ${configPath}. Use config.local.yaml.`);
  }

  if (!existsSync(configPath)) {
    return {};
  }

  const content = readFileSync(configPath, "utf-8");
  const parsed = yaml.parse(content) as unknown;
  if (parsed === null) {
    return {};
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid config file format: ${configPath}. Top-level YAML value must be an object.`);
  }
  return parsed as Partial<VexConfig>;
}

/**
 * One-level deep merge: later config files shallow-merge fields of the same
 * top-level key, so local config can override shared config.
 */
function mergeConfigs(...configs: Partial<VexConfig>[]): Partial<VexConfig> {
  const result: Partial<VexConfig> = {};

  for (const config of configs) {
    if (config.providers) {
      result.providers = { ...result.providers, ...config.providers };
    }

    if (config.channels) {
      const c = config.channels;
      const r = result.channels;
      result.channels = {
        weixin: c.weixin != null ? { ...r?.weixin, ...c.weixin } : r?.weixin,
      };
    }

    if (config.agent) {
      result.agent = { ...result.agent, ...config.agent };
    }
    if (config.server) {
      result.server = { ...result.server, ...config.server };
    }
    if (config.logging) {
      result.logging = { ...result.logging, ...config.logging };
    }
    if (config.sessions) {
      result.sessions = { ...result.sessions, ...config.sessions };
    }
    if (config.memory) {
      result.memory = { ...result.memory, ...config.memory };
    }
    if (config.skills) {
      result.skills = { ...result.skills, ...config.skills };
    }
    if (config.skillLearner) {
      result.skillLearner = { ...result.skillLearner, ...config.skillLearner };
    }
    if (config.sharelink) {
      result.sharelink = { ...result.sharelink, ...config.sharelink };
    }
    if (config.persona) {
      result.persona = { ...result.persona, ...config.persona };
    }
    if (config.weather) {
      result.weather = { ...result.weather, ...config.weather };
    }
  }

  return result;
}

/** Load configuration */
export function loadConfig(options?: { configPath?: string; configDir?: string; cwd?: string }): VexConfig {
  const vexDir = options?.configDir ?? join(homedir(), ".vex");
  const cwd = options?.cwd ?? process.cwd();
  const defaultUserConfigPath = join(vexDir, "config.local.yaml");
  const explicitConfigPath = options?.configPath ? resolve(options.configPath) : undefined;
  const configPaths = explicitConfigPath !== undefined
    ? [explicitConfigPath]
    : [
        join(cwd, "config.local.yaml"),
        defaultUserConfigPath,
      ];

  let fileConfig: Partial<VexConfig> = {};
  const loadedConfigPaths: string[] = [];
  for (const configPath of configPaths) {
    const config = loadConfigFromFile(configPath);
    if (Object.keys(config).length > 0) {
      fileConfig = mergeConfigs(fileConfig, config);
      loadedConfigPaths.push(configPath);
      logger.debug({ configPath, topLevelKeys: Object.keys(config) }, "Config file loaded");
    } else {
      logger.debug({ configPath }, "Config file skipped");
    }
  }

  const merged = fileConfig;
  logger.debug(
    {
      loadedConfigPaths,
      mergedTopLevelKeys: Object.keys(merged),
      providerIds: Object.keys(merged.providers ?? {}),
      hasWeixin: Boolean(merged.channels?.weixin),
      sharelinkEnabled: merged.sharelink?.enabled,
      skillLearnerEnabled: merged.skillLearner?.enabled,
      personaEnabled: merged.persona?.enabled,
    },
    "Config merged"
  );

  const result = VexConfigSchema.safeParse(merged);
  if (!result.success) {
    logger.error({ issues: result.error.issues }, "Config validation failed");
    throw new Error(`Invalid configuration: ${result.error.message}`);
  }
  const configWritePath = explicitConfigPath ?? loadedConfigPaths.at(-1) ?? defaultUserConfigPath;
  Object.defineProperty(result.data, RUNTIME_CONFIG_PATH_KEY, {
    value: configWritePath,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  logger.info(
    {
      loadedConfigPaths,
      configWritePath,
      providerIds: Object.keys(result.data.providers),
      defaultProvider: result.data.agent.defaultProvider,
      defaultModel: result.data.agent.defaultModel,
      server: result.data.server,
      channels: Object.keys(result.data.channels),
      extensions: {
        sharelink: result.data.sharelink?.enabled !== false,
        skillLearner: result.data.skillLearner?.enabled !== false,
        persona: result.data.persona?.enabled !== false,
      },
    },
    "Config loaded"
  );

  return result.data as VexConfig;
}

export function getConfigWritePath(config: VexConfig): string {
  return config.__configPath ?? join(homedir(), ".vex", "config.local.yaml");
}

/** Validate required configuration */
export function validateRequiredConfig(config: VexConfig, options?: { webOnly?: boolean }): string[] {
  const errors: string[] = [];

  // Check that at least one provider is configured
  const hasProvider = Object.values(config.providers).some((p) => p?.apiKey);
  if (!hasProvider) {
    errors.push("At least one model provider must be configured with an API key");
  }

  // Check that at least one channel is configured (webOnly mode allows WebChat only)
  if (!options?.webOnly) {
const hasChannel = config.channels.weixin;
if (!hasChannel) {
  errors.push("Weixin (Personal WeChat) channel must be configured. Use --web-only to run with WebChat only.");
    }
  }

  return errors;
}

export { VexConfigSchema };
