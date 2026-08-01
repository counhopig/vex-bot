/**
 * CLI `check` command — print a human-readable config summary + validation.
 */

import {
  CHINA_PROVIDER_IDS,
  OVERSEAS_PROVIDER_IDS,
  getProviderMeta,
} from "../providers/ProviderMetadata.js";
import { loadConfig, validateRequiredConfig } from "./config.js";

/** Print the config check report to stdout. */
export function checkConfig(options?: { configPath?: string }): void {
  console.log("Checking configuration...\n");

  const config = loadConfig({ configPath: options?.configPath });

  // Providers
  console.log("Model providers:");
  const providers = (config.providers ?? {}) as Record<string, Record<string, unknown>>;
  for (const id of CHINA_PROVIDER_IDS) {
    const providerConfig = providers[id];
    const status = providerConfig && typeof providerConfig.apiKey === "string" && providerConfig.apiKey
      ? "Configured"
      : "Not configured";
    console.log(`   ${id}: ${status}`);
  }
  for (const id of OVERSEAS_PROVIDER_IDS) {
    const providerConfig = providers[id];
    if (providerConfig) {
      const meta = getProviderMeta(id);
      const status = (typeof providerConfig.apiKey === "string" && providerConfig.apiKey) || meta?.requiresApiKey === false
        ? "Configured"
        : "Not configured";
      console.log(`   ${id}: ${status}`);
    }
  }
  for (const id of ["custom-openai", "custom-anthropic"] as const) {
    const c = providers[id];
    if (c) {
      const modelCount = Array.isArray(c.models) ? c.models.length : 0;
      const baseUrl = typeof c.baseUrl === "string" ? c.baseUrl : "";
      console.log(`   ${id}: Configured (${baseUrl}, ${modelCount} models)`);
    }
  }

  // Channels
  console.log("\nCommunication channels:");
  const channels = (config.channels ?? {}) as Record<string, Record<string, unknown>>;
  const weixin = channels.weixin;
  console.log(`   Personal WeChat: ${weixin ? "Configured" : "Not configured"}`);

  // Agent
  const agent = (config.agent ?? {}) as Record<string, unknown>;
  console.log("\nAgent configuration:");
  console.log(`   Default model: ${agent.defaultModel ?? ""}`);
  console.log(`   Default provider: ${agent.defaultProvider ?? ""}`);
  console.log(`   Temperature: ${agent.temperature ?? ""}`);
  console.log(`   Max tokens: ${agent.maxTokens ?? ""}`);

  // Server
  const server = (config.server ?? {}) as Record<string, unknown>;
  console.log("\nServer configuration:");
  console.log(`   Port: ${server.port ?? ""}`);
  console.log(`   Host: ${server.host ?? "0.0.0.0"}`);

  // Validation
  const errors = validateRequiredConfig(config);
  if (errors.length > 0) {
    console.log("\nConfiguration issues:");
    errors.forEach((err) => console.log(`   - ${err}`));
  } else {
    console.log("\nConfiguration check passed!");
  }
}
