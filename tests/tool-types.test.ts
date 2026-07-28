/**
 * Tool types tests — re-exports, TOOL_GROUPS, createToolResult,
 * createErrorToolResult.
 */

import { describe, it, expect } from "vitest";

describe("TOOL_GROUPS", () => {
  it("has group:web with web_search, web_fetch, weather", async () => {
    // Dynamic import to avoid hoisting issues with .js extensions
    const { TOOL_GROUPS } = await import("../src/tools/types.js");
    expect(TOOL_GROUPS["group:web"]).toEqual(["web_search", "web_fetch", "weather"]);
  });

  it("has group:memory with memory_search, memory_store", async () => {
    const { TOOL_GROUPS } = await import("../src/tools/types.js");
    expect(TOOL_GROUPS["group:memory"]).toEqual(["memory_search", "memory_store"]);
  });

  it("has group:media with image_analyze", async () => {
    const { TOOL_GROUPS } = await import("../src/tools/types.js");
    expect(TOOL_GROUPS["group:media"]).toEqual(["image_analyze"]);
  });

  it("has group:system with current_time, calculator", async () => {
    const { TOOL_GROUPS } = await import("../src/tools/types.js");
    expect(TOOL_GROUPS["group:system"]).toEqual(["current_time", "calculator"]);
  });
});

describe("createToolResult", () => {
  it("returns a success result with text content", async () => {
    const { createToolResult } = await import("../src/tools/types.js");
    const result = createToolResult("hello world", { count: 5 });
    expect(result.content).toEqual([{ type: "text", text: "hello world" }]);
    expect(result.details).toEqual({ count: 5 });
    expect(result.isError).toBe(false);
  });

  it("returns an error result when isError is true", async () => {
    const { createToolResult } = await import("../src/tools/types.js");
    const result = createToolResult("oops", { err: true }, true);
    expect(result.content).toEqual([{ type: "text", text: "oops" }]);
    expect(result.isError).toBe(true);
  });
});

describe("createErrorToolResult", () => {
  it("returns a structured error result", async () => {
    const { createErrorToolResult } = await import("../src/tools/types.js");
    const result = createErrorToolResult("Something went wrong");
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify({ status: "error", error: "Something went wrong" }, null, 2) },
    ]);
    expect(result.details).toEqual({ status: "error", error: "Something went wrong" });
    expect(result.isError).toBe(true);
  });
});
