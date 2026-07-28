/**
 * Providers module tests — metadata, model resolution, API key lookup.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  PROVIDERS,
  PROVIDER_IDS,
  getProviderMeta,
  getProviderName,
  CHINA_PROVIDER_IDS,
  OVERSEAS_PROVIDER_IDS,
} from "../src/providers/ProviderMetadata.js";
import {
  initModelResolver,
  resolveModel,
  getApiKeyForProvider,
  isProviderAvailable,
} from "../src/providers/ModelResolver.js";

// ---------------------------------------------------------------------------
// ProviderMetadata
// ---------------------------------------------------------------------------

describe("ProviderMetadata", () => {
  it("has all 17 known providers", () => {
    expect(PROVIDERS.length).toBeGreaterThanOrEqual(17);
    expect(PROVIDER_IDS).toContain("deepseek");
    expect(PROVIDER_IDS).toContain("openai");
    expect(PROVIDER_IDS).toContain("custom-openai");
    expect(PROVIDER_IDS).toContain("ollama");
  });

  it("every provider has required fields", () => {
    for (const p of PROVIDERS) {
      expect(p.id).toBeTruthy();
      expect(p.name).toBeTruthy();
      expect(["china", "overseas", "custom"]).toContain(p.tier);
      expect(typeof p.requiresApiKey).toBe("boolean");
    }
  });

  it("getProviderMeta returns metadata for known id", () => {
    const meta = getProviderMeta("deepseek");
    expect(meta).toBeDefined();
    expect(meta!.name).toBe("DeepSeek");
    expect(meta!.tier).toBe("china");
  });

  it("getProviderMeta returns undefined for unknown id", () => {
    expect(getProviderMeta("nonexistent")).toBeUndefined();
  });

  it("getProviderName returns display name or falls back to id", () => {
    expect(getProviderName("deepseek")).toBe("DeepSeek");
    expect(getProviderName("unknown")).toBe("unknown");
  });

  it("CHINA_PROVIDER_IDS contains only china-tier providers", () => {
    for (const id of CHINA_PROVIDER_IDS) {
      expect(getProviderMeta(id)!.tier).toBe("china");
    }
  });

  it("OVERSEAS_PROVIDER_IDS contains only overseas-tier providers", () => {
    for (const id of OVERSEAS_PROVIDER_IDS) {
      expect(getProviderMeta(id)!.tier).toBe("overseas");
    }
  });
});

// ---------------------------------------------------------------------------
// ModelResolver
// ---------------------------------------------------------------------------

describe("ModelResolver", () => {
  beforeEach(() => {
    initModelResolver({
      providers: {
        deepseek: { apiKey: "sk-deepseek-test" },
        openai: { apiKey: "sk-openai-test" },
        ollama: { baseUrl: "http://localhost:11434/v1" },
      },
    });
  });

  it("resolves registered China provider models", () => {
    const model = resolveModel("deepseek", "deepseek-chat");
    expect(model).toBeDefined();
    expect(model!.id).toBe("deepseek-chat");
    expect(model!.provider).toBe("deepseek");
  });

  it("resolves dynamic models for preset providers", () => {
    const model = resolveModel("ollama", "llama3.1");
    expect(model).toBeDefined();
    expect(model!.id).toBe("llama3.1");
    expect(model!.baseUrl).toContain("localhost");
  });

  it("returns undefined for unresolvable model", () => {
    const model = resolveModel("nonexistent", "foo");
    expect(model).toBeUndefined();
  });

  it("getApiKeyForProvider returns the configured key", () => {
    expect(getApiKeyForProvider("deepseek")).toBe("sk-deepseek-test");
  });

  it("getApiKeyForProvider returns undefined for unknown provider", () => {
    expect(getApiKeyForProvider("nonexistent")).toBeUndefined();
  });

  it("isProviderAvailable returns true when API key is set", () => {
    expect(isProviderAvailable("deepseek")).toBe(true);
  });

  it("isProviderAvailable returns true for local providers without key", () => {
    expect(isProviderAvailable("ollama")).toBe(true);
  });

  it("isProviderAvailable returns false for unconfigured provider", () => {
    expect(isProviderAvailable("groq")).toBe(false);
  });
});
