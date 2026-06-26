import { describe, expect, it } from "vitest";
import { toJson5 } from "../src/config/json5-writer.js";
import {
	PROVIDERS,
	PROVIDER_IDS,
	getProviderName,
	getProviderMeta,
	CHINA_PROVIDER_IDS,
	OVERSEAS_PROVIDER_IDS,
} from "../src/providers/metadata.js";

describe("config/json5-writer", () => {
	it("round-trips a flat object with identifier keys unquoted", () => {
		const out = toJson5({ apiKey: "abc", baseUrl: "https://x" });
		expect(out).toBe('{\n  apiKey: "abc",\n  baseUrl: "https://x"\n}');
	});

	it("quotes non-identifier keys", () => {
		const out = toJson5({ "x-foo": 1 });
		expect(out).toBe('{\n  "x-foo": 1\n}');
	});

	it("drops undefined values from objects", () => {
		const out = toJson5({ a: 1, b: undefined, c: "x" });
		expect(out).toBe('{\n  a: 1,\n  c: "x"\n}');
	});

	it("renders nested arrays with inner indentation", () => {
		const out = toJson5({ models: [{ id: "m1" }] });
		expect(out).toBe('{\n  models: [\n    {\n      id: "m1"\n    }\n  ]\n}');
	});

	it("renders primitives and null", () => {
		expect(toJson5(null)).toBe("null");
		expect(toJson5(undefined)).toBe("null");
		expect(toJson5("")).toBe('""');
		expect(toJson5(0)).toBe("0");
		expect(toJson5(false)).toBe("false");
	});

	it("renders empty object/array literal forms", () => {
		expect(toJson5({})).toBe("{}");
		expect(toJson5([])).toBe("[]");
	});

	it("escapes backslashes and double quotes in strings", () => {
		const out = toJson5({ path: 'a\\b"c' });
		expect(out).toBe('{\n  path: "a\\\\b\\"c"\n}');
	});
});

describe("providers/metadata", () => {
	it("exposes a stable list of 16 provider ids", () => {
		expect(PROVIDER_IDS.length).toBe(16);
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
		expect(getProviderName("custom-openai")).toBe("Custom OpenAI");
		expect(getProviderName("unknown-vendor")).toBe("unknown-vendor");
	});

	it("classifies providers by tier", () => {
		expect(CHINA_PROVIDER_IDS).toContain("deepseek");
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
