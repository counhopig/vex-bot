/**
 * Model provider management - thin wrapper, delegates to model-resolver
 */

import type { ProviderId, VexConfig } from "../types/index.js";
import {
  initModelResolver,
  resolveModel,
  getAllRegisteredModels,
  isProviderAvailable,
  getApiKeyForProvider,
} from "./model-resolver.js";
import { getChildLogger } from "../utils/logger.js";

export { resolveModel, getApiKeyForProvider, isProviderAvailable } from "./model-resolver.js";

const logger = getChildLogger("providers");

/** Initialize providers from config */
export function initializeProviders(config: VexConfig): void {
  initModelResolver(config);
  logger.info("Providers initialized via model-resolver");
}

/** Get all available models */
export function getAllModels() {
  return getAllRegisteredModels().map((item) => ({
    provider: item.provider,
    model: {
      id: item.modelId,
      name: item.model.name,
      supportsVision: item.model.input.includes("image"),
      supportsReasoning: item.model.reasoning,
      contextWindow: item.model.contextWindow,
      maxTokens: item.model.maxTokens,
    },
  }));
}

/** Get all providers (compatibility interface) */
export function getAllProviders(): Array<{ id: ProviderId; name: string }> {
  const providers = new Map<string, { id: ProviderId; name: string }>();

  for (const item of getAllRegisteredModels()) {
    if (!providers.has(item.provider)) {
      providers.set(item.provider, { id: item.provider, name: item.provider });
    }
  }

  return Array.from(providers.values());
}

/** Check whether a provider is available */
export function hasProvider(id: ProviderId): boolean {
  return isProviderAvailable(id);
}
