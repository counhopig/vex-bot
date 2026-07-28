/**
 * Cron tool tests — createCronTools.
 */

import { describe, it, expect } from "vitest";

describe("createCronTools", () => {
  let createCronTools: (options?: any) => any[];

  beforeAll(async () => {
    ({ createCronTools } = await import(
      "../src/tools/builtin/cron.js"
    ));
  });

  it("returns 5 tools when called without service", () => {
    const tools = createCronTools();
    expect(tools).toHaveLength(5);
    expect(tools.map((t: any) => t.name).sort()).toEqual([
      "cron_add",
      "cron_list",
      "cron_remove",
      "cron_run",
      "cron_update",
    ]);
  });

  it("each tool returns disabled status when service is undefined", async () => {
    const tools = createCronTools();
    for (const tool of tools) {
      const result = await tool.execute("call-1", {});
      expect(result.details.status).toBe("disabled");
      expect(result.details.message).toContain("not enabled");
    }
  });
});
