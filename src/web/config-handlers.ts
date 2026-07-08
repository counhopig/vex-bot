/**
 * Config-related handlers extracted from WsServer.
 *
 * getConfigInfo, validateConfig, and saveConfig operate on a VexConfig
 * value directly (no class instance needed) so they can be shared with
 * the CLI onboard wizard and tested without a running WebSocket server.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import yaml from "yaml";
import { getConfigWritePath, VexConfigSchema } from "../config/index.js";
import { getProviderName, PROVIDER_IDS } from "../providers/metadata.js";
import { getChildLogger } from "../utils/logger.js";
import type { VexConfig, ProviderId, WeixinConfig, SimpleProviderConfig } from "../types/index.js";
import type { ConfigInfo, ConfigSaveParams, ConfigValidateResult } from "./types.js";
import type { PublicWebUser, UserConfigSettings } from "./auth.js";

const logger = getChildLogger("config-handlers");

export function getConfigInfo(config: VexConfig): ConfigInfo {
  // Provider info (API key redacted)
  const providers: Record<string, ConfigInfo["providers"][string]> = {};
  for (const [id, providerConfig] of Object.entries(config.providers)) {
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
  for (const [id, channelConfig] of Object.entries(config.channels)) {
    if (channelConfig) {
      const wc = channelConfig as WeixinConfig;
      const hasConfig = id === "weixin" && Boolean(wc.token || wc.accountId);
      const channelInfo: ConfigInfo["channels"][string] = {
        id,
        name: channelNames[id] || id,
        hasConfig,
        enabled: hasConfig && (wc.enabled ?? true),
      };
      if (id === "weixin") {
        const cc = channelInfo as unknown as Record<string, unknown>;
        cc.accountId = wc.accountId;
        cc.botType = wc.botType;
        cc.baseUrl = wc.baseUrl;
        cc.hasToken = Boolean(wc.token);
      }
      channels[id] = channelInfo;
    }
  }

  // Agent configuration
  const agent = {
    defaultProvider: config.agent.defaultProvider,
    defaultModel: config.agent.defaultModel,
    temperature: config.agent.temperature,
    maxTokens: config.agent.maxTokens,
    systemPrompt: config.agent.systemPrompt,
  };

  // Server configuration
  const server = {
    port: config.server.port,
    host: config.server.host || "127.0.0.1",
  };

  // Logging configuration
  const logging = {
    level: config.logging.level,
  };

  // Memory system configuration
  const memory = {
    enabled: config.memory?.enabled,
    directory: config.memory?.directory,
    embeddingModel: config.memory?.embeddingModel,
    embeddingProvider: config.memory?.embeddingProvider,
  };

  // Skills configuration
  const skills = {
    enabled: config.skills?.enabled,
    userDir: config.skills?.userDir,
    workspaceDir: config.skills?.workspaceDir,
    disabled: config.skills?.disabled,
    only: config.skills?.only,
  };

  // Persona configuration (pass-through mirror of PersonaConfig)
  const persona = config.persona ? { ...config.persona } : undefined;

  // Skill Learner configuration
  const skillLearner = config.skillLearner ? { ...config.skillLearner } : undefined;

  // ShareLink configuration (redact bilibili cookie values, expose hasBilibiliCookie flag)
  let sharelink: ConfigInfo["sharelink"];
  if (config.sharelink) {
    const sl = config.sharelink;
    const hasBilibiliCookie = Boolean(
      sl.bilibiliCookie && (sl.bilibiliCookie.sessdata || sl.bilibiliCookie.biliJct),
    );
    sharelink = {
      enabled: sl.enabled,
      responseMode: sl.responseMode,
      includeDescription: sl.includeDescription,
      includeCover: sl.includeCover,
      descriptionMaxLength: sl.descriptionMaxLength,
      hasBilibiliCookie,
      summarizeProviderId: sl.summarizeProviderId,
      sttProviderId: sl.sttProviderId,
      audioDownloadTimeout: sl.audioDownloadTimeout,
      subtitleMaxLength: sl.subtitleMaxLength,
      llmShortContentThreshold: sl.llmShortContentThreshold,
      llmChunkSize: sl.llmChunkSize,
      autoDetect: sl.autoDetect,
    };
  }

  // Sessions store configuration
  const sessions = config.sessions ? { ...config.sessions } : undefined;

  // Weather configuration (redact Caiyun API key value)
  const weather = config.weather ? {
    weather_provider: config.weather.weather_provider,
    caiyun_api_version: config.weather.caiyun_api_version,
    wttr_base_url: config.weather.wttr_base_url,
    default_location: config.weather.default_location,
    request_timeout_ms: config.weather.request_timeout_ms,
    cache_ttl_ms: config.weather.cache_ttl_ms,
    hasCaiyunApiKey: Boolean(config.weather.caiyun_api_key),
  } : undefined;

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
  config: VexConfig,
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
        baseUrl: current?.baseUrl ?? config.channels.weixin?.baseUrl,
        botType: current?.botType ?? config.channels.weixin?.botType,
        accountId: user.weixinAccountId ?? current?.accountId,
        hasToken: true,
      },
    },
  };
}

export function buildUserEffectiveConfig(config: VexConfig, settings: UserConfigSettings): VexConfig {
  return {
    ...config,
    agent: settings.agent
      ? {
          ...config.agent,
          ...settings.agent,
          defaultProvider: settings.agent.defaultProvider as ProviderId,
        }
      : config.agent,
    memory: settings.memory
      ? {
          ...config.memory,
          ...settings.memory,
          embeddingProvider: settings.memory.embeddingProvider as ProviderId | undefined,
        }
      : config.memory,
    persona: settings.persona ? { ...config.persona, ...settings.persona } : config.persona,
    skillLearner: settings.skillLearner ? { ...config.skillLearner, ...settings.skillLearner } : config.skillLearner,
    sharelink: settings.sharelink ? mergeSharelinkForEffectiveConfig(config.sharelink, settings.sharelink) : config.sharelink,
    weather: settings.weather ? { ...config.weather, ...settings.weather } : config.weather,
    sessions: settings.sessions
      ? {
          ...config.sessions,
          ...settings.sessions,
          type: settings.sessions.type ?? config.sessions?.type ?? "file",
        }
      : config.sessions,
  };
}

export function extractUserConfigSettings(params: ConfigSaveParams): UserConfigSettings {
  return {
    ...(params.agent ? { agent: params.agent } : {}),
    ...(params.memory ? { memory: params.memory } : {}),
    ...(params.persona ? { persona: params.persona } : {}),
    ...(params.skillLearner ? { skillLearner: params.skillLearner } : {}),
    ...(params.sharelink ? { sharelink: params.sharelink } : {}),
    ...(params.weather ? { weather: params.weather } : {}),
    ...(params.sessions ? { sessions: params.sessions } : {}),
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

function mergeSharelinkForEffectiveConfig(
  globalSharelink: VexConfig["sharelink"],
  userSharelink: UserConfigSettings["sharelink"],
): VexConfig["sharelink"] {
  if (!userSharelink) return globalSharelink;
  return {
    ...globalSharelink,
    ...userSharelink,
    bilibiliCookie: userSharelink.bilibiliCookie
      ? {
          ...globalSharelink?.bilibiliCookie,
          ...userSharelink.bilibiliCookie,
        }
      : globalSharelink?.bilibiliCookie,
    summarizeProviderId: userSharelink.summarizeProviderId as ProviderId | undefined,
    sttProviderId: userSharelink.sttProviderId as ProviderId | undefined,
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

  // Validate channels
  if (params.channels) {
    for (const [id, c] of Object.entries(params.channels)) {
      if (c.hasConfig) {
        if (id === "weixin" && !c.hasConfig) {
          errors.push("Personal WeChat requires QR scan login");
        }
      }
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
 * Merge, serialize, and write config.local.yaml.
 *
 * @param currentConfig - the live VexConfig (needed for restart heuristics).
 * @param params - the validated save payload from the frontend.
 * @returns success status + restart hint.
 */
