import { createModels, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";
import { createModelRegistry, ModelResolutionError } from "../src/providers/models.js";
import { createFaux } from "./helpers/faux.js";

const firstDeepseek = getBuiltinModels("deepseek")[0]!;

describe("createModelRegistry", () => {
  it("resolves a built-in model", () => {
    const model = createModelRegistry({}).resolve({ provider: "deepseek", id: firstDeepseek.id });
    expect(model.id).toBe(firstDeepseek.id);
    expect(model.api).toBe(firstDeepseek.api);
    expect(model.baseUrl).toBe(firstDeepseek.baseUrl);
  });

  it("matches model ids case-sensitively and lists the available ids", () => {
    const registry = createModelRegistry({});
    const wrongCase = firstDeepseek.id.toUpperCase();
    expect(() => registry.resolve({ provider: "deepseek", id: wrongCase })).toThrow(ModelResolutionError);
    expect(() => registry.resolve({ provider: "deepseek", id: wrongCase })).toThrow(firstDeepseek.id);
  });

  it("rejects an unknown provider", () => {
    expect(() => createModelRegistry({}).resolve({ provider: "nope", id: "x" })).toThrow(/未知的模型提供方 "nope"/);
  });

  it("builds a declared custom model", () => {
    const registry = createModelRegistry({
      stepfun: {
        api: "openai-completions",
        baseUrl: "https://api.stepfun.com/v1",
        models: [{ id: "step-2-16k", contextWindow: 16000, reasoning: true }],
      },
    });
    expect(registry.resolve({ provider: "stepfun", id: "step-2-16k" })).toEqual({
      id: "step-2-16k",
      name: "step-2-16k",
      api: "openai-completions",
      provider: "stepfun",
      baseUrl: "https://api.stepfun.com/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 16000,
      maxTokens: 8192,
    });
    expect(() => registry.resolve({ provider: "stepfun", id: "other" })).toThrow(/未声明模型 "other"/);
  });

  it("accepts any id for a custom provider without a model list", () => {
    const registry = createModelRegistry({
      ollama: { api: "openai-completions", baseUrl: "http://127.0.0.1:11434/v1" },
    });
    const model = registry.resolve({ provider: "ollama", id: "qwen3:14b" });
    expect(model.id).toBe("qwen3:14b");
    expect(model.contextWindow).toBe(128000);
  });

  it("returns the configured api key", () => {
    const registry = createModelRegistry({ deepseek: { apiKey: "from-config" } });
    expect(registry.getApiKey("deepseek")).toBe("from-config");
    expect(registry.getApiKey("moonshotai-cn")).toBeUndefined();
  });

  it("streams and completes through the collection", async () => {
    const faux = createFaux();
    const base = createModels();
    base.setProvider(faux.provider);
    const registry = createModelRegistry({}, base);
    const model = registry.resolve({ provider: faux.getModel().provider, id: faux.getModel().id });
    faux.setResponses([fauxAssistantMessage("hi")]);
    const result = await registry.completeSimple(model, { messages: [{ role: "user", content: "x", timestamp: 1 }] });
    expect(result.content).toEqual([{ type: "text", text: "hi" }]);
  });
});
