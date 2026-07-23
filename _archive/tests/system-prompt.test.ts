import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSystemPrompt } from "../src/agents/system-prompt.js";

describe("agents/system-prompt", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  describe("base identity", () => {
    it("uses a neutral, language-agnostic default identity (not a coding/English-only one)", () => {
      const prompt = buildSystemPrompt({ includeEnvironment: false, includeToolRules: false });
      expect(prompt).not.toContain("programming assistant");
      expect(prompt).not.toContain("respond in English");
      // Still asserts *some* helpful-assistant identity when nothing else supplies one.
      expect(prompt).toContain("helpful");
    });

    it("omits the default identity entirely when omitDefaultIdentity is set (persona supplies it)", () => {
      const prompt = buildSystemPrompt({
        includeEnvironment: false,
        includeToolRules: false,
        omitDefaultIdentity: true,
      });
      expect(prompt).not.toContain("programming assistant");
      expect(prompt).not.toContain("You are a helpful");
    });

    it("keeps an explicit basePrompt even when omitDefaultIdentity is set", () => {
      const prompt = buildSystemPrompt({
        basePrompt: "你是喵酱。",
        includeEnvironment: false,
        includeToolRules: false,
        omitDefaultIdentity: true,
      });
      expect(prompt).toContain("你是喵酱。");
    });
  });

  it("should render current time in China timezone by default", () => {
    // Given: the server process runs in UTC, while the bot targets Chinese users.
    vi.stubEnv("TZ", "UTC");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-26T15:07:00.000Z"));

    // When: a prompt is built with environment time enabled.
    const prompt = buildSystemPrompt({
      includeEnvironment: true,
      includeDateTime: true,
      includeToolRules: false,
    });

    // Then: the injected current time uses UTC+8, not the host timezone.
    expect(prompt).toContain("Current time (Asia/Shanghai):");
    expect(prompt).toContain("23:07");
    expect(prompt).not.toContain("15:07");
  });
});
