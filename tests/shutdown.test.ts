import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../src/logger.js";
import { ShutdownPlan } from "../src/shutdown.js";

describe("ShutdownPlan", () => {
  it("releases registered resources in the fixed order whatever the registration order", async () => {
    const log = { error: vi.fn() } as unknown as Logger;
    const plan = new ShutdownPlan(log);
    const closed: string[] = [];
    plan.add("traces", () => { closed.push("traces"); });
    plan.add("memory index", () => { closed.push("memory index"); });
    plan.add("scheduler", () => { closed.push("scheduler"); });
    plan.add("sessions", () => { closed.push("sessions"); });
    await plan.run();
    expect(closed).toEqual(["scheduler", "sessions", "memory index", "traces"]);
  });

  it("logs a failing step and still releases the rest", async () => {
    const log = { error: vi.fn() } as unknown as Logger;
    const plan = new ShutdownPlan(log);
    const closed: string[] = [];
    plan.add("gateway", async () => { throw new Error("busy"); });
    plan.add("wiki", () => { closed.push("wiki"); });
    await plan.run();
    expect(closed).toEqual(["wiki"]);
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ step: "gateway" }), "shutdown step failed");
  });
});
