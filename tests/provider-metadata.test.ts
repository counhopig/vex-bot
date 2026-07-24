/**
 * ProviderMetadata tests — the canonical provider identity table.
 *
 * This is the single source of truth for provider identity, used by:
 *   - ConfigStore schema validation (PROVIDER_IDS → z.enum)
 *   - CLI onboarding / status
 *   - Web UI option rendering (PRIMARY_PROVIDER_IDS for dropdowns)
 *   - ModelResolver (next module) to look up baseUrl / known model lists
 *
 * The table must stay stable: any rename or removal cascades into ~5 surfaces.
 * These tests pin the shape, the id lists, and the public helpers.
 *
 * Note: PROVIDER_IDS includes the 2 custom-* endpoints because the config
 * schema validates `agent.defaultProvider` against this list — a user
 * genuinely pointing at a custom OpenAI/Anthropic endpoint is a first-class
 * case, not admin-only. PRIMARY_PROVIDER_IDS is the smaller subset for UI
 * dropdowns that should not expose admin endpoints.
 */

import { describe, it, expect } from "vitest";
import {
	PROVIDERS,
	PROVIDER_IDS,
	PRIMARY_PROVIDER_IDS,
	CHINA_PROVIDER_IDS,
	OVERSEAS_PROVIDER_IDS,
	getProviderMeta,
	getProviderName,
} from "../src/providers/ProviderMetadata.js";

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

