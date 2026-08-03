/**
 * Config routes — the control panel's config read/validate/save endpoints.
 *
 * Ported from _archive/src/web/config-handlers.ts to the new architecture:
 *  - `saveConfig` takes an explicit `configPath` instead of reading the
 *    archive's `__configPath` non-enumerable hack (rewrite-plan: fold the
 *    hack into an explicit field at the call site).
 *  - `buildUserEffectiveConfig` is superseded by ConfigStore.resolve and is
 *    intentionally NOT ported here — the merge logic lives in config/.
 *  - The config object is `SystemConfig` (EffectiveConfig-shaped plus the
 *    channel/weather/sharelink/skillLearner/sessions sections the control
 *    panel serializes).
 *
 * Security behaviors preserved:
 *  - API keys / cookies / weather keys are never serialized into ConfigInfo.
 *  - rawYaml patches are schema-validated BEFORE touching disk or the live
 *    config object, so a malformed patch cannot brick a running instance.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import yaml from "yaml";
import { VexConfigSchema } from "../../config/schema.js";
import { getProviderName, PROVIDER_IDS } from "../../providers/ProviderMetadata.js";
import { getChildLogger } from "../../utils/logger.js";
import type {
  ConfigInfo,
  ConfigSaveParams,
  ConfigValidateResult,
} from "../types.js";
import type { PublicWebUser, UserConfigSettings } from "./auth.js";

const logger = getChildLogger("config-handlers");

/**
 * The system-level config the control panel reads and edits. Mirrors the
 * archive's VexConfig shape (all sections the panel serializes), with
 * optional channel/weather/sharelink/skillLearner/sessions sections that
 * EffectiveConfig does not carry.
 */
export interface SystemConfig {
  providers?: Record<string, Record<string, unknown>>;
  channels?: Record<string, Record<string, unknown>>;
  agent?: Record<string, unknown>;
  server?: Record<string, unknown>;
  logging?: Record<string, unknown>;
  memory?: Record<string, unknown>;
  skills?: Record<string, unknown>;
  persona?: Record<string, unknown>;
  skillLearner?: Record<string, unknown>;
  sharelink?: Record<string, unknown>;
  weather?: Record<string, unknown>;
  sessions?: Record<string, unknown>;
  webAuth?: Record<string, unknown>;
  [key: string]: unknown;
}