export function saveConfig(
  currentConfig: VexConfig,
  params: ConfigSaveParams,
): { success: boolean; message: string; requiresRestart?: boolean } {
  const configPath = getConfigWritePath(currentConfig);
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
  let existingConfig: Partial<VexConfig> = {};
  if (existsSync(configPath)) {
    try {
      existingConfig = yaml.parse(readFileSync(configPath, "utf-8")) as Partial<VexConfig>;
    } catch (e) {
      logger.warn({ error: e }, "Failed to parse existing config, creating new");
    }
  }

  // Build config to save
  const configToSave: Partial<VexConfig> = { ...existingConfig };

  // Update providers
  if (params.providers) {
    const providers: VexConfig["providers"] = {};
    // Keep existing unmodified providers
    if (existingConfig.providers) {
      for (const [id, p] of Object.entries(existingConfig.providers)) {
        if (id && p) {
          providers[id] = p;
        }
      }
    }
    // Update/add new providers
    for (const [id, p] of Object.entries(params.providers)) {
      if (!id || !p.hasApiKey) {
        // Remove provider
        delete providers[id];
        continue;
      }
      // Get apiKey from existing config
      const existing = existingConfig.providers?.[id];
      const pRecord = p as unknown as Record<string, unknown>;
      providers[id] = {
        ...(existing as Record<string, unknown>),
        baseUrl: p.baseUrl,
        ...(p.groupId ? { groupId: p.groupId } : {}),
      } as SimpleProviderConfig;
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
    if (existingConfig.channels?.weixin) {
      channels.weixin = existingConfig.channels.weixin;
    }

    for (const [id, c] of Object.entries(params.channels)) {
      const cRecord = c as unknown as Record<string, unknown>;
      if (!c.hasConfig) {
        delete channels[id];
        continue;
      }
      const existing = existingConfig.channels
        ? (existingConfig.channels as Record<string, unknown>)[id]
        : undefined;
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
    configToSave.channels = channels as VexConfig["channels"];
  }

  // Update Agent configuration
  if (params.agent) {
    configToSave.agent = {
      ...existingConfig.agent,
      ...params.agent,
      defaultProvider: (params.agent.defaultProvider as ProviderId) || (existingConfig.agent?.defaultProvider ?? "deepseek"),
    };
  }

  // Update server configuration
  if (params.server) {
    configToSave.server = {
      ...existingConfig.server,
      ...params.server,
    };
  }

  // Update logging configuration
  if (params.logging) {
    configToSave.logging = {
      ...existingConfig.logging,
      ...params.logging,
    };
  }

  // Update memory system configuration
  if (params.memory) {
    configToSave.memory = {
      ...existingConfig.memory,
      ...params.memory,
      embeddingProvider: params.memory.embeddingProvider as ProviderId | undefined,
    };
  }

  // Update Skills configuration
  if (params.skills) {
    configToSave.skills = {
      ...existingConfig.skills,
      ...params.skills,
    };
  }

  // Update Persona configuration
  if (params.persona) {
    configToSave.persona = {
      ...existingConfig.persona,
      ...params.persona,
    };
  }

  // Update Skill Learner configuration
  if (params.skillLearner) {
    configToSave.skillLearner = {
      ...existingConfig.skillLearner,
      ...params.skillLearner,
    };
  }

  // Update ShareLink configuration
  if (params.sharelink) {
    const existingSharelink = (existingConfig.sharelink ?? {}) as Record<string, unknown>;
    const incoming = params.sharelink as Record<string, unknown>;
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
    configToSave.sharelink = merged as VexConfig["sharelink"];
  }

  // Update Sessions store configuration
  if (params.sessions) {
    const mergedSessions = {
      ...existingConfig.sessions,
      ...params.sessions,
    };
    configToSave.sessions = mergedSessions as VexConfig["sessions"];
  }

  // Update Weather configuration
  if (params.weather) {
    const existingWeather = (existingConfig.weather ?? {}) as Record<string, unknown>;
    const incoming = params.weather as Record<string, unknown>;
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
    configToSave.weather = merged as VexConfig["weather"];
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
      (configToSave as Record<string, unknown>)[k] = v;
    }
  }

  // rawYaml bypasses the hand-rolled validateConfig above (which only knows the
  // redacted form shape), so schema-check the fully assembled config before
  // touching disk or the live object — a malformed patch must not brick a
  // running instance or persist corruption. Validate only; keep writing the
  // assembled object so intentional unknown keys survive.
  const schemaCheck = VexConfigSchema.safeParse(configToSave);
  if (!schemaCheck.success) {
    return {
      success: false,
      message:
        "Config validation failed: " +
        schemaCheck.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
    };
  }

  // Capture the running port before Object.assign overwrites it below, so the
  // restart heuristic compares against what's actually loaded, not the new value.
  const previousPort = currentConfig.server.port;

  // Ensure directory exists
  if (!existsSync(vexDir)) {
    mkdirSync(vexDir, { recursive: true });
  }

  const yamlContent = yaml.stringify(configToSave);
  writeFileSync(configPath, yamlContent, "utf-8");
  Object.assign(currentConfig, configToSave);

  logger.info({ configPath }, "Configuration saved");

  // Check if restart required
  let requiresRestart = false;
  if (params.server?.port && params.server.port !== previousPort) {
    requiresRestart = true;
  }
  if (params.channels) {
    // If channels added or removed, restart required
    for (const [id, c] of Object.entries(params.channels)) {
      const existingHasConfig = Boolean(
        existingConfig.channels ? (existingConfig.channels as Record<string, unknown>)[id] : false,
      );
      if (c.hasConfig !== existingHasConfig) {
        requiresRestart = true;
        break;
      }
    }
  }
  if (params.sessions?.type && params.sessions.type !== existingConfig.sessions?.type) {
    requiresRestart = true;
  }

  return {
    success: true,
    message: "Configuration saved" + (requiresRestart ? ", restart required for changes to take effect" : ""),
    requiresRestart,
  };
}
