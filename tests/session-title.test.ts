/**
 * Session title generation: an LLM summary of the first exchange, sanitized into
 * a short sidebar title. The LLM is mocked so the suite stays offline.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/logger.js", () => ({
  getChildLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("../src/providers/llm.js", async () => {
  const actual = await vi.importActual<typeof import("../src/providers/llm.js")>("../src/providers/llm.js");
  return { ...actual, llmComplete: vi.fn() };
});

import { llmComplete } from "../src/providers/llm.js";
import { sanitizeTitle, generateSessionTitle } from "../src/sessions/title.js";

const mockLlm = vi.mocked(llmComplete);

describe("sessions/title", () => {
  describe("sanitizeTitle", () => {
    it("strips surrounding quotes and collapses whitespace", () => {
      expect(sanitizeTitle('  "深圳  租房\n讨论" ')).toBe("深圳 租房 讨论");
    });

    it("strips a markdown code fence", () => {
      expect(sanitizeTitle("```\n出行计划\n```")).toBe("出行计划");
    });

    it("truncates to maxLen", () => {
      expect(sanitizeTitle("a".repeat(50), 10)).toHaveLength(10);
    });

    it("returns an empty string for blank input", () => {
      expect(sanitizeTitle("   \n  ")).toBe("");
    });
  });

  describe("generateSessionTitle", () => {
    beforeEach(() => mockLlm.mockReset());

    it("summarizes the exchange into a sanitized title", async () => {
      mockLlm.mockResolvedValueOnce({ text: '"深圳租房建议"' } as never);
      const title = await generateSessionTitle({
        provider: "deepseek",
        model: "deepseek-chat",
        userText: "深圳怎么租房",
        assistantText: "可以从福田/南山看起……",
      });
      expect(title).toBe("深圳租房建议");
      expect(mockLlm).toHaveBeenCalledTimes(1);
    });

    it("returns null when the LLM yields an empty title", async () => {
      mockLlm.mockResolvedValueOnce({ text: "   " } as never);
      const title = await generateSessionTitle({
        provider: "deepseek",
        model: "deepseek-chat",
        userText: "hi",
        assistantText: "hello",
      });
      expect(title).toBeNull();
    });

    it("returns null when the LLM throws", async () => {
      mockLlm.mockRejectedValueOnce(new Error("provider down"));
      const title = await generateSessionTitle({
        provider: "deepseek",
        model: "deepseek-chat",
        userText: "hi",
        assistantText: "hello",
      });
      expect(title).toBeNull();
    });
  });
});
