/**
 * Cron schedule tests — pure function computeNextRunAtMs.
 */

import { describe, it, expect, beforeAll } from "vitest";
import type { CronSchedule } from "../src/cron/types.js";

describe("computeNextRunAtMs — at", () => {
  let compute: (s: CronSchedule, now: number) => number | undefined;

  beforeAll(async () => {
    ({ computeNextRunAtMs: compute } = await import("../src/cron/schedule.js"));
  });

  it("returns atMs when in the future", () => {
    expect(compute({ kind: "at", atMs: 1000 }, 500)).toBe(1000);
  });

  it("returns undefined when atMs is in the past", () => {
    expect(compute({ kind: "at", atMs: 500 }, 1000)).toBeUndefined();
  });
});

describe("computeNextRunAtMs — every", () => {
  let compute: (s: CronSchedule, now: number) => number | undefined;

  beforeAll(async () => {
    ({ computeNextRunAtMs: compute } = await import("../src/cron/schedule.js"));
  });

  it("returns anchor when now < anchor", () => {
    expect(compute({ kind: "every", everyMs: 60_000, anchorMs: 1000 }, 500)).toBe(1000);
  });

  it("returns next step after anchor", () => {
    expect(compute({ kind: "every", everyMs: 60_000, anchorMs: 0 }, 30_000)).toBe(60_000);
  });

  it("snaps forward to next step boundary", () => {
    // anchor 0, every 60000, now 95000 -> next step is floor(95000/60000)+1 = 2, so anchor + 2*60000 = 120000
    expect(compute({ kind: "every", everyMs: 60_000, anchorMs: 0 }, 95_000)).toBe(120_000);
  });

  it("uses nowMs as anchor when no anchorMs given", () => {
    // With anchorMs undefined, anchor = nowMs (5000). The next tick is
    // the first interval boundary at nowMs + 1*everyMs.
    expect(compute({ kind: "every", everyMs: 1000 }, 5000)).toBe(6000);
  });

  it("returns undefined when everyMs <= 0", () => {
    expect(compute({ kind: "every", everyMs: 0 }, 1000)).toBeUndefined();
  });
});

describe("computeNextRunAtMs — cron", () => {
  let compute: (s: CronSchedule, now: number) => number | undefined;

  beforeAll(async () => {
    ({ computeNextRunAtMs: compute } = await import("../src/cron/schedule.js"));
  });

  it("returns next 5-field match", () => {
    // 5-field: "min hour day month weekday" — minute 30 every hour
    // Next match must be within 60 minutes.
    const now = Date.now();
    const next = compute({ kind: "cron", expr: "30 * * * *" }, now);
    expect(next).toBeDefined();
    expect(next!).toBeGreaterThan(now);
    expect(next! - now).toBeLessThanOrEqual(60 * 60 * 1000);
  });

  it("returns next 6-field match (with seconds)", () => {
    const now = Date.now();
    const next = compute({ kind: "cron", expr: "30 * * * * *" }, now);
    expect(next).toBeDefined();
    expect(next!).toBeGreaterThan(now);
    expect(next! - now).toBeLessThanOrEqual(60_000);
  });

  it("returns undefined for malformed expression (3 fields)", () => {
    const next = compute({ kind: "cron", expr: "* * *" }, Date.now());
    expect(next).toBeUndefined();
  });
});

describe("validateCronExpr", () => {
  let validate: (e: string) => { valid: boolean; error?: string };

  beforeAll(async () => {
    ({ validateCronExpr: validate } = await import("../src/cron/schedule.js"));
  });

  it("accepts 5-field expression that matches soon", () => {
    const r = validate("0 * * * *");
    expect(r.valid).toBe(true);
  });

  it("rejects 4-field expression", () => {
    const r = validate("* * * *");
    expect(r.valid).toBe(false);
  });

  it("rejects 7-field expression", () => {
    const r = validate("* * * * * * *");
    expect(r.valid).toBe(false);
  });
});

describe("formatSchedule", () => {
  let format: (s: CronSchedule) => string;

  beforeAll(async () => {
    ({ formatSchedule: format } = await import("../src/cron/schedule.js"));
  });

  it("formats 'at' with ISO timestamp", () => {
    expect(format({ kind: "at", atMs: 1700000000000 })).toContain("2023");
  });

  it("formats 'every' with seconds", () => {
    expect(format({ kind: "every", everyMs: 30_000 })).toBe("Every 30s");
  });

  it("formats 'every' with minutes", () => {
    expect(format({ kind: "every", everyMs: 5 * 60_000 })).toBe("Every 5m");
  });

  it("formats 'every' with hours", () => {
    expect(format({ kind: "every", everyMs: 2 * 3_600_000 })).toBe("Every 2h");
  });

  it("formats 'every' with days", () => {
    expect(format({ kind: "every", everyMs: 3 * 86_400_000 })).toBe("Every 3d");
  });

  it("formats 'cron' with expression", () => {
    expect(format({ kind: "cron", expr: "*/5 * * * *" })).toBe("Cron: */5 * * * *");
  });
});