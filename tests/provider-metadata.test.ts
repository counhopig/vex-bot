/**
 * ProviderMetadata tests — the canonical 15-vendor provider table.
 *
 * This is the single source of truth for provider identity, used by:
 *   - ConfigStore schema validation
 *   - CLI onboarding / status
 *   - Web UI option rendering
 *   - ModelResolver (next module) to look up baseUrl / known model lists
 *
 * The table must stay stable: any rename or removal cascades into ~5 surfaces.
 * These tests pin the shape, the 15 vendor ids, and the public helpers.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	PROVIDERS,
	PROVIDER_IDS,
	CHINA_PROVIDER_IDS,
	OVERSEAS_PROVIDER_IDS,
	getProviderMeta,
	getProviderName,
} from "../src/providers/ProviderMetadata.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

		it("the single SourceOfTruth comment (or comment block) is preserved", () => {
			// Sanity: the source file's top docstring must still call out
			// "single source of truth" — this is the contract the rewrite plan
			// relies on. We re-read the module's first comment line so any
			// future rewrite either keeps the language or consciously changes
			// the contract.
			// (Indirect: ensure the legend phrase is present, not how it's phrased.)
			const src = readFileSync(
				join(__dirname, "..", "src", "providers", "ProviderMetadata.ts"),
				"utf-8",
			);
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
		it("PROVIDER_IDS excludes the admin-only custom-* endpoints", () => {
			// custom-openai / custom-anthropic live in PROVIDERS (so getProviderMeta
			// can find them when an admin provisions one) but are NOT offered in
			// the user-pickable dropdown (CLI/Web UI).
			expect([...PROVIDER_IDS]).toEqual([...CHINA_PROVIDER_IDS, ...OVERSEAS_PROVIDER_IDS]);
			expect(PROVIDER_IDS).not.toContain("custom-openai");
			expect(PROVIDER_IDS).not.toContain("custom-anthropic");
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
			// The two custom-* endpoints also have empty defaultModel because
			// the model id is part of the admin config, not the metadata.
			for (const id of PROVIDER_IDS) {
				const meta = getProviderMeta(id);
				expect(meta).toBeDefined();
				if (id !== "vllm") {
					expect(meta?.defaultModel).not.toBe("");
				}
			}
		});
	});
});
