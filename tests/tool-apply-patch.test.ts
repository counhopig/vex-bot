/**
 * Apply-patch tool tests — createApplyPatchTool.
 */

import { describe, it, expect } from "vitest";

describe("createApplyPatchTool", () => {
  let createApplyPatchTool: (paths?: string[]) => any;

  beforeAll(async () => {
    ({ createApplyPatchTool } = await import(
      "../src/tools/builtin/apply-patch.js"
    ));
  });

  it("has correct metadata", () => {
    const tool = createApplyPatchTool();
    expect(tool.name).toBe("apply_patch");
    expect(tool.label).toBe("Apply Patch");
    expect(tool.description).toContain("unified diff");
  });

  it("returns error for empty/malformed patch", async () => {
    const tool = createApplyPatchTool();
    const result = await tool.execute("call-1", {
      patch: "not a valid patch at all",
    });
    expect(result.isError).toBe(true);
    expect(result.details.error).toContain("No valid patches");
  });
});
