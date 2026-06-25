/**
 * Configuration loading and management
 */

import { z } from "zod";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import json5 from "json5";
import yaml from "yaml";
import type { VexConfig, ProviderId } from "../types/index.js";
import { getEnvVar } from "../utils/index.js";

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
  defaultProvider: z.enum([
    "deepseek", "minimax", "kimi", "stepfun", "modelscope", "dashscope", "zhipu",
    "openai", "ollama", "openrouter", "together", "groq",
    "custom-openai", "custom-anthropic"
  ]).default("deepseek"),
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
});

// ============== Configuration Loading ==============

/** Load config from a file */
function loadConfigFromFile(configPath: string): Partial<VexConfig> {
  if (!existsSync(configPath)) {
    return {};
  }

  const content = readFileSync(configPath, "utf-8");

  if (configPath.endsWith(".json") || configPath.endsWith(".json5")) {
    return json5.parse(content);
  } else if (configPath.endsWith(".yaml") || configPath.endsWith(".yml")) {
    return yaml.parse(content);
  }

  return {};
}

/** Load config from environment variables */
function loadConfigFromEnv(): Partial<VexConfig> {
  const config: Partial<VexConfig> = {
    providers: {},
    channels: {},
  };

  // Model providers
  const providers: VexConfig["providers"] = {};

  const deepseekKey = getEnvVar("DEEPSEEK_API_KEY");
  if (deepseekKey) {
    providers.deepseek = { apiKey: deepseekKey };
  }

  const minimaxKey = getEnvVar("MINIMAX_API_KEY");
  if (minimaxKey) {
    providers.minimax = { apiKey: minimaxKey };
  }

  const kimiKey = getEnvVar("KIMI_API_KEY");
  if (kimiKey) {
    providers.kimi = { apiKey: kimiKey };
  }

  const stepfunKey = getEnvVar("STEPFUN_API_KEY");
  if (stepfunKey) {
    providers.stepfun = { apiKey: stepfunKey };
  }

  // ModelScope (supports MODELSCOPE_API_KEY)
  const modelscopeKey = getEnvVar("MODELSCOPE_API_KEY");
  if (modelscopeKey) {
    providers.modelscope = { apiKey: modelscopeKey };
  }

  // DashScope (Alibaba Cloud Model Studio)
  const dashscopeKey = getEnvVar("DASHSCOPE_API_KEY");
  if (dashscopeKey) {
    providers.dashscope = { apiKey: dashscopeKey };
  }

  // Zhipu AI
  const zhipuKey = getEnvVar("ZHIPU_API_KEY");
  if (zhipuKey) {
    providers.zhipu = { apiKey: zhipuKey };
  }

  // OpenAI
  const openaiKey = getEnvVar("OPENAI_API_KEY");
  if (openaiKey) {
    providers.openai = {
      apiKey: openaiKey,
      baseUrl: getEnvVar("OPENAI_BASE_URL"),
    };
  }

  // Ollama
  const ollamaBaseUrl = getEnvVar("OLLAMA_BASE_URL");
  const ollamaModels = getEnvVar("OLLAMA_MODELS");
  if (ollamaBaseUrl || ollamaModels) {
    providers.ollama = {
      baseUrl: ollamaBaseUrl,
      models: ollamaModels?.split(",").map((m) => m.trim()),
    } as unknown as { apiKey?: string };
  }

  // OpenRouter
  const openrouterKey = getEnvVar("OPENROUTER_API_KEY");
  if (openrouterKey) {
    providers.openrouter = { apiKey: openrouterKey };
  }

  // Together AI
  const togetherKey = getEnvVar("TOGETHER_API_KEY");
  if (togetherKey) {
    providers.together = { apiKey: togetherKey };
  }

  // Groq
  const groqKey = getEnvVar("GROQ_API_KEY");
  if (groqKey) {
    providers.groq = { apiKey: groqKey };
  }

  config.providers = providers;

  // Personal WeChat (iLink OC) config
  const weixinToken = getEnvVar("WEIXIN_OC_TOKEN");
  const weixinAccountId = getEnvVar("WEIXIN_OC_ACCOUNT_ID");
  const weixinBaseUrl = getEnvVar("WEIXIN_OC_BASE_URL");
  if (weixinToken || weixinAccountId || weixinBaseUrl) {
    config.channels = {
      ...config.channels,
      weixin: {
        token: weixinToken,
        accountId: weixinAccountId,
        baseUrl: weixinBaseUrl,
      },
    };
  }

  // Server config
  const port = getEnvVar("PORT");
  if (port) {
    config.server = { port: parseInt(port, 10) };
  }

  // Logging config
  const logLevel = getEnvVar("LOG_LEVEL");
  if (logLevel && ["debug", "info", "warn", "error"].includes(logLevel)) {
    config.logging = { level: logLevel as "debug" | "info" | "warn" | "error" };
  }

  return config;
}

/**
 * One-level deep merge: for each top-level key, shallow-merge objects
 * (later config's fields of the same name override earlier ones),
 * making it easy to layer multiple environment configs.
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
  }

  return result;
}

/** Load configuration */
export function loadConfig(options?: { configPath?: string; configDir?: string; cwd?: string }): VexConfig {
  const vexDir = options?.configDir ?? join(homedir(), ".vex");
  const cwd = options?.cwd ?? process.cwd();
  const configPaths = options?.configPath
    ? [options.configPath]
    : [
        join(cwd, "config.yml"),
        join(cwd, "config.yaml"),
        join(cwd, "config.json"),
        join(cwd, "config.json5"),
        join(cwd, "config.local.json"),
        join(cwd, "config.local.json5"),
        join(vexDir, "config.yml"),
        join(vexDir, "config.yaml"),
        join(vexDir, "config.json"),
        join(vexDir, "config.json5"),
        join(vexDir, "config.local.json"),
        join(vexDir, "config.local.json5"),
      ];

  let fileConfig: Partial<VexConfig> = {};
  for (const configPath of configPaths) {
    const config = loadConfigFromFile(configPath);
    if (Object.keys(config).length > 0) {
      fileConfig = mergeConfigs(fileConfig, config);
    }
  }

  // Load from environment variables
  const envConfig = loadConfigFromEnv();

  // Merge configs (environment variables take higher priority)
  const merged = mergeConfigs(fileConfig, envConfig);

  // Validate configuration
  const result = VexConfigSchema.safeParse(merged);
  if (!result.success) {
    throw new Error(`Invalid configuration: ${result.error.message}`);
  }

  return result.data as VexConfig;
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
