import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createProvider,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type MutableModels,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { CustomModelConfig, ModelRef, ProviderConfig } from "../config/schema.js";

export class ModelResolutionError extends Error {}

export type CompleteFn = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => Promise<AssistantMessage>;

export interface ModelRegistry {
  resolve(ref: ModelRef): Model<Api>;
  getApiKey(provider: string): string | undefined;
  streamFn: StreamFn;
  completeSimple: CompleteFn;
}

interface CustomProvider {
  api: NonNullable<ProviderConfig["api"]>;
  baseUrl: string;
  declared: CustomModelConfig[] | undefined;
}

export function createModelRegistry(
  providers: Record<string, ProviderConfig>,
  base: MutableModels = builtinModels(),
): ModelRegistry {
  const custom = new Map<string, CustomProvider>();
  for (const [id, config] of Object.entries(providers)) {
    if (!config.api || !config.baseUrl) continue;
    const entry: CustomProvider = { api: config.api, baseUrl: config.baseUrl, declared: config.models };
    custom.set(id, entry);
    base.setProvider(
      createProvider({
        id,
        name: id,
        baseUrl: config.baseUrl,
        // The key is passed explicitly per request, so the provider itself resolves as keyless.
        auth: { apiKey: { name: `${id} API key`, resolve: async () => ({ auth: {} }) } },
        models: (config.models ?? []).map((m) => customModel(id, entry, m.id)),
        api: config.api === "openai-completions" ? openAICompletionsApi() : anthropicMessagesApi(),
      }),
    );
  }

  return {
    resolve(ref) {
      const entry = custom.get(ref.provider);
      if (entry) {
        if (entry.declared?.length && !entry.declared.some((m) => m.id === ref.id)) {
          throw new ModelResolutionError(
            `提供方 ${ref.provider} 未声明模型 "${ref.id}"。已声明：${entry.declared.map((m) => m.id).join(", ")}`,
          );
        }
        return customModel(ref.provider, entry, ref.id);
      }
      if (!base.getProvider(ref.provider)) {
        const known = base.getProviders().map((p) => p.id);
        throw new ModelResolutionError(
          `未知的模型提供方 "${ref.provider}"。内置提供方：${known.join(", ")}；自定义提供方需在 providers.${ref.provider} 中声明 api 与 baseUrl`,
        );
      }
      const model = base.getModel(ref.provider, ref.id);
      if (!model) {
        const ids = base.getModels(ref.provider).map((m) => m.id);
        throw new ModelResolutionError(`提供方 ${ref.provider} 没有模型 "${ref.id}"。可用：${ids.join(", ")}`);
      }
      return model;
    },
    getApiKey(provider) {
      return providers[provider]?.apiKey || undefined;
    },
    streamFn: (model, context, options) => base.streamSimple(model, context, options),
    completeSimple: (model, context, options) => base.completeSimple(model, context, options),
  };
}

function customModel(provider: string, entry: CustomProvider, id: string): Model<Api> {
  const declared = entry.declared?.find((m) => m.id === id);
  return {
    id,
    name: id,
    api: entry.api,
    provider,
    baseUrl: entry.baseUrl,
    reasoning: declared?.reasoning ?? false,
    input: declared?.input ?? ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: declared?.contextWindow ?? 128_000,
    maxTokens: declared?.maxTokens ?? 8_192,
  };
}
