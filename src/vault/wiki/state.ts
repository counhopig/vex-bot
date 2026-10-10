import { readFile } from "node:fs/promises";
import { writeFileAtomic } from "../../store/atomic.js";

export interface WikiRollback {
  targetBatchId: string;
  revertId: string;
}

export interface WikiState {
  lastScanCommit: string | null;
  lastRunAt: number | null;
  lastBatchId: string | null;
  bootstrap: "pending" | "done";
  rollback: WikiRollback | null;
  nextAttemptAt: number | null;
  failureStreak: number;
}

function isRollback(value: unknown): value is WikiRollback {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { targetBatchId?: unknown; revertId?: unknown };
  return typeof candidate.targetBatchId === "string" && typeof candidate.revertId === "string";
}

function nullableString(value: unknown): string | null | undefined {
  return value === null || typeof value === "string" ? value : undefined;
}

function nullableNumber(value: unknown): number | null | undefined {
  return value === null || typeof value === "number" ? value : undefined;
}

function parseState(text: string): WikiState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;

  const lastScanCommit = nullableString(candidate.lastScanCommit);
  const lastRunAt = nullableNumber(candidate.lastRunAt);
  const lastBatchId = nullableString(candidate.lastBatchId);
  const nextAttemptAt = nullableNumber(candidate.nextAttemptAt);
  const bootstrap = candidate.bootstrap;
  const failureStreak = candidate.failureStreak;
  const rollback = candidate.rollback;

  if (lastScanCommit === undefined) return null;
  if (lastRunAt === undefined) return null;
  if (lastBatchId === undefined) return null;
  if (nextAttemptAt === undefined) return null;
  if (bootstrap !== "pending" && bootstrap !== "done") return null;
  if (typeof failureStreak !== "number") return null;
  if (rollback !== null && !isRollback(rollback)) return null;

  return { lastScanCommit, lastRunAt, lastBatchId, bootstrap, rollback, nextAttemptAt, failureStreak };
}

/**
 * The wiki's durable cursor and bootstrap/rollback pointers, stored outside the
 * vault so it is never committed. The wiki lock serializes access, so this store
 * does no locking of its own.
 */
export class StateStore {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async read(): Promise<WikiState | null> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    return parseState(text);
  }

  async write(state: WikiState): Promise<void> {
    await writeFileAtomic(this.path, `${JSON.stringify(state, null, 2)}\n`, 0o600, 0o700);
  }
}

export function emptyState(): WikiState {
  return {
    lastScanCommit: null,
    lastRunAt: null,
    lastBatchId: null,
    bootstrap: "pending",
    rollback: null,
    nextAttemptAt: null,
    failureStreak: 0,
  };
}
