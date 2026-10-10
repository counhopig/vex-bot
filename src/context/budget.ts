import type { StreamFn } from "@earendil-works/pi-agent-core";
import { getCurrentTools, type Context, type Model, type Api } from "@earendil-works/pi-ai";

export const CONTEXT_BUDGET_ERROR = "VEX_CONTEXT_BUDGET: request rejected locally";

export class ContextBudgetError extends Error {
  readonly code = "VEX_CONTEXT_BUDGET";
  readonly reason: string;
  constructor(message: string) {
    super(CONTEXT_BUDGET_ERROR);
    this.name = "ContextBudgetError";
    this.reason = message;
  }
}

function tokenEstimate(text: string): number {
  // UTF-8 bytes are a deliberate safe upper bound for ordinary tokenizer output.
  return Buffer.byteLength(text, "utf8");
}

function contentCost(content: unknown): number {
  if (typeof content === "string") return tokenEstimate(content);
  if (!Array.isArray(content)) return 0;
  return content.reduce((sum: number, part: { type?: string; text?: string; data?: string; mimeType?: string }) => {
    if (part.type === "image") return sum + Math.max(16_384, Buffer.byteLength(part.data ?? "", "utf8"));
    if (part.type === "text") return sum + tokenEstimate(part.text ?? "");
    if (typeof part === "object") return sum + tokenEstimate(JSON.stringify(part));
    return sum;
  }, 0);
}

export function estimateProviderInput(context: Context): number {
  const messages = context.messages;
  let estimate = 0;
  for (const message of messages) {
    const record = message as unknown as Record<string, unknown>;
    estimate += 16 + contentCost(record.content);
    const wireFields = Object.fromEntries(["role", "toolCallId", "toolName", "name", "isError", "sections"].flatMap((key) => record[key] === undefined ? [] : [[key, record[key]]]));
    estimate += tokenEstimate(JSON.stringify(wireFields));
  }
  const system = context.systemPrompt ?? "";
  estimate += tokenEstimate(system);
  const tools = context.tools ?? getCurrentTools(messages);
  estimate += tools.reduce((sum, tool) => sum + 32 + tokenEstimate(JSON.stringify(tool)), 0);
  return estimate;
}

export function assertRequestFits(model: Model<Api>, context: Context, requestedOutput?: number): void {
  if (!Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0 || !Number.isSafeInteger(model.maxTokens) || model.maxTokens <= 0 || model.maxTokens >= model.contextWindow) {
    throw new ContextBudgetError(`Model ${model.provider}/${model.id} has unusable context or output limits.`);
  }
  const output = requestedOutput ?? model.maxTokens;
  if (!Number.isSafeInteger(output) || output <= 0 || output > model.maxTokens) {
    throw new ContextBudgetError(`Model ${model.provider}/${model.id} has an invalid requested output limit.`);
  }
  const input = estimateProviderInput(context);
  if (input + output > model.contextWindow) {
    throw new ContextBudgetError(`The final request needs about ${input} input tokens and ${output} output tokens, exceeding the ${model.contextWindow}-token model context.`);
  }
}

export function withContextBudget(stream: StreamFn): StreamFn {
  return async (model, context, options) => {
    options?.signal?.throwIfAborted();
    assertRequestFits(model, context, options?.maxTokens);
    return stream(model, context, options);
  };
}
