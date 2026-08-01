/**
 * Utils tests — generateId / delay / retry.
 *
 * Only these three are ported per the rewrite plan (`utils/index.ts` keeps
 * generateId/delay/retry; the other archive helpers were dead code in the
 * barrel — see AGENTS.md cross-cutting concern "Unused utils").
 */

import { describe, it, expect, vi } from "vitest";
import { generateId, delay, retry } from "../src/utils/index.js";

describe("utils/index", () => {
  describe("generateId", () => {
    it("generates a random hex string", () => {
      expect(generateId()).toMatch(/^[a-f0-9]{16}$/);
    });

    it("generates unique IDs", () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateId()));
      expect(ids.size).toBe(100);
    });

    it("adds a prefix when provided", () => {
      expect(generateId("msg")).toMatch(/^msg_[a-f0-9]{16}$/);
    });
  });

  describe("delay", () => {
    it("delays execution", async () => {
      const start = Date.now();
      await delay(50);
      expect(Date.now() - start).toBeGreaterThanOrEqual(45);
    });
  });

  describe("retry", () => {
    it("returns the result on first success", async () => {
      const fn = vi.fn().mockResolvedValue("success");
      expect(await retry(fn)).toBe("success");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("retries on failure", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("fail"))
        .mockResolvedValue("success");
      expect(await retry(fn, { delayMs: 10 })).toBe("success");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("throws after max retries", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("always fail"));
      await expect(retry(fn, { maxRetries: 2, delayMs: 10 })).rejects.toThrow(
        "always fail",
      );
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("calls the onRetry callback", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("fail"))
        .mockResolvedValue("success");
      const onRetry = vi.fn();
      await retry(fn, { delayMs: 10, onRetry });
      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(onRetry).toHaveBeenCalledWith(expect.any(Error), 1);
    });

    it("applies exponential backoff", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("fail"))
        .mockRejectedValueOnce(new Error("fail"))
        .mockResolvedValue("success");

      const start = Date.now();
      await retry(fn, { delayMs: 20, backoff: true });
      // First retry waits 20ms, second waits 40ms.
      expect(Date.now() - start).toBeGreaterThanOrEqual(50);
    });
  });
});
