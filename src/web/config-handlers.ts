/**
 * Config-related handlers extracted from WsServer.
 *
 * getConfigInfo, validateConfig, and saveConfig operate on a VexConfig
 * value directly (no class instance needed) so they can be shared with
 * the CLI onboard wizard and tested without a running WebSocket server.
 */

import { homedir } from "os";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import json5 from "json5";
import { toJson5 } from "../config/json5-writer.js";
import { getProviderName, PROVIDER_IDS } from "../providers/metadata.js";
import { getChildLogger } from "../utils/logger.js";
import type { VexConfig, ProviderId, WeixinConfig, SimpleProviderConfig } from "../types/index.js";
import type { ConfigInfo, ConfigSaveParams, ConfigValidateResult } from "./types.js";

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
    host: config.server.host || "0.0.0.0",
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

  return {
    providers,
    channels,
    agent,
    server,
    logging,
    memory: memory as ConfigInfo["memory"],
    skills: skills as ConfigInfo["skills"],
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

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Merge, serialize, and write config.local.json5.
 *
 * @param currentConfig - the live VexConfig (needed for restart heuristics).
 * @param params - the validated save payload from the frontend.
 * @returns success status + restart hint.
 */
export function saveConfig(
  currentConfig: VexConfig,
  params: ConfigSaveParams,
): { success: boolean; message: string; requiresRestart?: boolean } {
  const vexDir = join(homedir(), ".vex");
  const configPath = join(vexDir, "config.local.json5");

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
      existingConfig = json5.parse(readFileSync(configPath, "utf-8"));
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

  // Ensure directory exists
  if (!existsSync(vexDir)) {
    mkdirSync(vexDir, { recursive: true });
  }

  // Generate JSON5 format
  const json5Content = toJson5(configToSave);

  // Write file
  writeFileSync(configPath, json5Content, "utf-8");

  logger.info({ configPath }, "Configuration saved");

  // Check if restart required
  let requiresRestart = false;
  if (params.server?.port && params.server.port !== currentConfig.server.port) {
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

  return {
    success: true,
    message: "Configuration saved" + (requiresRestart ? ", restart required for changes to take effect" : ""),
    requiresRestart,
  };
}
