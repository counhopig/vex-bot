/**
 * CLI `models` command — list models registered for the configured providers.
 */

import { ModelResolver } from "../providers/ModelResolver.js";
import type { SystemConfig } from "../web/routes/config.js";

export interface ListedModel {
  provider: string;
  modelId: string;
  name: string;
  supportsVision: boolean;
  supportsReasoning: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

/** Build a ModelResolver from the system config and list its registered models. */
export function listModels(config: SystemConfig): ListedModel[] {
  const resolver = new ModelResolver();
  resolver.init({ providers: (config.providers ?? {}) as Record<string, { baseUrl?: string; apiKey?: string; headers?: Record<string, string> } | undefined> });

  return resolver.getAllRegisteredModels().map((item) => ({
    provider: item.provider,
    modelId: item.modelId,
    name: item.model.name,
    supportsVision: item.model.input.includes("image"),
    supportsReasoning: item.model.reasoning,
    contextWindow: item.model.contextWindow,
    maxTokens: item.model.maxTokens,
  }));
}
