import { describe, it, expect, vi } from "vitest";

vi.mock("../src/utils/logger.js", () => ({
  getChildLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  resolveBindHost,
  MessageDeduplicator,
  runShutdownSteps,
  createKeyedSerializer,
} from "../src/gateway/server.js";

describe("resolveBindHost", () => {
  it("defaults to loopback (not 0.0.0.0) when host is unset or blank", () => {
    expect(resolveBindHost(undefined)).toBe("127.0.0.1");
    expect(resolveBindHost("")).toBe("127.0.0.1");
    expect(resolveBindHost("   ")).toBe("127.0.0.1");
  });

  it("honors an explicit host, including 0.0.0.0", () => {
    expect(resolveBindHost("0.0.0.0")).toBe("0.0.0.0");
    expect(resolveBindHost("127.0.0.1")).toBe("127.0.0.1");
    expect(resolveBindHost("192.168.1.5")).toBe("192.168.1.5");
  });
});

describe("MessageDeduplicator", () => {
  it("reports first sight as new and repeats as duplicate", () => {
    const dedup = new MessageDeduplicator({ maxKeys: 100 });
    expect(dedup.isDuplicate("a")).toBe(false);
    expect(dedup.isDuplicate("a")).toBe(true);
    expect(dedup.isDuplicate("b")).toBe(false);
  });

  it("fails open instead of throwing when the cache is full", () => {
    const dedup = new MessageDeduplicator({ maxKeys: 1 });
    expect(dedup.isDuplicate("first")).toBe(false); // records; cache now full
    // Recording "second" would throw ECACHEFULL inside NodeCache.set — must be
    // swallowed and treated as non-duplicate rather than crashing the caller.
    expect(() => dedup.isDuplicate("second")).not.toThrow();
    expect(dedup.isDuplicate("second")).toBe(false);
  });
});

describe("runShutdownSteps", () => {
  it("runs every step even when one throws", async () => {
    const calls: string[] = [];
    await runShutdownSteps([
      { label: "a", run: () => { calls.push("a"); } },
      { label: "b", run: () => { throw new Error("boom"); } },
      { label: "c", run: async () => { calls.push("c"); } },
    ]);
    expect(calls).toEqual(["a", "c"]);
  });
});

describe("createKeyedSerializer", () => {
  it("serializes tasks for the same key and isolates different keys", async () => {
    const serialize = createKeyedSerializer();
    const order: string[] = [];
    const slow = serialize("u1", async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push("u1-slow");
    });
    const fast = serialize("u1", async () => {
      order.push("u1-fast");
    });
    const other = serialize("u2", async () => {
      order.push("u2");
    });
    await Promise.all([slow, fast, other]);
    // u1-fast must wait for u1-slow despite finishing sooner; u2 is independent.
    expect(order.indexOf("u1-slow")).toBeLessThan(order.indexOf("u1-fast"));
    expect(order).toContain("u2");
  });
});
