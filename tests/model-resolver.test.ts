/**
 * ModelResolver tests — wraps @mariozechner/pi-ai to turn an
 * (EffectiveConfig shape, providerId, modelId) into a Model<Api>.
 *
 * Three resolution paths (each must have a test):
 *   1. Registered China/preset/custom-* provider from the local registry
 *      (built at init time from the config).
 *   2. pi-ai built-in catalog (openai, anthropic, groq, openrouter) via
 *      getModel() — covers any model id pi-ai knows about automatically.
 *   3. Dynamic fallback: any provider with a baseUrl + config entry gets
 *      a synthetic OpenAI-compatible Model built on demand.
 *
 * The custom-openai / custom-anthropic paths are structurally different
 * (config-supplied models[] and apiVersion, not a fixed table) — they
 * get dedicated tests since this is the path most likely to silently
 * regress if anyone narrows the resolver.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
	ModelResolver,
	type ProviderConfig,
	type CustomProviderModelConfig,
} from "../src/providers/ModelResolver.js";
import { PROVIDER_IDS } from "../src/providers/ProviderMetadata.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CHINA_IDS = [
	"deepseek",
	"doubao",
	"minimax",
	"kimi",
	"stepfun",
	"modelscope",
	"dashscope",
	"zhipu",
	"longcat",
] as const;

const PRESET_IDS = ["openrouter", "together", "groq", "ollama", "vllm"] as const;

function chinaProvider(apiKey = "sk-test"): ProviderConfig {
	return { apiKey };
}

function customOpenAI(
	apiKey: string,
	models: CustomProviderModelConfig[],
): ProviderConfig {
	return {
		apiKey,
		baseUrl: "https://proxy.example.com/v1",
		models,
	};
}

function customAnthropic(
	apiKey: string,
	models: CustomProviderModelConfig[],
	apiVersion?: string,
): ProviderConfig {
	return {
		apiKey,
		baseUrl: "https://proxy.example.com",
		models,
		apiVersion,
	};
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("ModelResolver", () => {
	let resolver: ModelResolver;

	beforeEach(() => {
		resolver = new ModelResolver();
	});

	// -----------------------------------------------------------------------
	// Init lifecycle
	// -----------------------------------------------------------------------

	describe("init lifecycle", () => {
		it("init accepts an empty config without throwing", () => {
			expect(() => resolver.init({ providers: {} })).not.toThrow();
		});

		it("getAllRegisteredModels is empty after init with no providers", () => {
			resolver.init({ providers: {} });
			expect(resolver.getAllRegisteredModels()).toEqual([]);
		});

		it("re-init clears previous models (no stale entries)", () => {
			// First init registers DeepSeek's preset models.
			resolver.init({ providers: { deepseek: chinaProvider() } });
			const firstCount = resolver.getAllRegisteredModels().length;
			expect(firstCount).toBeGreaterThan(0);

			// Re-init with an empty config — all old entries must be gone.
			resolver.init({ providers: {} });
			expect(resolver.getAllRegisteredModels()).toEqual([]);
		});

		it("re-init with a different provider set drops the previous set", () => {
			resolver.init({ providers: { deepseek: chinaProvider() } });
			expect(resolver.getAllRegisteredModels().some((m) => m.provider === "deepseek")).toBe(true);

			resolver.init({ providers: { kimi: chinaProvider() } });
			expect(resolver.getAllRegisteredModels().some((m) => m.provider === "deepseek")).toBe(false);
			expect(resolver.getAllRegisteredModels().some((m) => m.provider === "kimi")).toBe(true);
		});

		it("reset clears all state without requiring another init", () => {
			resolver.init({ providers: { deepseek: chinaProvider() } });
			expect(resolver.getAllRegisteredModels().length).toBeGreaterThan(0);

			resolver.reset();
			expect(resolver.getAllRegisteredModels()).toEqual([]);
			// After reset, resolving should return undefined (no init done).
			expect(resolver.resolveModel("deepseek", "deepseek-chat")).toBeUndefined();
		});
	});

	// -----------------------------------------------------------------------
	// getApiKeyForProvider
	// -----------------------------------------------------------------------

	describe("getApiKeyForProvider", () => {
		it("returns the apiKey from the initialized config", () => {
			resolver.init({ providers: { deepseek: { apiKey: "sk-abc" } } });
			expect(resolver.getApiKeyForProvider("deepseek")).toBe("sk-abc");
		});

		it("returns undefined for unknown providers", () => {
			resolver.init({ providers: {} });
			expect(resolver.getApiKeyForProvider("nope")).toBeUndefined();
		});

		it("returns undefined when the provider has no apiKey", () => {
			resolver.init({ providers: { deepseek: { baseUrl: "https://example.com" } } });
			expect(resolver.getApiKeyForProvider("deepseek")).toBeUndefined();
		});
	});

	// -----------------------------------------------------------------------
	// China provider preset models
	// -----------------------------------------------------------------------

	describe("China provider preset models", () => {
		for (const id of CHINA_IDS) {
			it(`registers preset models for "${id}" after init with apiKey`, () => {
				resolver.init({ providers: { [id]: chinaProvider() } });
				const mine = resolver.getAllRegisteredModels().filter((m) => m.provider === id);
				expect(mine.length).toBeGreaterThan(0);
				// Each registration must produce a Model with the right api kind.
				for (const m of mine) {
					// Either OpenAI-compatible (most China providers) or Anthropic-style
					// (minimax is the only Anthropic-compatible China provider in the archive).
					expect(["openai-completions", "anthropic-messages"]).toContain(m.model.api);
					expect(m.model.baseUrl.length).toBeGreaterThan(0);
				}
			});

			it(`does NOT register preset models for "${id}" without apiKey`, () => {
				// The archive's init skips providers without apiKey, so the
				// registry stays empty for them.
				resolver.init({ providers: { [id]: { baseUrl: "https://example.com" } } });
				const mine = resolver.getAllRegisteredModels().filter((m) => m.provider === id);
				expect(mine).toEqual([]);
			});
		}

		it("minimax preset models use anthropic-messages (the only Anthropic-compatible China provider)", () => {
			resolver.init({ providers: { minimax: chinaProvider() } });
			const mine = resolver.getAllRegisteredModels().filter((m) => m.provider === "minimax");
			expect(mine.length).toBeGreaterThan(0);
			for (const m of mine) {
				expect(m.model.api).toBe("anthropic-messages");
				// Anthropic-compatible models must carry the anthropic-version header.
				expect(m.model.headers?.["anthropic-version"]).toBe("2023-06-01");
			}
		});

		it("respects config.baseUrl override for China providers", () => {
			resolver.init({
				providers: {
					deepseek: { apiKey: "sk-test", baseUrl: "https://proxy.example.com/v1" },
				},
			});
			const deepseek = resolver.resolveModel("deepseek", "deepseek-chat");
			expect(deepseek).toBeDefined();
			expect(deepseek?.baseUrl).toBe("https://proxy.example.com/v1");
		});

		it("merges config.headers into the Model (preset headers + user headers)", () => {
			// openrouter has preset headers (HTTP-Referer, X-Title) — config
			// headers must be merged on top of those. We test through the
			// dynamic fallback path since openrouter isn't a fixed-model row.
			resolver.init({
				providers: {
					openrouter: {
						apiKey: "sk-test",
						headers: { "X-Trace-Id": "abc-123" },
					},
				},
			});
			const m = resolver.resolveModel("openrouter", "meta-llama/llama-3-70b");
			expect(m).toBeDefined();
			// User-supplied header must be present.
			expect(m?.headers?.["X-Trace-Id"]).toBe("abc-123");
		});
	});

	// -----------------------------------------------------------------------
	// Dynamic fallback for preset providers (openrouter/together/groq/ollama/vllm)
	// -----------------------------------------------------------------------

	describe("dynamic fallback for preset providers", () => {
		for (const id of PRESET_IDS) {
			it(`builds a Model for "${id}" on demand when only apiKey is configured`, () => {
				// These providers have no fixed model list in the archive's
				// CHINA_PROVIDER_MODELS; resolveModel must synthesize an
				// OpenAI-compatible Model from the preset baseUrl + apiKey.
				const cfg: ProviderConfig = id === "ollama" || id === "vllm"
					? { baseUrl: "http://localhost:11434/v1" }
					: { apiKey: "sk-test" };
				resolver.init({ providers: { [id]: cfg } });
				const m = resolver.resolveModel(id, "any-model-id");
				expect(m).toBeDefined();
				expect(m?.api).toBe("openai-completions");
				expect(m?.baseUrl.length).toBeGreaterThan(0);
			});
		}

		it("returns undefined for a provider with no apiKey and no preset baseUrl", () => {
			// "nope" is not in CHINA_PROVIDER_BASE_URLS, PRESET_PROVIDER_CONFIGS,
			// or PI_AI_KNOWN_PROVIDERS — the resolver must not crash.
			resolver.init({ providers: {} });
			expect(resolver.resolveModel("nope", "any-model-id")).toBeUndefined();
		});

		it("returns undefined for a known provider with no config and no init", () => {
			// Fresh resolver, no init — anything fails gracefully.
			expect(resolver.resolveModel("deepseek", "deepseek-chat")).toBeUndefined();
		});
	});

	// -----------------------------------------------------------------------
	// pi-ai built-in catalog
	// -----------------------------------------------------------------------

	describe("pi-ai built-in catalog (openai/anthropic/groq/openrouter)", () => {
		it("resolves 'gpt-4o-mini' under provider 'openai' via pi-ai getModel", () => {
			// openai is in PI_AI_KNOWN_PROVIDERS; pi-ai's built-in catalog
			// has gpt-4o-mini. Requires no init — getModel works on pi-ai's
			// own module-level registry.
			const m = resolver.resolveModel("openai", "gpt-4o-mini");
			expect(m).toBeDefined();
			expect(m?.id).toBe("gpt-4o-mini");
		});

		it("resolves an Anthropic model id under provider 'anthropic' via pi-ai getModel", () => {
			const m = resolver.resolveModel("anthropic", "claude-3-5-sonnet-20241022");
			expect(m).toBeDefined();
			expect(m?.api).toBe("anthropic-messages");
		});

		it("returns undefined for an unknown pi-ai model id without crashing", () => {
			expect(resolver.resolveModel("openai", "this-model-does-not-exist")).toBeUndefined();
		});
	});

	// -----------------------------------------------------------------------
	// custom-openai / custom-anthropic (the structurally distinct path)
	// -----------------------------------------------------------------------

	describe("custom-openai", () => {
		it("registers each entry of config.models[] as a Model<openai-completions>", () => {
			resolver.init({
				providers: {
					"custom-openai": customOpenAI("sk-test", [
						{ id: "my-fast", name: "My Fast", contextWindow: 32000, maxTokens: 4096 },
						{ id: "my-big", name: "My Big", contextWindow: 200000, maxTokens: 8192 },
					]),
				},
			});
			const fast = resolver.resolveModel("custom-openai", "my-fast");
			const big = resolver.resolveModel("custom-openai", "my-big");
			expect(fast).toBeDefined();
			expect(fast?.api).toBe("openai-completions");
			expect(fast?.name).toBe("My Fast");
			expect(fast?.contextWindow).toBe(32000);
			expect(fast?.maxTokens).toBe(4096);
			expect(big).toBeDefined();
			expect(big?.contextWindow).toBe(200000);
		});

		it("uses defaults (128000 context, 4096 maxTokens) when not specified in config.models[i]", () => {
			resolver.init({
				providers: {
					"custom-openai": customOpenAI("sk-test", [{ id: "bare" }]),
				},
			});
			const m = resolver.resolveModel("custom-openai", "bare");
			expect(m).toBeDefined();
			expect(m?.contextWindow).toBe(128000);
			expect(m?.maxTokens).toBe(4096);
		});

		it("uses the config's baseUrl for the registered Model", () => {
			resolver.init({
				providers: {
					"custom-openai": customOpenAI("sk-test", [{ id: "x" }]),
				},
			});
			const m = resolver.resolveModel("custom-openai", "x");
			expect(m?.baseUrl).toBe("https://proxy.example.com/v1");
		});

		it("does NOT register models when baseUrl is missing (admin misconfigured)", () => {
			// Intentionally malformed: missing baseUrl. Object must satisfy
			// the wider shape so the omission is visible to the type checker.
			resolver.init({
				providers: {
					"custom-openai": {
						apiKey: "sk-test",
						models: [{ id: "x" }],
					} satisfies ProviderConfig,
				},
			});
			expect(resolver.resolveModel("custom-openai", "x")).toBeUndefined();
		});

		it("does NOT register models when models[] is missing", () => {
			resolver.init({
				providers: {
					"custom-openai": {
						apiKey: "sk-test",
						baseUrl: "https://proxy.example.com/v1",
					} satisfies ProviderConfig,
				},
			});
			expect(resolver.resolveModel("custom-openai", "any-model")).toBeUndefined();
		});
	});

	describe("custom-anthropic", () => {
		it("registers each entry of config.models[] as a Model<anthropic-messages>", () => {
			resolver.init({
				providers: {
					"custom-anthropic": customAnthropic("sk-test", [
						{ id: "my-claude", name: "My Claude", contextWindow: 200000, maxTokens: 8192 },
					]),
				},
			});
			const m = resolver.resolveModel("custom-anthropic", "my-claude");
			expect(m).toBeDefined();
			expect(m?.api).toBe("anthropic-messages");
			expect(m?.baseUrl).toBe("https://proxy.example.com");
			// Default Anthropic-version header must be present.
			expect(m?.headers?.["anthropic-version"]).toBe("2023-06-01");
		});

		it("uses config.apiVersion override when supplied", () => {
			resolver.init({
				providers: {
					"custom-anthropic": customAnthropic("sk-test", [{ id: "x" }], "2024-01-01"),
				},
			});
			const m = resolver.resolveModel("custom-anthropic", "x");
			expect(m?.headers?.["anthropic-version"]).toBe("2024-01-01");
		});

		it("uses default Anthropic context window (200000) when config doesn't specify", () => {
			resolver.init({
				providers: {
					"custom-anthropic": customAnthropic("sk-test", [{ id: "bare" }]),
				},
			});
			const m = resolver.resolveModel("custom-anthropic", "bare");
			expect(m?.contextWindow).toBe(200000);
		});

		it("returns undefined for any model id not in config.models[]", () => {
			resolver.init({
				providers: {
					"custom-anthropic": customAnthropic("sk-test", [{ id: "declared" }]),
				},
			});
			expect(resolver.resolveModel("custom-anthropic", "undeclared")).toBeUndefined();
		});
	});

	// -----------------------------------------------------------------------
	// isProviderAvailable
	// -----------------------------------------------------------------------

	describe("isProviderAvailable", () => {
		it("returns true when an apiKey is configured", () => {
			resolver.init({ providers: { deepseek: { apiKey: "sk-test" } } });
			expect(resolver.isProviderAvailable("deepseek")).toBe(true);
		});

		it("returns true for ollama and vllm even without apiKey (local providers)", () => {
			resolver.init({ providers: {} });
			expect(resolver.isProviderAvailable("ollama")).toBe(true);
			expect(resolver.isProviderAvailable("vllm")).toBe(true);
		});

		it("returns false for providers with no apiKey and no local exception", () => {
			resolver.init({ providers: {} });
			expect(resolver.isProviderAvailable("deepseek")).toBe(false);
			expect(resolver.isProviderAvailable("openai")).toBe(false);
		});

		it("returns false for unknown provider ids", () => {
			resolver.init({ providers: {} });
			expect(resolver.isProviderAvailable("nope")).toBe(false);
		});

		it("custom-openai is available only when apiKey AND baseUrl are configured", () => {
			// The custom-* providers need more than just apiKey to be usable —
			// they also need baseUrl. The resolver must distinguish.
			resolver.init({ providers: { "custom-openai": { apiKey: "sk-test" } } });
			expect(resolver.isProviderAvailable("custom-openai")).toBe(false);

			resolver.init({
				providers: {
					"custom-openai": {
						apiKey: "sk-test",
						baseUrl: "https://proxy.example.com/v1",
						models: [{ id: "x" }],
					},
				},
			});
			expect(resolver.isProviderAvailable("custom-openai")).toBe(true);
		});

		it("custom-anthropic is available only when apiKey AND baseUrl are configured", () => {
			resolver.init({
				providers: {
					"custom-anthropic": {
						apiKey: "sk-test",
						baseUrl: "https://proxy.example.com",
						models: [{ id: "x" }],
					},
				},
			});
			expect(resolver.isProviderAvailable("custom-anthropic")).toBe(true);
		});
	});

	// -----------------------------------------------------------------------
	// Type-system guard: ProviderId derived from PROVIDER_IDS
	// -----------------------------------------------------------------------

	describe("type contract", () => {
		it("accepts every PROVIDER_IDS string as a valid resolver input", () => {
			// Compile-time check (in the implementation): ProviderId is
			// (typeof PROVIDER_IDS)[number], so all PROVIDER_IDS values
			// are accepted by resolveModel / isProviderAvailable. Runtime
			// check: every PROVIDER_IDS string can be passed without
			// crashing and returns a boolean from isProviderAvailable.
			for (const id of PROVIDER_IDS) {
				// isProviderAvailable is a total function over the id union.
				const result = resolver.isProviderAvailable(id);
				expect(typeof result).toBe("boolean");
			}
		});
	});
});
