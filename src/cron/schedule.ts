/**
 * Cron job schedule calculation
 *
 * Based on moltbot schedule.ts implementation
 * Supports next run time calculation for three scheduling modes
 */

import type { CronSchedule, CronJob } from "./types.js";

/**
 * Simple Cron expression parser
 *
 * Supports standard 5-field format: min hour day month weekday
 * Supports 6-field format: sec min hour day month weekday
 * Supports: numbers, *, commas, hyphens, slashes
 */
function parseCronField(field: string, min: number, max: number): number[] {
  const values: Set<number> = new Set();

  for (const part of field.split(",")) {
    const trimmed = part.trim();

    // Slash: */2, 1-10/3
    if (trimmed.includes("/")) {
      const [rangePart, stepStr] = trimmed.split("/");
      const step = parseInt(stepStr!, 10);
      if (isNaN(step) || step <= 0) continue;

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

      for (let i = start; i <= end; i += step) {
        values.add(i);
      }
    }
    // Range: 1-5
    else if (trimmed.includes("-")) {
      const [a, b] = trimmed.split("-");
      const start = parseInt(a!, 10);
      const end = parseInt(b!, 10);
      for (let i = start; i <= end; i++) {
        values.add(i);
      }
    }
    // Wildcard
    else if (trimmed === "*") {
      for (let i = min; i <= max; i++) {
        values.add(i);
      }
    }
    // Single value
    else {
      const val = parseInt(trimmed, 10);
      if (!isNaN(val) && val >= min && val <= max) {
        values.add(val);
      }
    }
  }

  return Array.from(values).sort((a, b) => a - b);
}

/**
 * Calculate next run time for Cron expression
 */
function computeNextCronRun(expr: string, nowMs: number, tz?: string): number | undefined {
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
    // min hour day month weekday
    seconds = [0];
    minutes = parseCronField(parts[0]!, 0, 59);
    hours = parseCronField(parts[1]!, 0, 23);
    days = parseCronField(parts[2]!, 1, 31);
    months = parseCronField(parts[3]!, 1, 12);
    weekdays = parseCronField(parts[4]!, 0, 6);
  } else {
    return undefined;
  }

  // Search from now+1s, up to 2 years
  const maxSearch = nowMs + 2 * 365 * 24 * 60 * 60 * 1000;
  const now = new Date(nowMs);

  // Start from current minute, search minute by minute
  let candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(),
    now.getHours(), now.getMinutes(), now.getSeconds() + 1);

  while (candidate.getTime() < maxSearch) {
    const month = candidate.getMonth() + 1;  // 1-12
    const day = candidate.getDate();
    const weekday = candidate.getDay();       // 0-6
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

    // Optimize search step
    if (!months.includes(month)) {
      // Skip to next month
      candidate = new Date(candidate.getFullYear(), candidate.getMonth() + 1, 1);
    } else if (!days.includes(day) || !weekdays.includes(weekday)) {
      // Skip to next day
      candidate = new Date(candidate.getFullYear(), candidate.getMonth(), candidate.getDate() + 1);
    } else if (!hours.includes(hour)) {
      // Skip to next hour
      candidate = new Date(candidate.getFullYear(), candidate.getMonth(), candidate.getDate(),
        candidate.getHours() + 1, 0, 0);
    } else if (!minutes.includes(minute)) {
      // Skip to next minute
      candidate = new Date(candidate.getFullYear(), candidate.getMonth(), candidate.getDate(),
        candidate.getHours(), candidate.getMinutes() + 1, 0);
    } else {
      // Skip to next second
      candidate = new Date(candidate.getTime() + 1000);
    }
  }

  return undefined;
}

/**
 * Calculate next run time
 */
export function computeNextRunAtMs(schedule: CronSchedule, nowMs: number): number | undefined {
  switch (schedule.kind) {
    case "at":
      // One-time job: return undefined if time has passed
      return schedule.atMs > nowMs ? schedule.atMs : undefined;

    case "every": {
      // Periodic job: anchor-based step alignment
      const anchor = schedule.anchorMs ?? nowMs;
      const everyMs = schedule.everyMs;

      if (everyMs <= 0) return undefined;

      if (nowMs < anchor) {
        return anchor;
      }

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

/**
 * Calculate next run time for job
 */
export function computeJobNextRunAtMs(job: CronJob, nowMs: number): number | undefined {
  if (!job.enabled) return undefined;
  return computeNextRunAtMs(job.schedule, nowMs);
}

/**
 * Validate Cron expression
 */
export function validateCronExpr(expr: string): { valid: boolean; error?: string } {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5 && parts.length !== 6) {
    return { valid: false, error: `Expected 5 or 6 fields, got ${parts.length}` };
  }

  // Try calculating next time
  const next = computeNextCronRun(expr, Date.now());
  if (!next) {
    return { valid: false, error: "Expression never matches (within 2 years)" };
  }

  return { valid: true };
}

/**
 * Format schedule information
 */
export function formatSchedule(schedule: CronSchedule): string {
  switch (schedule.kind) {
    case "at":
      return `Once at ${new Date(schedule.atMs).toISOString()}`;
    case "every": {
      const ms = schedule.everyMs;
      if (ms >= 86400000) return `Every ${Math.round(ms / 86400000)}d`;
      if (ms >= 3600000) return `Every ${Math.round(ms / 3600000)}h`;
      if (ms >= 60000) return `Every ${Math.round(ms / 60000)}m`;
      return `Every ${Math.round(ms / 1000)}s`;
    }
    case "cron":
      return `Cron: ${schedule.expr}${schedule.tz ? ` (${schedule.tz})` : ""}`;
    default:
      return "Unknown schedule";
  }
}
