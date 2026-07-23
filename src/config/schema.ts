/**
 * Zod schemas for Vex configuration validation.
 *
 * Ported from the archive's config/index.ts. Used by the YAML loader to
 * validate parsed config before merging. Does NOT define EffectiveConfig —
 * that is a separate type in EffectiveConfig.ts with runtime resolution
 * logic instead of Zod-derived inference.
 */

import { z } from "zod";

const ProviderConfigSchema = z
  .object({
    baseUrl: z.string().optional(),
    apiKey: z.string().optional(),
    headers: z.record(z.string()).optional(),
  })
  .passthrough();

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

const PersonaConfigSchema = z.object({}).passthrough();

const WebAuthConfigSchema = z.object({
  enabled: z.boolean().optional().default(true),
  database: z.string().optional(),
});

export const VexConfigSchema = z.object({
  providers: z.record(ProviderConfigSchema).optional().default({}),
  agent: AgentConfigSchema.optional().default({}),
  server: ServerConfigSchema.optional().default({}),
  logging: LoggingConfigSchema.optional().default({}),
  memory: MemoryConfigSchema.optional(),
  skills: SkillsConfigSchema.optional(),
  persona: PersonaConfigSchema.optional(),
  webAuth: WebAuthConfigSchema.optional().default({}),
});