export function getConfigInfo(config: SystemConfig): ConfigInfo {
  // Provider info (API key redacted)
  const providers: Record<string, ConfigInfo["providers"][string]> = {};
  for (const [id, providerConfig] of Object.entries(config.providers ?? {})) {
    const cfg = providerConfig as Record<string, unknown>;
    providers[id] = {
      id,
      name: typeof cfg.name === "string" && cfg.name ? cfg.name : getProviderName(id),
      baseUrl: typeof cfg.baseUrl === "string" ? cfg.baseUrl : undefined,
      hasApiKey: Boolean(cfg.apiKey),
      groupId: typeof cfg.groupId === "string" ? cfg.groupId : undefined,
    };
  }

  // Channel info (redact sensitive fields)
  const channels: Record<string, ConfigInfo["channels"][string]> = {};
  const channelNames: Record<string, string> = {
    weixin: "Personal WeChat",
  };
  for (const [id, channelConfig] of Object.entries(config.channels ?? {})) {
    if (channelConfig) {
      const wc = channelConfig as Record<string, unknown>;
      const hasConfig = id === "weixin" && Boolean(wc.token || wc.accountId);
      const channelInfo: ConfigInfo["channels"][string] = {
        id,
        name: channelNames[id] || id,
        hasConfig,
        enabled: hasConfig && (wc.enabled !== false),
      };
      if (id === "weixin") {
        const cc = channelInfo as unknown as Record<string, unknown>;
        cc.accountId = typeof wc.accountId === "string" ? wc.accountId : undefined;
        cc.botType = typeof wc.botType === "string" ? wc.botType : undefined;
        cc.baseUrl = typeof wc.baseUrl === "string" ? wc.baseUrl : undefined;
        cc.hasToken = Boolean(wc.token);
      }
      channels[id] = channelInfo;
    }
  }

  // Agent configuration
  const agent = {
    defaultProvider: String(config.agent?.defaultProvider ?? ""),
    defaultModel: String(config.agent?.defaultModel ?? ""),
    temperature: typeof config.agent?.temperature === "number" ? config.agent.temperature : undefined,
    maxTokens: typeof config.agent?.maxTokens === "number" ? config.agent.maxTokens : undefined,
    systemPrompt: typeof config.agent?.systemPrompt === "string" ? config.agent.systemPrompt : undefined,
  };

  // Server configuration
  const server = {
    port: typeof config.server?.port === "number" ? config.server.port : 3000,
    host: typeof config.server?.host === "string" && config.server.host ? config.server.host : "127.0.0.1",
  };

  // Logging configuration
  const logging = {
    level: (config.logging?.level as ConfigInfo["logging"]["level"]) ?? "info",
  };

  // Memory system configuration. Embedding model/provider are deliberately
  // not exposed: the runtime always uses the local SimpleEmbedding (Part 5
  // of the runtime-config integration plan — no saveable-but-inert fields).
  const memory = config.memory
    ? {
        enabled: typeof config.memory.enabled === "boolean" ? config.memory.enabled : undefined,
        directory: typeof config.memory.directory === "string" ? config.memory.directory : undefined,
      }
    : undefined;

  // Skills configuration
  const skills = config.skills
    ? {
        enabled: typeof config.skills.enabled === "boolean" ? config.skills.enabled : undefined,
        userDir: typeof config.skills.userDir === "string" ? config.skills.userDir : undefined,
        workspaceDir: typeof config.skills.workspaceDir === "string" ? config.skills.workspaceDir : undefined,
        disabled: Array.isArray(config.skills.disabled) ? config.skills.disabled : undefined,
        only: Array.isArray(config.skills.only) ? config.skills.only : undefined,
      }
    : undefined;

  // Persona configuration (pass-through mirror)
  const persona = config.persona ? { ...config.persona } : undefined;

  // Skill Learner configuration
  const skillLearner = config.skillLearner ? { ...config.skillLearner } : undefined;

  // ShareLink configuration (redact bilibili cookie values)
  let sharelink: ConfigInfo["sharelink"];
  if (config.sharelink) {
    const sl = config.sharelink;
    const hasBilibiliCookie = Boolean(
      (sl.bilibiliCookie as { sessdata?: string; biliJct?: string } | undefined)
        ?.sessdata || (sl.bilibiliCookie as { sessdata?: string; biliJct?: string } | undefined)?.biliJct,
    );
    sharelink = {
      enabled: typeof sl.enabled === "boolean" ? sl.enabled : undefined,
      responseMode: sl.responseMode as "simple" | "detailed" | undefined,
      includeDescription: typeof sl.includeDescription === "boolean" ? sl.includeDescription : undefined,
      includeCover: typeof sl.includeCover === "boolean" ? sl.includeCover : undefined,
      descriptionMaxLength: typeof sl.descriptionMaxLength === "number" ? sl.descriptionMaxLength : undefined,
      hasBilibiliCookie,
      summarizeProviderId: typeof sl.summarizeProviderId === "string" ? sl.summarizeProviderId : undefined,
      sttProviderId: typeof sl.sttProviderId === "string" ? sl.sttProviderId : undefined,
      audioDownloadTimeout: typeof sl.audioDownloadTimeout === "number" ? sl.audioDownloadTimeout : undefined,
      subtitleMaxLength: typeof sl.subtitleMaxLength === "number" ? sl.subtitleMaxLength : undefined,
      llmShortContentThreshold: typeof sl.llmShortContentThreshold === "number" ? sl.llmShortContentThreshold : undefined,
      llmChunkSize: typeof sl.llmChunkSize === "number" ? sl.llmChunkSize : undefined,
      autoDetect: typeof sl.autoDetect === "boolean" ? sl.autoDetect : undefined,
    };
  }

  // Sessions store configuration
  const sessions = config.sessions ? { ...config.sessions } : undefined;

  // Weather configuration (redact Caiyun API key value)
  const weather = config.weather
    ? {
        weather_provider: config.weather.weather_provider as "wttr" | "caiyun" | undefined,
        caiyun_api_version: config.weather.caiyun_api_version as "v2.6" | "v3" | undefined,
        wttr_base_url: typeof config.weather.wttr_base_url === "string" ? config.weather.wttr_base_url : undefined,
        default_location: typeof config.weather.default_location === "string" ? config.weather.default_location : undefined,
        request_timeout_ms: typeof config.weather.request_timeout_ms === "number" ? config.weather.request_timeout_ms : undefined,
        cache_ttl_ms: typeof config.weather.cache_ttl_ms === "number" ? config.weather.cache_ttl_ms : undefined,
        hasCaiyunApiKey: Boolean(config.weather.caiyun_api_key),
      }
    : undefined;

  return {
    providers,
    channels,
    agent,
    server,
    logging,
    memory: memory as ConfigInfo["memory"],
    skills: skills as ConfigInfo["skills"],
    persona,
    skillLearner,
    sharelink,
    weather,
    sessions,
  };
}

