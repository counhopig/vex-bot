import { readFile } from "node:fs/promises";
import { writeFileAtomic } from "../../store/atomic.js";

/**
 * The wiki's durable runtime data: backoff between failed runs and the bootstrap deferral the
 * owner's rejection set. Everything else — batch identity, the scan cursor, bootstrap progress,
 * pending rollbacks — is derived from git history by `reconcile`.
 */
export interface WikiState {
  failureStreak: number;
  nextAttemptAt: number | null;
  lastRunAt: number | null;
  /** The owner rejected a bootstrap preview; the next bootstrap waits for the cadence. */
  bootstrapDeferred?: true;
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

  const nextAttemptAt = candidate.nextAttemptAt;
  const lastRunAt = candidate.lastRunAt;
  const failureStreak = candidate.failureStreak;
  if (typeof failureStreak !== "number") return null;
  if (nextAttemptAt !== null && typeof nextAttemptAt !== "number") return null;
  if (lastRunAt !== null && typeof lastRunAt !== "number") return null;

  // Unknown extra fields — an older format's derived mirrors — are ignored, so a state file
  // written before the collapse keeps its backoff.
  return {
    failureStreak,
    nextAttemptAt: nextAttemptAt as number | null,
    lastRunAt: lastRunAt as number | null,
    ...(candidate.bootstrapDeferred === true ? { bootstrapDeferred: true as const } : {}),
  };
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
    failureStreak: 0,
    nextAttemptAt: null,
    lastRunAt: null,
  };
}
