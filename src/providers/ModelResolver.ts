/**
 * ModelResolver — maps vex config to pi-ai Model objects.
 *
 * Ported from archive's model-resolver.ts. Uses module-level state
 * (like the archived version) since models derive from the single
 * process-wide provider config.
 *
 * Resolution order:
 *   1. China provider model table (pre-registered)
 *   2. pi-ai getModel() (openai, groq, openrouter)
 *   3. Dynamic fallback for any provider with baseUrl
 */

import type { Model, Api } from "@mariozechner/pi-ai";
import { getModel } from "@mariozechner/pi-ai";
import { getChildLogger } from "../utils/logger.js";

const logger = getChildLogger("model-resolver");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResolvedModel {
  model: Model<Api>;
  providerId: string;
}

export interface ModelDefinition {
  id: string;
  name: string;
  provider: string;
  api: "openai-compatible" | "anthropic";
  contextWindow: number;
  maxTokens: number;
  supportsVision: boolean;
  supportsReasoning: boolean;
}

// ---------------------------------------------------------------------------
// Mapping tables
// ---------------------------------------------------------------------------

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

const CHINA_PROVIDER_MODELS: Record<string, ModelDefinition[]> = {
  deepseek: [
    { id: "deepseek-chat", name: "DeepSeek Chat", provider: "deepseek", api: "openai-compatible", contextWindow: 64000, maxTokens: 8192, supportsVision: false, supportsReasoning: false },
    { id: "deepseek-reasoner", name: "DeepSeek Reasoner (R1)", provider: "deepseek", api: "openai-compatible", contextWindow: 64000, maxTokens: 8192, supportsVision: false, supportsReasoning: true },
  ],
  doubao: [
    { id: "doubao-seed-1-8-251228", name: "Doubao Seed 1.8", provider: "doubao", api: "openai-compatible", contextWindow: 262144, maxTokens: 32768, supportsVision: true, supportsReasoning: true },
    { id: "doubao-seed-1-6-lite-251015", name: "Doubao Seed 1.6 Lite", provider: "doubao", api: "openai-compatible", contextWindow: 262144, maxTokens: 32768, supportsVision: true, supportsReasoning: true },
  ],
  kimi: [
    { id: "kimi-k2.5", name: "Kimi K2.5", provider: "kimi", api: "openai-compatible", contextWindow: 128000, maxTokens: 65536, supportsVision: true, supportsReasoning: true },
    { id: "moonshot-v1-128k", name: "Moonshot V1 128K", provider: "kimi", api: "openai-compatible", contextWindow: 128000, maxTokens: 65536, supportsVision: false, supportsReasoning: false },
  ],
  stepfun: [
    { id: "step-2-mini", name: "Step 2 Mini", provider: "stepfun", api: "openai-compatible", contextWindow: 32000, maxTokens: 8192, supportsVision: false, supportsReasoning: true },
  ],
  minimax: [
    { id: "MiniMax-M3", name: "MiniMax M3", provider: "minimax", api: "anthropic", contextWindow: 1000000, maxTokens: 65536, supportsVision: true, supportsReasoning: true },
    { id: "MiniMax-M2.1", name: "MiniMax M2.1", provider: "minimax", api: "anthropic", contextWindow: 1000000, maxTokens: 65536, supportsVision: false, supportsReasoning: true },
  ],
  modelscope: [
    { id: "Qwen/Qwen2.5-72B-Instruct", name: "Qwen 2.5 72B", provider: "modelscope", api: "openai-compatible", contextWindow: 131072, maxTokens: 8192, supportsVision: false, supportsReasoning: false },
    { id: "deepseek-ai/DeepSeek-V3", name: "DeepSeek V3 (ModelScope)", provider: "modelscope", api: "openai-compatible", contextWindow: 65536, maxTokens: 8192, supportsVision: false, supportsReasoning: false },
  ],
  dashscope: [
    { id: "qwen3-235b-a22b", name: "Qwen3 235B (MoE)", provider: "dashscope", api: "openai-compatible", contextWindow: 131072, maxTokens: 8192, supportsVision: false, supportsReasoning: true },
    { id: "qwen-max", name: "Qwen Max", provider: "dashscope", api: "openai-compatible", contextWindow: 32768, maxTokens: 8192, supportsVision: false, supportsReasoning: false },
    { id: "qwen-plus", name: "Qwen Plus", provider: "dashscope", api: "openai-compatible", contextWindow: 131072, maxTokens: 8192, supportsVision: false, supportsReasoning: false },
  ],
  zhipu: [
    { id: "glm-z1-flash", name: "GLM-Z1 Flash (Free)", provider: "zhipu", api: "openai-compatible", contextWindow: 128000, maxTokens: 8192, supportsVision: false, supportsReasoning: true },
    { id: "glm-4-plus", name: "GLM-4 Plus", provider: "zhipu", api: "openai-compatible", contextWindow: 128000, maxTokens: 4096, supportsVision: false, supportsReasoning: false },
  ],
  longcat: [
    { id: "LongCat-2.0", name: "LongCat 2.0", provider: "longcat", api: "openai-compatible", contextWindow: 1000000, maxTokens: 131072, supportsVision: false, supportsReasoning: true },
  ],
};

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

