/**
 * Memory tool tests — createMemoryTools.
 */

import { describe, it, expect } from "vitest";

describe("createMemoryTools", () => {
  let createMemoryTools: (options?: any) => any[];

  beforeAll(async () => {
    ({ createMemoryTools } = await import(
      "../src/tools/builtin/memory.js"
    ));
  });

  it("returns 4 tools when called without manager", () => {
    const tools = createMemoryTools();
    expect(tools).toHaveLength(4);
    expect(tools.map((t: any) => t.name).sort()).toEqual([
      "memory_delete",
      "memory_list",
      "memory_search",
      "memory_store",
    ]);
  });

  it("each tool returns disabled status when manager is undefined", async () => {
    const tools = createMemoryTools();
    for (const tool of tools) {
      // Try a minimal execute call for each tool
      const result = await tool.execute("call-1", {});
      expect(result.details.status).toBe("disabled");
      expect(result.details.message).toContain("not enabled");
    }
  });
});
