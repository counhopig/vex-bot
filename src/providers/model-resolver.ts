/**
 * Model Resolver - maps vex config to pi-ai Model objects
 */

import type { Model, Api, Provider } from "@mariozechner/pi-ai";
import { getModel } from "@mariozechner/pi-ai";
import type { ProviderId, SimpleProviderConfig, VexConfig, ModelDefinition } from "../types/index.js";
import { getChildLogger } from "../utils/logger.js";

const logger = getChildLogger("model-resolver");

/** Resolved model info */
export interface ResolvedModel {
  model: Model<Api>;
  providerId: ProviderId;
}

/** Model registry */
const modelRegistry = new Map<string, ResolvedModel>();

/** Provider config cache */
let providerConfigs: Record<string, SimpleProviderConfig> = {};

/** Chinese provider default baseUrl mapping */
const CHINA_PROVIDER_BASE_URLS: Record<string, string> = {
  deepseek: "https://api.deepseek.com/v1",
  kimi: "https://api.moonshot.cn/v1",
  stepfun: "https://api.stepfun.com/v1",
  doubao: "https://ark.cn-beijing.volces.com/api/v3",
  minimax: "https://api.minimaxi.com/anthropic",
  modelscope: "https://api-inference.modelscope.cn/v1",
  dashscope: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  zhipu: "https://open.bigmodel.cn/api/paas/v4",
  longcat: "https://api.longcat.chat/openai/v1",
};

