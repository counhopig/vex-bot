/**
 * Zod schemas for Vex configuration validation.
 *
 * Ported from the archive's config/index.ts. Used by the YAML loader to
 * validate parsed config before merging. Does NOT define EffectiveConfig —
 * that is a separate type in EffectiveConfig.ts with runtime resolution
 * logic instead of Zod-derived inference.
 *
 * Note: the top-level object intentionally declares every config section.
 * Zod strips unknown keys by default — if a section the runtime reads
 * (e.g. `channels.weixin`, `weather`) is omitted here, it is silently
 * dropped during YAML loading and the feature is dead on arrival. The
 * section list below matches the archive's VexConfigSchema exactly.
 */

import { z } from "zod";

const ProviderConfigSchema = z
  .object({
    baseUrl: z.string().optional(),
    apiKey: z.string().optional(),
    headers: z.record(z.string()).optional(),
  })
  .passthrough();

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
  defaultProvider: z.string().default("deepseek"),
  systemPrompt: z.string().optional(),
  temperature: z.number().min(0).max(2).optional().default(0.7),
  maxTokens: z.number().optional().default(4096),
  workingDirectory: z.string().optional(),
  bashEnvPassthrough: z.array(z.string()).optional(),
});

const ServerConfigSchema = z.object({
  port: z.number().default(3000),
  host: z.string().optional().default("127.0.0.1"),
});

const LoggingConfigSchema = z.object({
  level: z.enum(["debug", "info", "warn", "error"]).default("info"),
  pretty: z.boolean().default(true),
});

const SessionStoreConfigSchema = z.object({
  // Only file persistence is implemented. "memory" was a legacy schema value
  // that claimed a mode the runtime never had; it is coerced to "file" at
  // resolution so saved settings can't silently lie about behavior.
  type: z.enum(["memory", "file"]).optional().default("file"),
  directory: z.string().optional(),
  ttlMs: z.number().optional(),
});

const MemoryConfigSchema = z.object({
  enabled: z.boolean().optional().default(true),
  directory: z.string().optional(),
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

const WebAuthConfigSchema = z.object({
  enabled: z.boolean().optional().default(true),
  database: z.string().optional(),
  secureCookies: z.boolean().optional(),
  allowRegistration: z.boolean().optional(),
});

export const VexConfigSchema = z.object({
  providers: z.record(ProviderConfigSchema).optional().default({}),
  channels: z.object({
    weixin: WeixinConfigSchema.optional(),
  }).optional().default({}),
  agent: AgentConfigSchema.optional().default({}),
  server: ServerConfigSchema.optional().default({}),
  logging: LoggingConfigSchema.optional().default({}),
  sessions: SessionStoreConfigSchema.optional(),
  // Default-on when omitted, matching persona/skills/sharelink/webAuth. The
  // gates in server/bootstrap still honour an explicit `enabled: false`.
  memory: MemoryConfigSchema.optional().default({}),
  skills: SkillsConfigSchema.optional(),
  skillLearner: SkillLearnerConfigSchema.optional(),
  sharelink: ShareLinkConfigSchema.optional(),
  persona: PersonaConfigSchema.optional(),
  weather: WeatherConfigSchema.optional(),
  webAuth: WebAuthConfigSchema.optional().default({}),
});
