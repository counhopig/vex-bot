/**
 * System tool tests — current_time, calculator, delay.
 */

import { describe, it, expect, vi } from "vitest";

describe("createCurrentTimeTool", () => {
  let createCurrentTimeTool: () => any;

  beforeAll(async () => {
    ({ createCurrentTimeTool } = await import("../src/tools/builtin/system.js"));
  });

  it("has correct metadata", () => {
    const tool = createCurrentTimeTool();
    expect(tool.name).toBe("current_time");
    expect(tool.label).toBe("Current Time");
    expect(tool.description).toContain("current date and time");
  });

  it("returns current time as locale by default", async () => {
    const tool = createCurrentTimeTool();
    const result = await tool.execute("call-1", {});
    expect(result.details.status).toBe("success");
    expect(result.details.timezone).toBe("Asia/Shanghai");
    expect(typeof result.details.timestamp).toBe("number");
    expect(typeof result.details.iso).toBe("string");
    expect(typeof result.details.time).toBe("string");
  });

  it("returns unix timestamp when format=unix", async () => {
    const tool = createCurrentTimeTool();
    const result = await tool.execute("call-1", { format: "unix" });
    expect(typeof result.details.time).toBe("number");
  });

  it("returns ISO string when format=iso", async () => {
    const tool = createCurrentTimeTool();
    const result = await tool.execute("call-1", { format: "iso" });
    expect(result.details.time).toContain("T");
  });
});

describe("createCalculatorTool", () => {
  let createCalculatorTool: () => any;

  beforeAll(async () => {
    ({ createCalculatorTool } = await import("../src/tools/builtin/system.js"));
  });

  it("has correct metadata", () => {
    const tool = createCalculatorTool();
    expect(tool.name).toBe("calculator");
    expect(tool.label).toBe("Calculator");
  });

  it("evaluates a simple expression", async () => {
    const tool = createCalculatorTool();
    const result = await tool.execute("call-1", { expression: "2 + 2" });
    expect(result.details.status).toBe("success");
    expect(result.details.result).toBe(4);
  });

  it("supports math functions (sqrt)", async () => {
    const tool = createCalculatorTool();
    const result = await tool.execute("call-1", { expression: "sqrt(16)" });
    expect(result.details.result).toBe(4);
  });

  it("supports PI constant", async () => {
    const tool = createCalculatorTool();
    const result = await tool.execute("call-1", { expression: "PI" });
    expect(result.details.result).toBeCloseTo(Math.PI, 5);
  });

  it("returns error for invalid expression", async () => {
    const tool = createCalculatorTool();
    const result = await tool.execute("call-1", { expression: "1 + unknown" });
    expect(result.details.status).toBe("error");
  });

  it("rejects unsafe code (no eval bypass)", async () => {
    const tool = createCalculatorTool();
    // Attempting to execute arbitrary code should be rejected
    const result = await tool.execute("call-1", {
      expression: "process.exit()",
    });
    expect(result.details.status).toBe("error");
  });
});

describe("createDelayTool", () => {
  let createDelayTool: () => any;

  beforeAll(async () => {
    ({ createDelayTool } = await import("../src/tools/builtin/system.js"));
  });

  it("has correct metadata", () => {
    const tool = createDelayTool();
    expect(tool.name).toBe("delay");
    expect(tool.label).toBe("Delay");
  });

  it("waits for specified seconds", async () => {
    const tool = createDelayTool();
    const start = Date.now();
    const result = await tool.execute("call-1", { seconds: 0.1 });
    const elapsed = Date.now() - start;
    expect(result.details.status).toBe("success");
    expect(elapsed).toBeGreaterThanOrEqual(50); // at least ~50ms
    expect(result.details.requested).toBe(0.1);
  });

  it("respects abort signal", async () => {
    const tool = createDelayTool();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await expect(
      tool.execute("call-1", { seconds: 5 }, controller.signal),
    ).rejects.toThrow("aborted");
  });
});