export function getUserConfigInfo(
  config: SystemConfig,
  settings: UserConfigSettings,
  user?: PublicWebUser | null,
): ConfigInfo {
  const info = getConfigInfo(buildUserEffectiveConfig(config, settings));
  if (!user?.hasWeixin) return info;

  const current = info.channels.weixin;
  return {
    ...info,
    channels: {
      ...info.channels,
      weixin: {
        id: "weixin",
        name: current?.name ?? "Personal WeChat",
        hasConfig: true,
        enabled: true,
        baseUrl: current?.baseUrl ?? (config.channels?.weixin as Record<string, unknown> | undefined)?.baseUrl as string | undefined,
        botType: current?.botType ?? (config.channels?.weixin as Record<string, unknown> | undefined)?.botType as string | undefined,
        accountId: user.weixinAccountId ?? current?.accountId,
        hasToken: true,
      },
    },
  };
}

/** Overlay user-owned settings on top of the system config (display view only;
 *  runtime resolution is ConfigStore.resolve's job). */
function buildUserEffectiveConfig(config: SystemConfig, settings: UserConfigSettings): SystemConfig {
  return {
    ...config,
    agent: settings.agent
      ? { ...config.agent, ...settings.agent }
      : config.agent,
    memory: settings.memory ? { ...(config.memory ?? {}), ...settings.memory } : config.memory,
    persona: settings.persona ? { ...(config.persona ?? {}), ...settings.persona } : config.persona,
    skillLearner: settings.skillLearner ? { ...(config.skillLearner ?? {}), ...settings.skillLearner } : config.skillLearner,
    sharelink: settings.sharelink
      ? mergeSharelinkForEffectiveConfig(config.sharelink, settings.sharelink)
      : config.sharelink,
    weather: settings.weather ? { ...(config.weather ?? {}), ...settings.weather } : config.weather,
    sessions: config.sessions,
  };
}

function mergeSharelinkForEffectiveConfig(
  globalSharelink: SystemConfig["sharelink"],
  userSharelink: UserConfigSettings["sharelink"],
): SystemConfig["sharelink"] {
  if (!userSharelink) return globalSharelink;
  return {
    ...globalSharelink,
    ...userSharelink,
    bilibiliCookie: userSharelink.bilibiliCookie
      ? {
          ...(globalSharelink?.bilibiliCookie as Record<string, unknown> | undefined),
          ...userSharelink.bilibiliCookie,
        }
      : globalSharelink?.bilibiliCookie,
  };
}

export function extractUserConfigSettings(params: ConfigSaveParams): UserConfigSettings {
  const pick = (
    value: unknown,
    keys: readonly string[],
  ): Record<string, unknown> | undefined => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      if (source[key] !== undefined) result[key] = source[key];
    }
    return Object.keys(result).length > 0 ? result : undefined;
  };

  // This is an authorization boundary, not just a type conversion. Values
  // such as workingDirectory, bashEnvPassthrough and storage directories are
  // system-owned even if a client crafts them into the websocket payload.
  const agent = pick(params.agent, [
    "defaultProvider", "defaultModel", "temperature", "maxTokens", "systemPrompt",
  ]);
  const memory = pick(params.memory, ["enabled"]);
  const persona = pick(params.persona, [
    "enabled", "persona_name", "relationship", "personality", "speaking_style",
    "background", "user_nickname", "user_background", "preferences",
  ]);
  const skillLearner = pick(params.skillLearner, [
    "enabled", "autoTriggerKeywords", "maxLearningTurns", "enableAutoLearn",
    "enableProactiveSuggest", "proactiveThreshold", "autoDeployToSkills",
  ]);
  const sharelink = pick(params.sharelink, [
    "enabled", "autoDetect", "responseMode", "llmShortContentThreshold",
    "llmChunkSize", "bilibiliCookie",
  ]);
  const weather = pick(params.weather, [
    "weather_provider", "caiyun_api_key", "caiyun_api_version", "default_location",
    "wttr_base_url", "request_timeout_ms", "cache_ttl_ms",
  ]);
  return {
    ...(agent ? { agent } : {}),
    ...(memory ? { memory } : {}),
    ...(persona ? { persona } : {}),
    ...(skillLearner ? { skillLearner } : {}),
    ...(sharelink ? { sharelink } : {}),
    ...(weather ? { weather } : {}),
  };
}