describe("ProviderMetadata", () => {
	describe("PROVIDERS table shape", () => {
		it("is a readonly array of 17 entries (15 primary + 2 custom endpoints)", () => {
			// 17 entries total: the 15 primary vendors (offered in CLI/Web UI
			// dropdowns) plus `custom-openai` and `custom-anthropic` (admin-only
			// slots, configured separately when a custom endpoint is provisioned).
			expect(PROVIDERS).toHaveLength(17);
			// Spelled out so a silent add/remove trips the test.
			const ids = PROVIDERS.map((p) => p.id);
			expect(ids).toEqual([
				// China-hosted
				"deepseek",
				"doubao",
				"minimax",
				"kimi",
				"stepfun",
				"modelscope",
				"dashscope",
				"zhipu",
				"longcat",
				// Overseas
				"openai",
				"openrouter",
				"together",
				"groq",
				"ollama",
				"vllm",
				// Custom endpoints
				"custom-openai",
				"custom-anthropic",
			]);
		});

		it("every entry has the required fields with the right types", () => {
			for (const p of PROVIDERS) {
				expect(typeof p.id).toBe("string");
				expect(p.id.length).toBeGreaterThan(0);
				expect(typeof p.name).toBe("string");
				expect(p.name.length).toBeGreaterThan(0);
				expect(["china", "overseas", "custom"]).toContain(p.tier);
				expect(typeof p.defaultModel).toBe("string");
				expect(typeof p.requiresApiKey).toBe("boolean");
			}
		});

		it("all ids are unique", () => {
			const ids = PROVIDERS.map((p) => p.id);
			expect(new Set(ids).size).toBe(ids.length);
		});
	});

	// -----------------------------------------------------------------------
	// Lookups
	// -----------------------------------------------------------------------

	describe("lookup helpers", () => {
		it("getProviderMeta returns the entry for known ids", () => {
			const meta = getProviderMeta("deepseek");
			expect(meta).toBeDefined();
			expect(meta?.id).toBe("deepseek");
			expect(meta?.name).toBe("DeepSeek");
			expect(meta?.tier).toBe("china");
			expect(meta?.defaultModel).toBe("deepseek-chat");
			expect(meta?.requiresApiKey).toBe(true);
		});

		it("getProviderMeta returns the entry for custom-* ids", () => {
			// Sanity: the custom endpoints must be findable in the table so
			// ModelResolver can resolve them when admin config provides the
			// dynamic baseUrl / apiKey / models.
			const openai = getProviderMeta("custom-openai");
			expect(openai?.tier).toBe("custom");
			expect(openai?.requiresApiKey).toBe(true);

			const anthropic = getProviderMeta("custom-anthropic");
			expect(anthropic?.tier).toBe("custom");
			expect(anthropic?.requiresApiKey).toBe(true);
		});

		it("getProviderMeta returns undefined for unknown ids", () => {
			expect(getProviderMeta("nope")).toBeUndefined();
			expect(getProviderMeta("")).toBeUndefined();
			expect(getProviderMeta("OpenAI")).toBeUndefined(); // case-sensitive
		});

		it("getProviderName returns the display name for known ids", () => {
			expect(getProviderName("deepseek")).toBe("DeepSeek");
			expect(getProviderName("minimax")).toBe("MiniMax");
			expect(getProviderName("zhipu")).toBe("Zhipu AI");
		});

		it("getProviderName falls back to the id for unknown providers", () => {
			expect(getProviderName("unknown-vendor")).toBe("unknown-vendor");
			expect(getProviderName("")).toBe("");
		});
	});

	// -----------------------------------------------------------------------
	// Tier categorization
	// -----------------------------------------------------------------------

	describe("tier id lists", () => {
		it("CHINA_PROVIDER_IDS covers the 9 China-hosted vendors", () => {
			expect([...CHINA_PROVIDER_IDS]).toEqual([
				"deepseek",
				"doubao",
				"minimax",
				"kimi",
				"stepfun",
				"modelscope",
				"dashscope",
				"zhipu",
				"longcat",
			]);
		});

		it("OVERSEAS_PROVIDER_IDS covers the 6 overseas vendors", () => {
			expect([...OVERSEAS_PROVIDER_IDS]).toEqual([
				"openai",
				"openrouter",
				"together",
				"groq",
				"ollama",
				"vllm",
			]);
		});

		it("PROVIDER_IDS is the full 17-entry list (matches every PROVIDERS row)", () => {
			// PROVIDER_IDS is what the config schema validates `agent.defaultProvider`
			// against — narrowing it would silently reject legitimate custom-endpoint
			// configs. It must be 1:1 with PROVIDERS.
			expect([...PROVIDER_IDS]).toEqual(PROVIDERS.map((p) => p.id));
			expect(PROVIDER_IDS).toContain("custom-openai");
			expect(PROVIDER_IDS).toContain("custom-anthropic");
		});

		it("PRIMARY_PROVIDER_IDS is the 15-entry dropdown subset (no custom-*)", () => {
			// PRIMARY_PROVIDER_IDS is what CLI/Web UI dropdowns iterate. It must
			// exclude the admin-only custom-* tier.
			expect([...PRIMARY_PROVIDER_IDS]).toEqual([
				...CHINA_PROVIDER_IDS,
				...OVERSEAS_PROVIDER_IDS,
			]);
			expect(PRIMARY_PROVIDER_IDS).not.toContain("custom-openai");
			expect(PRIMARY_PROVIDER_IDS).not.toContain("custom-anthropic");
		});
	});

	// -----------------------------------------------------------------------
	// requiresApiKey invariants
	// -----------------------------------------------------------------------

	describe("requiresApiKey invariant", () => {
		it("local providers (ollama, vllm) do not require an API key", () => {
			expect(getProviderMeta("ollama")?.requiresApiKey).toBe(false);
			expect(getProviderMeta("vllm")?.requiresApiKey).toBe(false);
		});

		it("all China-hosted providers require an API key", () => {
			for (const id of CHINA_PROVIDER_IDS) {
				expect(getProviderMeta(id)?.requiresApiKey).toBe(true);
			}
		});

		it("all other listed providers require an API key", () => {
			const others = OVERSEAS_PROVIDER_IDS.filter((id) => id !== "ollama" && id !== "vllm");
			for (const id of others) {
				expect(getProviderMeta(id)?.requiresApiKey).toBe(true);
			}
		});
	});

	// -----------------------------------------------------------------------
	// defaultModel invariants
	// -----------------------------------------------------------------------

	describe("defaultModel invariants", () => {
		it("every PRIMARY provider has a non-empty defaultModel", () => {
			// vllm has empty defaultModel on purpose — the user is expected to
			// supply their own model id (no preset model registry for vllm).
			// The custom-* endpoints also have empty defaultModel because the
			// model id is part of the admin config, not the metadata.
			for (const id of PRIMARY_PROVIDER_IDS) {
				const meta = getProviderMeta(id);
				expect(meta).toBeDefined();
				if (id !== "vllm") {
					expect(meta?.defaultModel).not.toBe("");
				}
			}
		});
	});
});
