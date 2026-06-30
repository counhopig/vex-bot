import { describe, expect, it } from "vitest";
import {
	PROVIDERS,
	PROVIDER_IDS,
	getProviderName,
	getProviderMeta,
	CHINA_PROVIDER_IDS,
	OVERSEAS_PROVIDER_IDS,
} from "../src/providers/metadata.js";

describe("providers/metadata", () => {
	it("exposes a stable list of 17 provider ids", () => {
		expect(PROVIDER_IDS.length).toBe(17);
		expect(new Set(PROVIDER_IDS).size).toBe(PROVIDER_IDS.length);
	});

	it("includes the canonical ids used by the schema and websocket validator", () => {
		for (const id of [
			"deepseek",
			"doubao",
			"minimax",
			"kimi",
			"stepfun",
			"modelscope",
			"dashscope",
			"zhipu",
			"longcat",
			"openai",
			"ollama",
			"openrouter",
			"together",
			"groq",
			"custom-openai",
			"custom-anthropic",
			"vllm",
		]) {
			expect(PROVIDER_IDS).toContain(id);
		}
	});

	it("returns the human-readable name for known ids and falls back to the id", () => {
		expect(getProviderName("deepseek")).toBe("DeepSeek");
		expect(getProviderName("zhipu")).toBe("Zhipu AI");
		expect(getProviderName("longcat")).toBe("LongCat");
		expect(getProviderName("custom-openai")).toBe("Custom OpenAI");
		expect(getProviderName("unknown-vendor")).toBe("unknown-vendor");
	});

	it("classifies providers by tier", () => {
		expect(CHINA_PROVIDER_IDS).toContain("deepseek");
		expect(CHINA_PROVIDER_IDS).toContain("longcat");
		expect(CHINA_PROVIDER_IDS).not.toContain("openai");
		expect(OVERSEAS_PROVIDER_IDS).toContain("openai");
		expect(OVERSEAS_PROVIDER_IDS).toContain("ollama");
		expect(OVERSEAS_PROVIDER_IDS).toContain("vllm");
	});

	it("flags local providers (ollama, vllm) as not requiring an api key", () => {
		expect(getProviderMeta("ollama")?.requiresApiKey).toBe(false);
		expect(getProviderMeta("vllm")?.requiresApiKey).toBe(false);
		expect(getProviderMeta("deepseek")?.requiresApiKey).toBe(true);
	});

	it("exposes a default model id for chat providers (skips local inference)", () => {
		for (const p of PROVIDERS) {
			if (p.tier === "custom" || !p.requiresApiKey) continue;
			expect(p.defaultModel.length).toBeGreaterThan(0);
		}
	});
});