/** Chinese provider default model definitions */
const CHINA_PROVIDER_MODELS: Record<string, ModelDefinition[]> = {
  deepseek: [
    { id: "deepseek-chat", name: "DeepSeek Chat", provider: "deepseek", api: "openai-compatible", contextWindow: 64000, maxTokens: 8192, supportsVision: false, supportsReasoning: false },
    { id: "deepseek-reasoner", name: "DeepSeek Reasoner (R1)", provider: "deepseek", api: "openai-compatible", contextWindow: 64000, maxTokens: 8192, supportsVision: false, supportsReasoning: true },
  ],
  doubao: [
    { id: "doubao-seed-1-8-251228", name: "Doubao Seed 1.8", provider: "doubao", api: "openai-compatible", contextWindow: 262144, maxTokens: 32768, supportsVision: true, supportsReasoning: true },
    { id: "doubao-seed-1-6-lite-251015", name: "Doubao Seed 1.6 Lite", provider: "doubao", api: "openai-compatible", contextWindow: 262144, maxTokens: 32768, supportsVision: true, supportsReasoning: true },
    { id: "doubao-seed-1-6-flash-250828", name: "Doubao Seed 1.6 Flash", provider: "doubao", api: "openai-compatible", contextWindow: 262144, maxTokens: 32768, supportsVision: true, supportsReasoning: true },
  ],
  kimi: [
    { id: "kimi-k2.5", name: "Kimi K2.5", provider: "kimi", api: "openai-compatible", contextWindow: 128000, maxTokens: 65536, supportsVision: true, supportsReasoning: true },
    { id: "kimi-latest", name: "Kimi Latest", provider: "kimi", api: "openai-compatible", contextWindow: 128000, maxTokens: 65536, supportsVision: true, supportsReasoning: false },
    { id: "moonshot-v1-128k", name: "Moonshot V1 128K", provider: "kimi", api: "openai-compatible", contextWindow: 128000, maxTokens: 65536, supportsVision: false, supportsReasoning: false },
  ],
  stepfun: [
    { id: "step-2-mini", name: "Step 2 Mini", provider: "stepfun", api: "openai-compatible", contextWindow: 32000, maxTokens: 8192, supportsVision: false, supportsReasoning: true },
    { id: "step-1-128k", name: "Step 1 128K", provider: "stepfun", api: "openai-compatible", contextWindow: 128000, maxTokens: 65536, supportsVision: false, supportsReasoning: false },
  ],
  minimax: [
    { id: "MiniMax-M3", name: "MiniMax M3", provider: "minimax", api: "anthropic", contextWindow: 1000000, maxTokens: 65536, supportsVision: true, supportsReasoning: true },
    { id: "MiniMax-M2.5", name: "MiniMax M2.5", provider: "minimax", api: "anthropic", contextWindow: 1000000, maxTokens: 65536, supportsVision: false, supportsReasoning: true },
    { id: "MiniMax-M2.1", name: "MiniMax M2.1", provider: "minimax", api: "anthropic", contextWindow: 1000000, maxTokens: 65536, supportsVision: false, supportsReasoning: true },
  ],
  modelscope: [
    { id: "Qwen/Qwen2.5-72B-Instruct", name: "Qwen 2.5 72B", provider: "modelscope", api: "openai-compatible", contextWindow: 131072, maxTokens: 8192, supportsVision: false, supportsReasoning: false },
    { id: "deepseek-ai/DeepSeek-R1", name: "DeepSeek R1 (ModelScope)", provider: "modelscope", api: "openai-compatible", contextWindow: 65536, maxTokens: 8192, supportsVision: false, supportsReasoning: true },
    { id: "deepseek-ai/DeepSeek-V3", name: "DeepSeek V3 (ModelScope)", provider: "modelscope", api: "openai-compatible", contextWindow: 65536, maxTokens: 8192, supportsVision: false, supportsReasoning: false },
  ],
  dashscope: [
    { id: "qwen3-235b-a22b", name: "Qwen3 235B (MoE)", provider: "dashscope", api: "openai-compatible", contextWindow: 131072, maxTokens: 8192, supportsVision: false, supportsReasoning: true },
    { id: "qwen3-32b", name: "Qwen3 32B", provider: "dashscope", api: "openai-compatible", contextWindow: 131072, maxTokens: 8192, supportsVision: false, supportsReasoning: true },
    { id: "qwen-max", name: "Qwen Max", provider: "dashscope", api: "openai-compatible", contextWindow: 32768, maxTokens: 8192, supportsVision: false, supportsReasoning: false },
    { id: "qwen-plus", name: "Qwen Plus", provider: "dashscope", api: "openai-compatible", contextWindow: 131072, maxTokens: 8192, supportsVision: false, supportsReasoning: false },
    { id: "qwq-plus", name: "QwQ Plus", provider: "dashscope", api: "openai-compatible", contextWindow: 131072, maxTokens: 16384, supportsVision: false, supportsReasoning: true },
    { id: "deepseek-r1", name: "DeepSeek R1 (DashScope)", provider: "dashscope", api: "openai-compatible", contextWindow: 65536, maxTokens: 8192, supportsVision: false, supportsReasoning: true },
  ],
  zhipu: [
    { id: "glm-z1-plus", name: "GLM-Z1 Plus", provider: "zhipu", api: "openai-compatible", contextWindow: 128000, maxTokens: 8192, supportsVision: false, supportsReasoning: true },
    { id: "glm-z1-flash", name: "GLM-Z1 Flash (Free)", provider: "zhipu", api: "openai-compatible", contextWindow: 128000, maxTokens: 8192, supportsVision: false, supportsReasoning: true },
    { id: "glm-4.7", name: "GLM-4.7", provider: "zhipu", api: "openai-compatible", contextWindow: 128000, maxTokens: 8192, supportsVision: false, supportsReasoning: false },
    { id: "glm-4-plus", name: "GLM-4 Plus", provider: "zhipu", api: "openai-compatible", contextWindow: 128000, maxTokens: 4096, supportsVision: false, supportsReasoning: false },
    { id: "glm-4-flash", name: "GLM-4 Flash (Free)", provider: "zhipu", api: "openai-compatible", contextWindow: 128000, maxTokens: 4096, supportsVision: false, supportsReasoning: false },
    { id: "glm-4v-plus", name: "GLM-4V Plus", provider: "zhipu", api: "openai-compatible", contextWindow: 8192, maxTokens: 1024, supportsVision: true, supportsReasoning: false },
  ],
  longcat: [
    { id: "LongCat-2.0", name: "LongCat 2.0", provider: "longcat", api: "openai-compatible", contextWindow: 1000000, maxTokens: 131072, supportsVision: false, supportsReasoning: true },
  ],
};

/** Preset provider configs (not built into pi-ai but commonly used) */
const PRESET_PROVIDER_CONFIGS: Record<string, { baseUrl: string; headers?: Record<string, string> }> = {
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    headers: { "HTTP-Referer": "https://github.com/King-Chau/vex", "X-Title": "Vex" },
  },
  together: { baseUrl: "https://api.together.xyz/v1" },
  groq: { baseUrl: "https://api.groq.com/openai/v1" },
  ollama: { baseUrl: "http://localhost:11434/v1" },
  vllm: { baseUrl: "http://localhost:8000/v1" },
};

/** pi-ai known provider mapping */
const PI_AI_KNOWN_PROVIDERS: Record<string, string> = {
  openai: "openai",
  anthropic: "anthropic",
  groq: "groq",
  openrouter: "openrouter",
};

/** Get API key for a provider */
export function getApiKeyForProvider(providerId: string): string | undefined {
  const config = providerConfigs[providerId];
  return config?.apiKey;
}

