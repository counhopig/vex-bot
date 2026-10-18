import { describe, expect, it, vi } from "vitest";
import { assertRequestFits, ContextBudgetError, estimateProviderInput, outputReserve, withContextBudget } from "../src/context/budget.js";
import { createFaux } from "./helpers/faux.js";

describe("provider request budget", () => {
  it("reserves the declared output allowance and rejects invalid limits", () => {
    const model = { ...createFaux().getModel(), contextWindow: 1000, maxTokens: 200 };
    const context = { systemPrompt: "rules", messages: [{ role: "user" as const, content: "x".repeat(3000), timestamp: 1 }] };
    expect(() => assertRequestFits(model, context)).toThrow(ContextBudgetError);
    expect(() => assertRequestFits({ ...model, maxTokens: 0 }, { messages: [] })).toThrow(ContextBudgetError);
  });

  it("counts tool schemas and image payloads", () => {
    const model = { ...createFaux().getModel(), contextWindow: 100000, maxTokens: 100 };
    const base = { messages: [{ role: "user" as const, content: "hi", timestamp: 1 }] };
    const declared = { ...base, tools: [{ name: "x", description: "d", parameters: { type: "object", properties: { huge: { type: "string", description: "z".repeat(3000) } } } }] };
    expect(estimateProviderInput(declared)).toBeGreaterThan(estimateProviderInput(base));
    expect(estimateProviderInput({ messages: [{ role: "user", timestamp: 1, content: [{ type: "image", mimeType: "image/png", data: "A".repeat(24000) }] }] })).toBeGreaterThan(1000);
    expect(() => assertRequestFits({ ...model, contextWindow: 500 }, declared)).toThrow(ContextBudgetError);
  });

  it("tracks SDK tool declarations added and removed in system messages", () => {
    const tool = { name: "large", description: "d".repeat(6000), parameters: { type: "object", properties: { value: { type: "string" } } } };
    const empty = estimateProviderInput({ messages: [] });
    const added = estimateProviderInput({ messages: [{ role: "system", content: "", timestamp: 1, toolsAdded: [tool] }] } as never);
    const removed = estimateProviderInput({ messages: [
      { role: "system", content: "", timestamp: 1, toolsAdded: [tool] },
      { role: "system", content: "", timestamp: 2, toolsRemoved: [{ name: "large" }] },
    ] } as never);
    expect(added).toBeGreaterThan(empty + 1000);
    expect(removed).toBeLessThan(added);
  });

  it("uses conservative sizes for emoji, non-Latin text, and replayed thinking", () => {
    const model = { ...createFaux().getModel(), contextWindow: 100000, maxTokens: 100 };
    const plain = { messages: [{ role: "assistant" as const, content: [{ type: "text" as const, text: "ok" }], timestamp: 1 }] } as never;
    const rich = { messages: [{ role: "assistant" as const, content: [{ type: "thinking" as const, thinking: "🧠漢字".repeat(100), thinkingSignature: "signature" }, { type: "text" as const, text: "ok" }], timestamp: 1 }] } as never;
    expect(estimateProviderInput(rich)).toBeGreaterThan(estimateProviderInput(plain));
    expect(() => assertRequestFits({ ...model, contextWindow: 500 }, rich)).toThrow(ContextBudgetError);
  });

  it("estimates near tokenizer counts for Latin and CJK text and charges images a fixed cost", () => {
    const text = (content: string) => estimateProviderInput({ messages: [{ role: "user", content, timestamp: 1 }] });
    const base = text("");
    expect(text("This is an ordinary English sentence. ".repeat(100)) - base).toBeLessThan(1500);
    expect(text("这是一段普通的中文对话内容。".repeat(100)) - base).toBe(1400);
    const image = (bytes: number) => estimateProviderInput({ messages: [{ role: "user", timestamp: 1, content: [{ type: "image", mimeType: "image/png", data: "A".repeat(bytes) }] }] });
    expect(image(400_000)).toBe(image(1000));
    const model = { ...createFaux().getModel(), contextWindow: 128_000, maxTokens: 16_384 };
    expect(() => assertRequestFits(model, { messages: [{ role: "user", timestamp: 1, content: [{ type: "image", mimeType: "image/png", data: "A".repeat(400_000) }] }] })).not.toThrow();
  });

  it("reserves a quarter of the window when the declared output limit fills it", () => {
    const model = { ...createFaux().getModel(), contextWindow: 1000, maxTokens: 1000 };
    expect(outputReserve(model)).toBe(250);
    expect(outputReserve(model, 100)).toBe(100);
    expect(() => assertRequestFits(model, { messages: [{ role: "user", content: "hi", timestamp: 1 }] })).not.toThrow();
    expect(() => assertRequestFits(model, { messages: [{ role: "user", content: "x".repeat(3000), timestamp: 1 }] })).toThrow(ContextBudgetError);
  });

  it("estimates a request once across nested budget checks and again after it grows", async () => {
    const model = { ...createFaux().getModel(), contextWindow: 100000, maxTokens: 100 };
    const provider = vi.fn(async () => "sent");
    const stream = withContextBudget(withContextBudget(withContextBudget(provider as never)));
    const context = { systemPrompt: "rules", messages: [{ role: "user" as const, content: "hello", timestamp: 1 }] };
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      await stream(model, context as never, {} as never);
      const once = stringify.mock.calls.length;
      stringify.mockClear();
      await stream(model, context as never, {} as never);
      expect(stringify.mock.calls.length).toBe(0);
      context.messages.push({ role: "user", content: "x".repeat(400_000), timestamp: 2 });
      await expect(stream(model, context as never, {} as never)).rejects.toBeInstanceOf(ContextBudgetError);
      expect(once).toBeGreaterThan(0);
    } finally { stringify.mockRestore(); }
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("makes zero provider calls for an oversized request", async () => {
    const provider = vi.fn();
    const stream = withContextBudget(provider as never);
    const model = { ...createFaux().getModel(), contextWindow: 500, maxTokens: 100 };
    await expect(stream(model, { messages: [{ role: "user", content: "x".repeat(3000), timestamp: 1 }] } as never, {} as never)).rejects.toBeInstanceOf(ContextBudgetError);
    expect(provider).not.toHaveBeenCalled();
  });
});
