/**
 * LLM complete helper — one-shot LLM call utility
 *
 * Replaces AstrBot's `context.llm_generate`.
 * Built on resolveModel() + getApiKeyForProvider() + pi-ai complete().
 */

import { completeSimple, type AssistantMessage } from "@mariozechner/pi-ai";
import type { ProviderId } from "../types/index.js";
import { resolveModel, getApiKeyForProvider } from "./model-resolver.js";
import { getChildLogger } from "../utils/logger.js";

const logger = getChildLogger("llm");

export interface LlmCompleteOptions {
  /** System prompt (optional) */
  system?: string;
  /** User prompt (required) */
  prompt: string;
  /** Provider ID override (default: from resolved model) */
  providerId?: ProviderId;
  /** Model ID override (default: from resolved model) */
  model?: string;
  /** Temperature (default: 0.7) */
  temperature?: number;
  /** Max tokens (default: 2048) */
  maxTokens?: number;
}

export interface LlmCompleteResult {
  text: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/** Extract text from AssistantMessage content blocks */
function extractTextFromAssistantMessage(message: AssistantMessage): string {
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      parts.push(block.text);
    }
  }
  return parts.join("");
}

/** Extract usage from AssistantMessage */
function extractUsageFromAssistantMessage(message: AssistantMessage): LlmCompleteResult["usage"] {
  if (!message.usage) return undefined;
  return {
    promptTokens: message.usage.input ?? 0,
    completionTokens: message.usage.output ?? 0,
    totalTokens: (message.usage.input ?? 0) + (message.usage.output ?? 0),
  };
}

/**
 * One-shot LLM completion
 *
 * @returns completion text + optional usage stats
 */
export async function llmComplete(options: LlmCompleteOptions): Promise<LlmCompleteResult> {
  const { system, prompt, providerId, model: modelId, temperature = 0.7, maxTokens = 2048 } = options;

  // Resolve model (default to deepseek-chat / deepseek if not specified)
  const resolvedProvider = providerId ?? "deepseek";
  const resolvedModelId = modelId ?? "deepseek-chat";
  const model = resolveModel(resolvedProvider, resolvedModelId);

  if (!model) {
    throw new Error(`Cannot resolve model: ${resolvedProvider}/${resolvedModelId}`);
  }

  // Get API key
  const apiKey = getApiKeyForProvider(resolvedProvider);
  if (!apiKey) {
    throw new Error(`No API key found for provider: ${resolvedProvider}`);
  }

  logger.debug(
    { provider: resolvedProvider, model: resolvedModelId, promptLength: prompt.length },
    "LLM complete"
  );

  try {
    const message = await completeSimple(
      model,
      {
        messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
        systemPrompt: system,
      },
      {
        temperature,
        maxTokens,
      }
    );

    return {
      text: extractTextFromAssistantMessage(message),
      usage: extractUsageFromAssistantMessage(message),
    };
  } catch (error) {
    logger.error({ error, provider: resolvedProvider, model: resolvedModelId }, "LLM complete failed");
    throw error;
  }
}

/**
 * One-shot LLM completion with raw result
 * (for cases where you need the full AssistantMessage)
 */
export async function llmCompleteRaw(options: LlmCompleteOptions): Promise<LlmCompleteResult> {
  const result = await llmComplete(options);
  return result;
}