/** Build an OpenAI-compatible Model object */
function buildOpenAIModel(
  modelId: string,
  modelDef: ModelDefinition,
  baseUrl: string,
  provider: string,
  headers?: Record<string, string>,
): Model<"openai-completions"> {
  return {
    id: modelId,
    name: modelDef.name,
    api: "openai-completions",
    provider: provider as Provider,
    baseUrl,
    reasoning: modelDef.supportsReasoning,
    input: modelDef.supportsVision ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: modelDef.contextWindow,
    maxTokens: modelDef.maxTokens,
    headers,
  };
}

/** Build an Anthropic-compatible Model object */
function buildAnthropicModel(
  modelId: string,
  modelDef: ModelDefinition,
  baseUrl: string,
  provider: string,
  apiVersion?: string,
  headers?: Record<string, string>,
): Model<"anthropic-messages"> {
  return {
    id: modelId,
    name: modelDef.name,
    api: "anthropic-messages",
    provider: provider as Provider,
    baseUrl,
    reasoning: modelDef.supportsReasoning,
    input: modelDef.supportsVision ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: modelDef.contextWindow,
    maxTokens: modelDef.maxTokens,
    headers: {
      "anthropic-version": apiVersion ?? "2023-06-01",
      ...headers,
    },
  };
}

/** Register all models for a Chinese provider */
function registerChinaProvider(
  providerId: string,
  config: SimpleProviderConfig,
): void {
  const defaultBaseUrl = CHINA_PROVIDER_BASE_URLS[providerId];
  if (!defaultBaseUrl) return;

  const baseUrl = config.baseUrl ?? defaultBaseUrl;
  const models = CHINA_PROVIDER_MODELS[providerId];
  if (!models) return;

  for (const modelDef of models) {
    const model = modelDef.api === "anthropic"
      ? buildAnthropicModel(modelDef.id, modelDef, baseUrl, providerId, undefined, config.headers)
      : buildOpenAIModel(modelDef.id, modelDef, baseUrl, providerId, config.headers);
    modelRegistry.set(`${providerId}:${modelDef.id}`, { model, providerId: providerId as ProviderId });
  }

  logger.debug({ providerId, modelCount: models.length }, "China provider registered");
}

/** Register preset providers (openrouter, together, groq, ollama, vllm) */
function registerPresetProvider(
  providerId: string,
  config: SimpleProviderConfig,
): void {
  const preset = PRESET_PROVIDER_CONFIGS[providerId];
  if (!preset) return;

  const baseUrl = config.baseUrl ?? preset.baseUrl;
  const headers = { ...preset.headers, ...config.headers };

  // These providers have dynamic models; register a placeholder so resolveModel can create on demand.
  // Do not pre-register specific models; they are handled dynamically by resolveModel.
  logger.debug({ providerId, baseUrl }, "Preset provider registered");
}

/** Register custom OpenAI provider */
function registerCustomOpenAI(config: Record<string, unknown>): void {
  const baseUrl = config.baseUrl as string;
  const models = config.models as Array<{
    id: string;
    name?: string;
    contextWindow?: number;
    maxTokens?: number;
    supportsVision?: boolean;
    supportsReasoning?: boolean;
  }>;
  const headers = config.headers as Record<string, string> | undefined;

  if (!baseUrl || !models) return;

  for (const m of models) {
    const modelDef: ModelDefinition = {
      id: m.id,
      name: m.name ?? m.id,
      provider: "custom-openai",
      api: "openai-compatible",
      contextWindow: m.contextWindow ?? 128000,
      maxTokens: m.maxTokens ?? 4096,
      supportsVision: m.supportsVision ?? false,
      supportsReasoning: m.supportsReasoning ?? false,
    };
    const model = buildOpenAIModel(m.id, modelDef, baseUrl, "custom-openai", headers);
    modelRegistry.set(`custom-openai:${m.id}`, { model, providerId: "custom-openai" });
  }
}

/** Register custom Anthropic provider */
function registerCustomAnthropic(config: Record<string, unknown>): void {
  const baseUrl = config.baseUrl as string;
  const models = config.models as Array<{
    id: string;
    name?: string;
    contextWindow?: number;
    maxTokens?: number;
    supportsVision?: boolean;
  }>;
  const apiVersion = config.apiVersion as string | undefined;
  const headers = config.headers as Record<string, string> | undefined;

  if (!baseUrl || !models) return;

  for (const m of models) {
    const modelDef: ModelDefinition = {
      id: m.id,
      name: m.name ?? m.id,
      provider: "custom-anthropic",
      api: "anthropic",
      contextWindow: m.contextWindow ?? 200000,
      maxTokens: m.maxTokens ?? 8192,
      supportsVision: m.supportsVision ?? false,
      supportsReasoning: false,
    };
    const model = buildAnthropicModel(m.id, modelDef, baseUrl, "custom-anthropic", apiVersion, headers);
    modelRegistry.set(`custom-anthropic:${m.id}`, { model, providerId: "custom-anthropic" });
  }
}

