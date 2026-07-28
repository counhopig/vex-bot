/**
 * Image tool tests — createImageAnalyzeTool.
 */

import { describe, it, expect, vi } from "vitest";

describe("createImageAnalyzeTool", () => {
  let createImageAnalyzeTool: (options?: any) => any;

  beforeAll(async () => {
    ({ createImageAnalyzeTool } = await import(
      "../src/tools/builtin/image.js"
    ));
  });

  it("has correct metadata", () => {
    const tool = createImageAnalyzeTool();
    expect(tool.name).toBe("image_analyze");
    expect(tool.label).toBe("Image Analyze");
    expect(tool.description).toContain("Analyze");
  });

  it("returns error when no API key configured", async () => {
    // Save and clear any existing API keys
    const prevKimi = process.env.KIMI_API_KEY;
    const prevMinimax = process.env.MINIMAX_API_KEY;
    delete process.env.KIMI_API_KEY;
    delete process.env.MINIMAX_API_KEY;

    try {
      const tool = createImageAnalyzeTool();
      const result = await tool.execute("call-1", {
        image: "data:image/png;base64,iVBORw0KGgo=",
      });
      expect(result.isError).toBe(true);
      expect(result.details.error).toContain("No vision-capable");
    } finally {
      if (prevKimi) process.env.KIMI_API_KEY = prevKimi;
      if (prevMinimax) process.env.MINIMAX_API_KEY = prevMinimax;
    }
  });
});
