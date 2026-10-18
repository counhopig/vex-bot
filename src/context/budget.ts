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

const IDEOGRAPHIC = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uffef]/u;
/** Image inputs are resized by providers; this covers the largest per-image charge of common APIs. */
export const IMAGE_TOKENS = 2_048;

/** Token cost of one character: ideographs about one each, other astral symbols two, other text one per three UTF-8 bytes. */
export function charTokens(char: string): number {
  if (IDEOGRAPHIC.test(char)) return 1;
  if (char.length > 1) return 2;
  return Buffer.byteLength(char, "utf8") / 3;
}

/** A conservative token count: above typical tokenizer output for Latin, CJK and mixed text. */
export function tokenEstimate(text: string): number {
  let tokens = 0;
  for (const char of text) tokens += charTokens(char);
  return Math.ceil(tokens);
}

function contentCost(content: unknown): number {
  if (typeof content === "string") return tokenEstimate(content);
  if (!Array.isArray(content)) return 0;
  return content.reduce((sum: number, part: { type?: string; text?: string; data?: string; mimeType?: string }) => {
    if (part.type === "image") return sum + IMAGE_TOKENS;
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

/**
 * Output tokens reserved inside the context window. A declared output limit that fills the whole
 * window (common for models whose provider caps output dynamically) reserves a quarter of it.
 */
export function outputReserve(model: Model<Api>, requestedOutput?: number): number {
  if (!Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0 || !Number.isSafeInteger(model.maxTokens) || model.maxTokens <= 0) {
    throw new ContextBudgetError(`Model ${model.provider}/${model.id} has unusable context or output limits.`);
  }
  const output = requestedOutput ?? model.maxTokens;
  if (!Number.isSafeInteger(output) || output <= 0 || output > model.maxTokens) {
    throw new ContextBudgetError(`Model ${model.provider}/${model.id} has an invalid requested output limit.`);
  }
  return output < model.contextWindow ? output : Math.floor(model.contextWindow / 4);
}

export function assertRequestFits(model: Model<Api>, context: Context, requestedOutput?: number): void {
  const output = outputReserve(model, requestedOutput);
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
