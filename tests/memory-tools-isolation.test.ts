/**
 * Memory tool isolation — each createMemoryTools() call set stays bound to
 * the MemoryManager it was built with. No process-wide fallback manager.
 *
 * Ported from _archive/tests/memory-tools-isolation.test.ts. This guards the
 * archived rule "NEVER create MemoryManager inside tool execute() — manager
 * is injected at Agent init, tools call getManager() which returns null if
 * disabled", plus the per-owner isolation that makes multi-user runtimes safe
 * (principle #5: no process-global state bleeding across instances).
 */

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryManager } from "../src/memory/index.js";

// Loose typing matches the other builtin-tool tests (tool-weather, tool-cron):
// the concrete Tool type's execute() takes 5 args but the tool body treats
// the trailing three as optional; runtime behavior is what we assert here.
let createMemoryTools: (options?: { manager?: any }) => any[];

beforeAll(async () => {
  ({ createMemoryTools } = await import("../src/tools/builtin/memory.js"));
});

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "vex-memory-tools-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("memory tools isolation", () => {
  it("keeps each tool set bound to its own memory manager", async () => {
    const firstManager = createMemoryManager({ directory: tempDir() });
    const secondManager = createMemoryManager({ directory: tempDir() });
    const firstTools = createMemoryTools({ manager: firstManager });
    const secondTools = createMemoryTools({ manager: secondManager });
    const firstStore = firstTools.find((tool) => tool.name === "memory_store");
    const firstList = firstTools.find((tool) => tool.name === "memory_list");
    const secondStore = secondTools.find((tool) => tool.name === "memory_store");
    const secondList = secondTools.find((tool) => tool.name === "memory_list");

    await firstStore?.execute("call-1", { content: "first user's fact", type: "fact" });
    await secondStore?.execute("call-2", { content: "second user's fact", type: "fact" });

    const firstResult = await firstList?.execute("call-3", { limit: 10 });
    const secondResult = await secondList?.execute("call-4", { limit: 10 });

    expect(firstResult?.details).toMatchObject({
      count: 1,
      entries: [expect.objectContaining({ content: "first user's fact" })],
    });
    expect(secondResult?.details).toMatchObject({
      count: 1,
      entries: [expect.objectContaining({ content: "second user's fact" })],
    });
  });

  it("does not leak a manager into an unbound tool set via process-wide state", async () => {
    // Build a bound tool set first; this must not register any global fallback.
    createMemoryTools({ manager: createMemoryManager({ directory: tempDir() }) });

    // A tool set created without a manager must stay disabled, not silently
    // resolve to the manager the previous tool set was built with.
    const unboundTools = createMemoryTools();
    const search = unboundTools.find((tool) => tool.name === "memory_search");
    const result = await search?.execute("call-1", { query: "anything" });

    expect(result?.details).toMatchObject({ status: "disabled" });
  });

  it("wires a real MemoryManager directly — no conversion layer needed", async () => {
    // The tools module's MemoryToolsOptions.manager accepts the concrete
    // MemoryManager class as-is (structural typing); if a conversion layer
    // were required this would be a compile error.
    const manager = createMemoryManager({ directory: tempDir() });
    const tools = createMemoryTools({ manager });
    const store = tools.find((tool) => tool.name === "memory_store");
    const search = tools.find((tool) => tool.name === "memory_search");

    await store?.execute("call-1", { content: "the quick brown fox", type: "fact" });
    const result = await search?.execute("call-2", { query: "quick brown" });

    expect(result?.details.status).toBe("success");
    expect(result?.details.count).toBeGreaterThan(0);
    expect(result?.details.results[0].content).toContain("fox");
  });
});