export function extractSystemConfigParams(params: ConfigSaveParams): ConfigSaveParams {
  return {
    ...(params.providers ? { providers: params.providers } : {}),
    ...(params.channels ? { channels: params.channels } : {}),
    ...(params.server ? { server: params.server } : {}),
    ...(params.logging ? { logging: params.logging } : {}),
    ...(params.skills ? { skills: params.skills } : {}),
    ...(params.rawYaml ? { rawYaml: params.rawYaml } : {}),
  };
}

export function validateConfig(params: ConfigSaveParams): ConfigValidateResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Validate providers
  if (params.providers) {
    let hasApiKey = false;
    for (const [id, p] of Object.entries(params.providers)) {
      if (p.hasApiKey) {
        hasApiKey = true;
      }
      // Validate custom OpenAI/Anthropic need baseUrl
      if (p.hasApiKey && (id === "custom-openai" || id === "custom-anthropic")) {
        if (!p.baseUrl) {
          errors.push(`${id} requires baseUrl configuration`);
        }
      }
    }
    if (!hasApiKey && Object.keys(params.providers).length > 0) {
      warnings.push("No API Key configured, model functions will be unavailable");
    }
  }

  // Validate Agent configuration
  if (params.agent) {
    if (params.agent.defaultProvider && !PROVIDER_IDS.includes(params.agent.defaultProvider)) {
      errors.push(`Invalid provider: ${params.agent.defaultProvider}`);
    }
    if (params.agent.temperature !== undefined && (params.agent.temperature < 0 || params.agent.temperature > 2)) {
      errors.push("temperature must be between 0 and 2");
    }
    if (params.agent.maxTokens !== undefined && params.agent.maxTokens < 1) {
      errors.push("maxTokens must be greater than 0");
    }
  }

  // Validate server configuration
  if (params.server) {
    if (params.server.port < 1 || params.server.port > 65535) {
      errors.push("Port must be between 1 and 65535");
    }
  }

  // Validate logging configuration
  if (params.logging) {
    const validLevels = ["debug", "info", "warn", "error"];
    if (params.logging.level && !validLevels.includes(params.logging.level)) {
      errors.push(`Invalid log level: ${params.logging.level}`);
    }
  }

  // Validate Persona configuration
  if (params.persona) {
    const p = params.persona;
    if (p.emotion_decay_per_hour !== undefined && (p.emotion_decay_per_hour < 0 || p.emotion_decay_per_hour > 100)) {
      errors.push("persona.emotion_decay_per_hour must be between 0 and 100");
    }
    if (p.emotion_recovery_per_reply !== undefined && (p.emotion_recovery_per_reply < 0 || p.emotion_recovery_per_reply > 100)) {
      errors.push("persona.emotion_recovery_per_reply must be between 0 and 100");
    }
    if (p.memory_max_turns !== undefined && p.memory_max_turns < 0) {
      errors.push("persona.memory_max_turns must be >= 0");
    }
    if (p.reflection_trigger_turns !== undefined && p.reflection_trigger_turns < 0) {
      errors.push("persona.reflection_trigger_turns must be >= 0");
    }
    if (p.reflection_history_turns !== undefined && p.reflection_history_turns < 0) {
      errors.push("persona.reflection_history_turns must be >= 0");
    }
    if (p.profile_building_trigger_turns !== undefined && p.profile_building_trigger_turns < 0) {
      errors.push("persona.profile_building_trigger_turns must be >= 0");
    }
    if (p.rest_sleep_hour !== undefined && (p.rest_sleep_hour < 0 || p.rest_sleep_hour > 23)) {
      errors.push("persona.rest_sleep_hour must be between 0 and 23");
    }
    if (p.rest_wake_hour !== undefined && (p.rest_wake_hour < 0 || p.rest_wake_hour > 23)) {
      errors.push("persona.rest_wake_hour must be between 0 and 23");
    }
    if (p.storage_cache_max !== undefined && p.storage_cache_max < 0) {
      errors.push("persona.storage_cache_max must be >= 0");
    }
  }

  // Validate Skill Learner configuration
  if (params.skillLearner) {
    const sl = params.skillLearner;
    if (sl.maxLearningTurns !== undefined && sl.maxLearningTurns < 0) {
      errors.push("skillLearner.maxLearningTurns must be >= 0");
    }
    if (sl.proactiveThreshold !== undefined && (sl.proactiveThreshold < 0 || sl.proactiveThreshold > 1)) {
      errors.push("skillLearner.proactiveThreshold must be between 0 and 1");
    }
  }

  // Validate ShareLink configuration
  if (params.sharelink) {
    const sl = params.sharelink;
    if (sl.responseMode !== undefined && !["simple", "detailed"].includes(sl.responseMode)) {
      errors.push(`sharelink.responseMode must be 'simple' or 'detailed', got: ${sl.responseMode}`);
    }
    if (sl.descriptionMaxLength !== undefined && sl.descriptionMaxLength < 0) {
      errors.push("sharelink.descriptionMaxLength must be >= 0");
    }
    if (sl.audioDownloadTimeout !== undefined && sl.audioDownloadTimeout < 0) {
      errors.push("sharelink.audioDownloadTimeout must be >= 0");
    }
    if (sl.subtitleMaxLength !== undefined && sl.subtitleMaxLength < 0) {
      errors.push("sharelink.subtitleMaxLength must be >= 0");
    }
    if (sl.llmShortContentThreshold !== undefined && sl.llmShortContentThreshold < 0) {
      errors.push("sharelink.llmShortContentThreshold must be >= 0");
    }
    if (sl.llmChunkSize !== undefined && sl.llmChunkSize < 0) {
      errors.push("sharelink.llmChunkSize must be >= 0");
    }
  }

  // Validate Sessions configuration
  if (params.sessions) {
    if (params.sessions.type !== undefined && !["memory", "file"].includes(params.sessions.type)) {
      errors.push(`sessions.type must be 'memory' or 'file', got: ${params.sessions.type}`);
    }
    if (params.sessions.ttlMs !== undefined && params.sessions.ttlMs < 0) {
      errors.push("sessions.ttlMs must be >= 0");
    }
  }

  // Validate Weather configuration
  if (params.weather) {
    const weather = params.weather;
    if (weather.weather_provider !== undefined && !["wttr", "caiyun"].includes(weather.weather_provider)) {
      errors.push(`weather.weather_provider must be 'wttr' or 'caiyun', got: ${weather.weather_provider}`);
    }
    if (weather.caiyun_api_version !== undefined && !["v2.6", "v3"].includes(weather.caiyun_api_version)) {
      errors.push(`weather.caiyun_api_version must be 'v2.6' or 'v3', got: ${weather.caiyun_api_version}`);
    }
    if (weather.request_timeout_ms !== undefined && weather.request_timeout_ms <= 0) {
      errors.push("weather.request_timeout_ms must be > 0");
    }
    if (weather.cache_ttl_ms !== undefined && weather.cache_ttl_ms < 0) {
      errors.push("weather.cache_ttl_ms must be >= 0");
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Merge, serialize, and write config.local.yaml to the given configPath.
 *
 * @param configPath - Where to write (the archive's __configPath hack is
 *                     replaced by this explicit parameter).
 * @param currentConfig - the live SystemConfig (needed for restart heuristics).
 * @param params - the validated save payload from the frontend.
 */
export function saveConfig(
  configPath: string,
  currentConfig: SystemConfig,
  params: ConfigSaveParams,
): { success: boolean; message: string; requiresRestart?: boolean } {
  const vexDir = dirname(configPath);

  // Validate config
  const validation = validateConfig(params);
  if (!validation.valid) {
    return {
      success: false,
      message: "Config validation failed: " + validation.errors.join("; "),
    };
  }

  // Read existing config first, then merge
  let existingConfig: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      existingConfig = (yaml.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown> | null) ?? {};
    } catch (e) {
      logger.warn({ error: e }, "Failed to parse existing config, creating new");
    }
  }

  // Build config to save
  const configToSave: Record<string, unknown> = { ...existingConfig };

  // Update providers
  if (params.providers) {
    const providers: Record<string, unknown> = {};
    if (existingConfig.providers) {
      for (const [id, p] of Object.entries(existingConfig.providers as Record<string, unknown>)) {
        if (id && p) {
          providers[id] = p;
        }
      }
    }
    for (const [id, p] of Object.entries(params.providers)) {
      if (!id || !p.hasApiKey) {
        delete providers[id];
        continue;
      }
      const existing = (existingConfig.providers as Record<string, unknown> | undefined)?.[id];
      const pRecord = p as unknown as Record<string, unknown>;
      providers[id] = {
        ...((existing as Record<string, unknown>) ?? {}),
        baseUrl: p.baseUrl,
        ...(p.groupId ? { groupId: p.groupId } : {}),
      };
      // Prioritize frontend-sent apiKey (for new providers), otherwise keep existing
      const apiKey = typeof pRecord.apiKey === "string" ? pRecord.apiKey
        : (typeof existing === "object" && existing ? (existing as Record<string, unknown>).apiKey : undefined);
      if (typeof apiKey === "string") {
        (providers[id] as Record<string, unknown>).apiKey = apiKey;
      }
    }
    configToSave.providers = providers;
  }

  // Update channels
  if (params.channels) {
    const channels: Record<string, unknown> = {};
    const existingChannels = (existingConfig.channels as Record<string, unknown>) ?? {};
    if (existingChannels.weixin) {
      channels.weixin = existingChannels.weixin;
    }

    for (const [id, c] of Object.entries(params.channels)) {
      const cRecord = c as unknown as Record<string, unknown>;
      if (!c.hasConfig) {
        delete channels[id];
        continue;
      }
      const existing = existingChannels[id];
      const channelValue: Record<string, unknown> = {
        ...(typeof existing === "object" && existing ? (existing as Record<string, unknown>) : {}),
        enabled: c.enabled,
      };
      if (typeof cRecord.botType === "string") {
        channelValue.botType = cRecord.botType;
      }
      if (typeof cRecord.baseUrl === "string") {
        channelValue.baseUrl = cRecord.baseUrl;
      }
      if (typeof cRecord.accountId === "string") {
        channelValue.accountId = cRecord.accountId;
      }
      channels[id] = channelValue;
    }
    configToSave.channels = channels;
  }

  // Update Agent configuration
  if (params.agent) {
    configToSave.agent = {
      ...(existingConfig.agent as Record<string, unknown> | undefined),
      ...params.agent,
      defaultProvider:
        params.agent.defaultProvider ||
        ((existingConfig.agent as Record<string, unknown> | undefined)?.defaultProvider as string | undefined) ||
        "deepseek",
    };
  }

  // Update server configuration
  if (params.server) {
    configToSave.server = {
      ...(existingConfig.server as Record<string, unknown> | undefined),
      ...params.server,
    };
  }

  // Update logging configuration
  if (params.logging) {
    configToSave.logging = {
      ...(existingConfig.logging as Record<string, unknown> | undefined),
      ...params.logging,
    };
  }

  // Update memory system configuration
  if (params.memory) {
    configToSave.memory = {
      ...(existingConfig.memory as Record<string, unknown> | undefined),
      ...params.memory,
    };
  }

  // Update Skills configuration
  if (params.skills) {
    configToSave.skills = {
      ...(existingConfig.skills as Record<string, unknown> | undefined),
      ...params.skills,
    };
  }

  // Update Persona configuration
  if (params.persona) {
    configToSave.persona = {
      ...(existingConfig.persona as Record<string, unknown> | undefined),
      ...params.persona,
    };
  }

  // Update Skill Learner configuration
  if (params.skillLearner) {
    configToSave.skillLearner = {
      ...(existingConfig.skillLearner as Record<string, unknown> | undefined),
      ...params.skillLearner,
    };
  }

  // Update ShareLink configuration
  if (params.sharelink) {
    const existingSharelink = (existingConfig.sharelink ?? {}) as Record<string, unknown>;
    const incoming = params.sharelink as unknown as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...existingSharelink };
    for (const [k, v] of Object.entries(incoming)) {
      if (k === "bilibiliCookie") {
        // Only overwrite cookie when the user actually sent values
        const incomingCookie = v as { sessdata?: string; biliJct?: string } | undefined;
        if (incomingCookie && (incomingCookie.sessdata || incomingCookie.biliJct)) {
          merged.bilibiliCookie = {
            ...((existingSharelink.bilibiliCookie as Record<string, unknown> | undefined) ?? {}),
            ...incomingCookie,
          };
        }
      } else if (k !== "hasBilibiliCookie" && v !== undefined) {
        merged[k] = v;
      }
    }
    configToSave.sharelink = merged;
  }

  // Update Sessions store configuration
  if (params.sessions) {
    configToSave.sessions = {
      ...(existingConfig.sessions as Record<string, unknown> | undefined),
      ...params.sessions,
    };
  }

  // Update Weather configuration
  if (params.weather) {
    const existingWeather = (existingConfig.weather ?? {}) as Record<string, unknown>;
    const incoming = params.weather as unknown as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...existingWeather };
    for (const [k, v] of Object.entries(incoming)) {
      if (k === "hasCaiyunApiKey") {
        continue;
      }
      if (k === "caiyun_api_key") {
        if (typeof v === "string" && v.trim()) {
          merged.caiyun_api_key = v.trim();
        }
      } else if (v !== undefined) {
        merged[k] = v;
      }
    }
    configToSave.weather = merged;
  }

  if (params.rawYaml && params.rawYaml.trim()) {
    let patch: unknown;
    try {
      patch = yaml.parse(params.rawYaml);
    } catch (e) {
      return {
        success: false,
        message: "Raw YAML parse error: " + (e instanceof Error ? e.message : String(e)),
      };
    }
    if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
      return {
        success: false,
        message: "Raw YAML must be an object at the top level",
      };
    }
    const patchRecord = patch as Record<string, unknown>;
    for (const [k, v] of Object.entries(patchRecord)) {
      if (v === undefined) continue;
      configToSave[k] = v;
    }
  }

  // rawYaml bypasses the hand-rolled validateConfig above (which only knows the
  // redacted form shape), so schema-check the fully assembled config before
  // touching disk or the live object — a malformed patch must not brick a
  // running instance or persist corruption.
  const schemaCheck = VexConfigSchema.safeParse(configToSave);
  if (!schemaCheck.success) {
    return {
      success: false,
      message:
        "Config validation failed: " +
        schemaCheck.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
    };
  }

  // Capture the running port before the merge below overwrites it, so the
  // restart heuristic compares against what's actually loaded, not the new value.
  const previousPort = typeof currentConfig.server?.port === "number" ? currentConfig.server.port : 3000;

  // Ensure directory exists
  if (!existsSync(vexDir)) {
    mkdirSync(vexDir, { recursive: true });
  }

  const yamlContent = yaml.stringify(configToSave);
  writeFileSync(configPath, yamlContent, "utf-8");
  // Mirror the merged result into the live config object so the panel reflects
  // the save immediately without a reload.
  Object.assign(currentConfig, configToSave);

  logger.info({ configPath }, "Configuration saved");

  // Check if restart required
  let requiresRestart = false;
  if (params.server?.port && params.server.port !== previousPort) {
    requiresRestart = true;
  }
  if (params.channels) {
    const existingChannels = (existingConfig.channels as Record<string, unknown>) ?? {};
    for (const [id, c] of Object.entries(params.channels)) {
      const existingHasConfig = Boolean(existingChannels[id]);
      if (c.hasConfig !== existingHasConfig) {
        requiresRestart = true;
        break;
      }
    }
  }
  if (params.sessions?.type && params.sessions.type !== (existingConfig.sessions as Record<string, unknown> | undefined)?.type) {
    requiresRestart = true;
  }

  return {
    success: true,
    message: "Configuration saved" + (requiresRestart ? ", restart required for changes to take effect" : ""),
    requiresRestart,
  };
}