const PI_AI_KNOWN_PROVIDERS: Record<string, string> = {
  openai: "openai",
  groq: "groq",
  openrouter: "openrouter",
};

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let providerConfigs: Record<string, Record<string, unknown>> = {};

// ---------------------------------------------------------------------------
// API key
// ---------------------------------------------------------------------------

export function getApiKeyForProvider(providerId: string): string | undefined {
  const config = providerConfigs[providerId];
  return config?.apiKey as string | undefined;
}

// ---------------------------------------------------------------------------
// Model builders
// ---------------------------------------------------------------------------

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
    provider: provider as Model<Api>["provider"],
    baseUrl,
    reasoning: modelDef.supportsReasoning,
    input: modelDef.supportsVision ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: modelDef.contextWindow,
    maxTokens: modelDef.maxTokens,
    headers,
  } as unknown as Model<"openai-completions">;
}

function buildAnthropicModel(
  modelId: string,
  modelDef: ModelDefinition,
  baseUrl: string,
  provider: string,
  headers?: Record<string, string>,
): Model<"anthropic-messages"> {
  return {
    id: modelId,
    name: modelDef.name,
    api: "anthropic-messages",
    provider: provider as Model<Api>["provider"],
    baseUrl,
    reasoning: modelDef.supportsReasoning,
    input: modelDef.supportsVision ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: modelDef.contextWindow,
    maxTokens: modelDef.maxTokens,
    headers: {
      "anthropic-version": "2023-06-01",
      ...headers,
    },
  } as unknown as Model<"anthropic-messages">;
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export function initModelResolver(config: {
  providers: Record<string, Record<string, unknown>>;
}): void {
  providerConfigs = { ...config.providers };
  logger.debug({ configuredKeys: Object.keys(providerConfigs) }, "Model resolver initialized");
}

// ---------------------------------------------------------------------------
// Resolve
// ---------------------------------------------------------------------------

export function resolveModel(providerId: string, modelId: string): Model<Api> | undefined {
  // 1. Check local China provider models
  const chinaModels = CHINA_PROVIDER_MODELS[providerId];
  if (chinaModels) {
    const modelDef = chinaModels.find((m) => m.id === modelId);
    if (modelDef) {
      const config = providerConfigs[providerId] as Record<string, string> | undefined;
      const baseUrl = config?.baseUrl ?? CHINA_PROVIDER_BASE_URLS[providerId];
      if (baseUrl) {
        return modelDef.api === "anthropic"
          ? buildAnthropicModel(modelDef.id, modelDef, baseUrl, providerId, config?.headers as Record<string, string> | undefined)
          : buildOpenAIModel(modelDef.id, modelDef, baseUrl, providerId, config?.headers as Record<string, string> | undefined);
      }
    }
  }

  // 2. pi-ai known providers
  const piProvider = PI_AI_KNOWN_PROVIDERS[providerId];
  if (piProvider) {
    try {
      const model = getModel(piProvider as any, modelId as any);
      if (model) return model;
    } catch {
      // fall through
    }
  }

  // 3. Dynamic fallback
  const config = providerConfigs[providerId] as Record<string, string> | undefined;
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
      const headers = { ...preset?.headers, ...(config.headers as Record<string, string> | undefined) };
      return buildOpenAIModel(
        modelId,
        dynamicDef,
        baseUrl,
        providerId,
        Object.keys(headers).length > 0 ? headers : undefined,
      );
    }
  }

  logger.warn({ providerId, modelId }, "Failed to resolve model");
  return undefined;
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

export function isProviderAvailable(providerId: string): boolean {
  const config = providerConfigs[providerId];
  if (!config) return false;
  if (providerId === "ollama" || providerId === "vllm") return true;
  return !!config.apiKey;
}
