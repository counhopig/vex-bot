/**
 * Cron schedule calculation.
 *
 * Pure functions — `computeNextRunAtMs(schedule, nowMs)` returns the
 * next run timestamp (or undefined if the schedule has expired/no
 * future match exists). No I/O, no clock reads.
 *
 * Ported verbatim from _archive/src/cron/schedule.ts; the 5/6-field
 * parser is preserved exactly.
 */

import type { CronJob, CronSchedule } from "./types.js";

/**
 * Parse a single cron field (wildcard, ranges, lists, step values)
 * into the sorted set of matching values.
 */
function parseCronField(field: string, min: number, max: number): number[] {
  const values: Set<number> = new Set();

  for (const part of field.split(",")) {
    const trimmed = part.trim();

    if (trimmed.includes("/")) {
      const [rangePart, stepStr] = trimmed.split("/");
      const step = parseInt(stepStr!, 10);
      if (Number.isNaN(step) || step <= 0) continue;

      let start = min;
      let end = max;
      if (rangePart !== "*") {
        if (rangePart!.includes("-")) {
          const [a, b] = rangePart!.split("-");
          start = parseInt(a!, 10);
          end = parseInt(b!, 10);
        } else {
          start = parseInt(rangePart!, 10);
        }
      }
      for (let i = start; i <= end; i += step) values.add(i);
    } else if (trimmed.includes("-")) {
      const [a, b] = trimmed.split("-");
      const start = parseInt(a!, 10);
      const end = parseInt(b!, 10);
      for (let i = start; i <= end; i++) values.add(i);
    } else if (trimmed === "*") {
      for (let i = min; i <= max; i++) values.add(i);
    } else {
      const val = parseInt(trimmed, 10);
      if (!Number.isNaN(val) && val >= min && val <= max) values.add(val);
    }
  }

  return Array.from(values).sort((a, b) => a - b);
}

/**
 * Compute the next run time for a Cron expression. Returns undefined
 * when no match is found within a 2-year window.
 */
function computeNextCronRun(
  expr: string,
  nowMs: number,
  _tz?: string,
): number | undefined {
  const parts = expr.trim().split(/\s+/);
  let seconds: number[], minutes: number[], hours: number[],
    days: number[], months: number[], weekdays: number[];

  if (parts.length === 6) {
    // sec min hour day month weekday
    seconds = parseCronField(parts[0]!, 0, 59);
    minutes = parseCronField(parts[1]!, 0, 59);
    hours = parseCronField(parts[2]!, 0, 23);
    days = parseCronField(parts[3]!, 1, 31);
    months = parseCronField(parts[4]!, 1, 12);
    weekdays = parseCronField(parts[5]!, 0, 6);
  } else if (parts.length === 5) {
    // min hour day month weekday (second = 0)
    seconds = [0];
    minutes = parseCronField(parts[0]!, 0, 59);
    hours = parseCronField(parts[1]!, 0, 23);
    days = parseCronField(parts[2]!, 1, 31);
    months = parseCronField(parts[3]!, 1, 12);
    weekdays = parseCronField(parts[4]!, 0, 6);
  } else {
    return undefined;
  }

  // Search from now+1s up to 2 years.
  const maxSearch = nowMs + 2 * 365 * 24 * 60 * 60 * 1000;
  const now = new Date(nowMs);
  let candidate = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    now.getHours(),
    now.getMinutes(),
    now.getSeconds() + 1,
  );

  while (candidate.getTime() < maxSearch) {
    const month = candidate.getMonth() + 1;
    const day = candidate.getDate();
    const weekday = candidate.getDay();
    const hour = candidate.getHours();
    const minute = candidate.getMinutes();
    const second = candidate.getSeconds();

    if (
      months.includes(month) &&
      days.includes(day) &&
      weekdays.includes(weekday) &&
      hours.includes(hour) &&
      minutes.includes(minute) &&
      seconds.includes(second)
    ) {
      return candidate.getTime();
    }

    // Optimize search step.
    if (!months.includes(month)) {
      candidate = new Date(candidate.getFullYear(), candidate.getMonth() + 1, 1);
    } else if (!days.includes(day) || !weekdays.includes(weekday)) {
      candidate = new Date(
        candidate.getFullYear(),
        candidate.getMonth(),
        candidate.getDate() + 1,
      );
    } else if (!hours.includes(hour)) {
      candidate = new Date(
        candidate.getFullYear(),
        candidate.getMonth(),
        candidate.getDate(),
        candidate.getHours() + 1,
        0,
        0,
      );
    } else if (!minutes.includes(minute)) {
      candidate = new Date(
        candidate.getFullYear(),
        candidate.getMonth(),
        candidate.getDate(),
        candidate.getHours(),
        candidate.getMinutes() + 1,
        0,
      );
    } else {
      candidate = new Date(candidate.getTime() + 1000);
    }
  }

  return undefined;
}

/** Compute next run time for any CronSchedule, given a nowMs clock. */
export function computeNextRunAtMs(
  schedule: CronSchedule,
  nowMs: number,
): number | undefined {
  switch (schedule.kind) {
    case "at":
      return schedule.atMs > nowMs ? schedule.atMs : undefined;

    case "every": {
      const anchor = schedule.anchorMs ?? nowMs;
      const everyMs = schedule.everyMs;
      if (everyMs <= 0) return undefined;
      if (nowMs < anchor) return anchor;
      const elapsed = nowMs - anchor;
      const steps = Math.floor(elapsed / everyMs) + 1;
      return anchor + steps * everyMs;
    }

    case "cron":
      return computeNextCronRun(schedule.expr, nowMs, schedule.tz);

    default:
      return undefined;
  }
}

/** Compute next run time for a full CronJob (respects enabled). */
export function computeJobNextRunAtMs(
  job: CronJob,
  nowMs: number,
): number | undefined {
  if (!job.enabled) return undefined;
  return computeNextRunAtMs(job.schedule, nowMs);
}

/** Validate a Cron expression — checks it has 5 or 6 fields and a
 *  future match can be found. */
export function validateCronExpr(
  expr: string,
): { valid: boolean; error?: string } {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5 && parts.length !== 6) {
    return { valid: false, error: `Expected 5 or 6 fields, got ${parts.length}` };
  }
  const next = computeNextCronRun(expr, Date.now());
  if (!next) {
    return { valid: false, error: "Expression never matches (within 2 years)" };
  }
  return { valid: true };
}

/** Human-readable schedule string. */
export function formatSchedule(schedule: CronSchedule): string {
  switch (schedule.kind) {
    case "at":
      return `Once at ${new Date(schedule.atMs).toISOString()}`;
    case "every": {
      const ms = schedule.everyMs;
      if (ms >= 86_400_000) return `Every ${Math.round(ms / 86_400_000)}d`;
      if (ms >= 3_600_000) return `Every ${Math.round(ms / 3_600_000)}h`;
      if (ms >= 60_000) return `Every ${Math.round(ms / 60_000)}m`;
      return `Every ${Math.round(ms / 1000)}s`;
    }
    case "cron":
      return `Cron: ${schedule.expr}${schedule.tz ? ` (${schedule.tz})` : ""}`;
    default:
      return "Unknown schedule";
  }
}