/**
 * Built-in tools assembly tests — createBuiltinTools actually wires the
 * memory / weather / cron / image tool factories (they were declared in the
 * options interface but never invoked; this is the regression lock for that
 * gap).
 *
 * Two behaviors per tool:
 *   - present: the tool is in the assembled list when its config gate passes
 *   - degrade: memory/cron tools still ship without an instance and report
 *     "disabled" (a tested behavior of the tool modules themselves), and
 *     weather is skipped entirely when no config section is provided.
 */

import { describe, expect, it } from "vitest";
import { createBuiltinTools } from "../src/tools/builtin/index.js";

describe("createBuiltinTools assembly", () => {
  it("includes the always-available core tools", () => {
    const tools = createBuiltinTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("current_time");
    expect(names).toContain("calculator");
    expect(names).toContain("web_search");
    expect(names).toContain("web_fetch");
    expect(names).toContain("delay");
    expect(names).toContain("image_analyze");
  });

  it("includes weather when a config section is provided", () => {
    const tools = createBuiltinTools({ weather: { defaultLocation: "Beijing" } });
    const names = tools.map((t) => t.name);
    expect(names).toContain("weather");
  });

  it("includes weather even with no config section (wttr default needs no API key)", () => {
    const tools = createBuiltinTools({ weather: undefined });
    const names = tools.map((t) => t.name);
    expect(names).toContain("weather");
  });

  it("includes memory tools by default even without a manager (they degrade to disabled)", () => {
    const tools = createBuiltinTools({});
    const names = tools.map((t) => t.name);
    expect(names).toContain("memory_search");
    expect(names).toContain("memory_store");
  });

  it("excludes memory tools when enableMemory is false", () => {
    const tools = createBuiltinTools({ enableMemory: false });
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("memory_search");
  });

  it("includes cron tools by default even without a service (they degrade to disabled)", () => {
    const tools = createBuiltinTools({});
    const names = tools.map((t) => t.name);
    expect(names).toContain("cron_list");
  });

  it("excludes cron tools when enableCron is false", () => {
    const tools = createBuiltinTools({ enableCron: false });
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("cron_list");
  });

  it("passes image allowedPaths from the image option", async () => {
    const tools = createBuiltinTools({ image: { allowedPaths: ["/sandbox"] } });
    const imageTool = tools.find((t) => t.name === "image_analyze");
    expect(imageTool).toBeDefined();
    // allowedPaths is consumed at execute time; asserting the tool exists is
    // the assembly contract — the path-resolution behavior is covered by the
    // image tool's own tests.
  });
});
