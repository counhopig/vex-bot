/**
 * Session title generation.
 *
 * `sanitizeTitle` is pure — strips markdown fences, surrounding quotes
 * (ASCII + CJK), and collapses whitespace. `generateSessionTitle`
 * delegates the LLM call to an injected function so the title module
 * stays testable offline without mocking pi-ai / ModelResolver. The
 * production call site (web/routes/sessions.ts, when built) passes a
 * function that wraps ModelResolver. The default `undefined` is
 * allowed — the function then returns null (caller falls back to a
 * derived default).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/logger.js", () => ({
  getChildLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  sanitizeTitle,
  generateSessionTitle,
  type LlmCompleteLike,
} from "../src/sessions/title.js";

describe("sessions/title", () => {
  describe("sanitizeTitle", () => {
    it("strips surrounding quotes and collapses whitespace", () => {
      expect(sanitizeTitle('  "深圳  租房\n讨论" ')).toBe("深圳 租房 讨论");
    });

    it("strips a markdown code fence", () => {
      expect(sanitizeTitle("```\n出行计划\n```")).toBe("出行计划");
    });

    it("strips CJK quotes", () => {
      expect(sanitizeTitle("「引号测试」")).toBe("引号测试");
    });

    it("truncates to maxLen", () => {
      expect(sanitizeTitle("a".repeat(50), 10)).toHaveLength(10);
    });

    it("returns an empty string for blank input", () => {
      expect(sanitizeTitle("   \n  ")).toBe("");
    });
  });

  describe("generateSessionTitle", () => {
    let llm: LlmCompleteLike;

    beforeEach(() => {
      llm = vi.fn();
    });

    it("summarizes the exchange into a sanitized title", async () => {
      vi.mocked(llm).mockResolvedValueOnce({ text: '"深圳租房建议"' });
      const title = await generateSessionTitle(
        {
          provider: "deepseek",
          model: "deepseek-chat",
          userText: "深圳怎么租房",
          assistantText: "可以从福田/南山看起……",
        },
        llm,
      );
      expect(title).toBe("深圳租房建议");
      expect(llm).toHaveBeenCalledTimes(1);
    });

    it("returns null when the LLM yields an empty title", async () => {
      vi.mocked(llm).mockResolvedValueOnce({ text: "   " });
      const title = await generateSessionTitle(
        {
          provider: "deepseek",
          model: "deepseek-chat",
          userText: "hi",
          assistantText: "hello",
        },
        llm,
      );
      expect(title).toBeNull();
    });

    it("returns null when the LLM throws", async () => {
      vi.mocked(llm).mockRejectedValueOnce(new Error("provider down"));
      const title = await generateSessionTitle(
        {
          provider: "deepseek",
          model: "deepseek-chat",
          userText: "hi",
          assistantText: "hello",
        },
        llm,
      );
      expect(title).toBeNull();
    });

    it("returns null when no llm function is injected", async () => {
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
