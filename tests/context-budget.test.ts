import { describe, expect, it, vi } from "vitest";
import { assertRequestFits, ContextBudgetError, estimateProviderInput, withContextBudget } from "../src/context/budget.js";
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
    const tool = { name: "large", description: "d".repeat(2000), parameters: { type: "object", properties: { value: { type: "string" } } } };
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

  it("makes zero provider calls for an oversized request", async () => {
    const provider = vi.fn();
    const stream = withContextBudget(provider as never);
    const model = { ...createFaux().getModel(), contextWindow: 500, maxTokens: 100 };
    await expect(stream(model, { messages: [{ role: "user", content: "x".repeat(3000), timestamp: 1 }] } as never, {} as never)).rejects.toBeInstanceOf(ContextBudgetError);
    expect(provider).not.toHaveBeenCalled();
  });
});