/** Initialize the model resolver */
export function initModelResolver(config: VexConfig): void {
  modelRegistry.clear();
  providerConfigs = config.providers as Record<string, SimpleProviderConfig>;

  const chinaProviders = ["deepseek", "doubao", "kimi", "stepfun", "minimax", "modelscope", "dashscope", "zhipu", "longcat"];

  for (const [id, providerConfig] of Object.entries(providerConfigs)) {
    if (!providerConfig) continue;

    if (chinaProviders.includes(id) && providerConfig.apiKey) {
      registerChinaProvider(id, providerConfig);
    } else if (Object.keys(PRESET_PROVIDER_CONFIGS).includes(id)) {
      registerPresetProvider(id, providerConfig);
    }
  }

  // Custom OpenAI
  const customOpenai = config.providers["custom-openai"];
  if (customOpenai && (customOpenai as Record<string, unknown>).apiKey && (customOpenai as Record<string, unknown>).baseUrl) {
    registerCustomOpenAI(customOpenai as Record<string, unknown>);
  }

  // Custom Anthropic
  const customAnthropic = config.providers["custom-anthropic"];
  if (customAnthropic && (customAnthropic as Record<string, unknown>).apiKey && (customAnthropic as Record<string, unknown>).baseUrl) {
    registerCustomAnthropic(customAnthropic as Record<string, unknown>);
  }

  // OpenAI (pi-ai built-in)
  if (providerConfigs.openai?.apiKey) {
    // pi-ai has built-in OpenAI models, no need to register manually
    logger.debug("OpenAI provider available via pi-ai built-in");
  }

  logger.info({ registeredModels: modelRegistry.size }, "Model resolver initialized");
}

/** Resolve a model */
export function resolveModel(providerId: ProviderId, modelId: string): Model<Api> | undefined {
  // 1. Check local registry first
  const key = `${providerId}:${modelId}`;
  const registered = modelRegistry.get(key);
  if (registered) {
    return registered.model;
  }

  // 2. For pi-ai known providers, try getModel
  const piProvider = PI_AI_KNOWN_PROVIDERS[providerId];
  if (piProvider) {
    try {
      const model = getModel(piProvider as any, modelId as any);
      return model;
    } catch {
      // getModel doesn't recognize this model, continue
    }
  }

  // 3. For preset providers or those with baseUrl, create an OpenAI-compatible model dynamically
  const config = providerConfigs[providerId];
  if (config) {
    const preset = PRESET_PROVIDER_CONFIGS[providerId];
    const chinaBaseUrl = CHINA_PROVIDER_BASE_URLS[providerId];
    const baseUrl = config.baseUrl ?? preset?.baseUrl ?? chinaBaseUrl;

    if (baseUrl) {
      const dynamicDef: ModelDefinition = {
        id: modelId,
        name: modelId,
        provider: providerId,
        api: "openai-compatible",
        contextWindow: 128000,
        maxTokens: 8192,
        supportsVision: false,
        supportsReasoning: false,
      };
      const headers = { ...preset?.headers, ...config.headers };
      const model = buildOpenAIModel(modelId, dynamicDef, baseUrl, providerId, Object.keys(headers).length > 0 ? headers : undefined);

      // Cache dynamically resolved model
      modelRegistry.set(key, { model, providerId });
      logger.debug({ providerId, modelId, baseUrl }, "Dynamic model resolved");
      return model;
    }
  }

  logger.warn({ providerId, modelId }, "Failed to resolve model");
  return undefined;
}

/** Get all registered models */
export function getAllRegisteredModels(): Array<{ provider: ProviderId; modelId: string; model: Model<Api> }> {
  const result: Array<{ provider: ProviderId; modelId: string; model: Model<Api> }> = [];

  for (const [key, resolved] of modelRegistry) {
    const [, modelId] = key.split(":", 2);
    if (modelId) {
      result.push({
        provider: resolved.providerId,
        modelId,
        model: resolved.model,
      });
    }
  }

  return result;
}

/** Check whether a provider is available */
export function isProviderAvailable(providerId: ProviderId): boolean {
  const config = providerConfigs[providerId];
  if (!config) return false;

  // Providers that don't need API keys
  if (providerId === "ollama" || providerId === "vllm") return true;
  return !!config.apiKey;
}
