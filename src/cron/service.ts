/**
 * Cron service — scheduling loop and job lifecycle.
 *
 * Class-based (no singleton) — the archive's `getCronService()` module-level
 * singleton is gone. Each Agent (or app instance) gets its own CronService.
 *
 * Schema change from archive: `CronJob.ownerId` is required for any
 * agentTurn payload; the executor (a separate file) routes through
 * `Dispatcher.dispatchSynthetic()` using `ownerId` as `webUserId`.
 *
 * The scheduler loop uses `setTimeout` (re-arming) and `unref()` so it
 * never prevents process exit — same pattern as the archive, since the
 * Node timer APIs are stable here.
 */

import { randomUUID } from "crypto";
import type {
  CronJob,
  CronJobCreate,
  CronJobUpdate,
  CronServiceDeps,
  CronEvent,
  CronEventAction,
  CronExecutionResult,
} from "./types.js";
import { STUCK_RUN_MS } from "./types.js";
import { CronStore } from "./store.js";
import { computeJobNextRunAtMs } from "./schedule.js";

/** Max safe setTimeout (~24.8 days). */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/** Default per-job timeout (10 minutes) when no payload.timeoutSeconds. */
const DEFAULT_JOB_TIMEOUT_MS = 10 * 60 * 1000;

/** Reject promise if it doesn't settle within `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Job execution timed out after ${ms}ms`)),
      ms,
    );
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class CronService {
  private readonly deps: Required<CronServiceDeps>;
  private readonly _store: CronStore;
  private timer: NodeJS.Timeout | null = null;
  private running: boolean = false;
  private started: boolean = false;

  /** Test/bootstrap handle to the underlying store. */
  get store(): CronStore {
    return this._store;
  }

  constructor(deps?: CronServiceDeps) {
    this.deps = {
      nowMs: deps?.nowMs ?? (() => Date.now()),
      storePath: deps?.storePath ?? "",
      enabled: deps?.enabled ?? true,
      executeJob:
        deps?.executeJob ?? (async () => ({ status: "ok" as const })),
      onEvent: deps?.onEvent ?? (() => {}),
      defaultJobTimeoutMs:
        deps?.defaultJobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS,
    };
    this._store = new CronStore(this.deps.storePath || undefined);
  }

  /** Start the scheduler — call once after all jobs are loaded. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.recomputeAllNextRuns();
    if (this.deps.enabled) this.armTimer();
  }

  /** Stop the scheduler; clears the pending timer. */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  list(options?: { includeDisabled?: boolean }): CronJob[] {
    const includeDisabled = options?.includeDisabled ?? false;
    const jobs = this._store.getJobs();
    return (includeDisabled ? jobs : jobs.filter((j) => j.enabled))
      .sort(
        (a, b) =>
          (a.state.nextRunAtMs ?? Infinity) - (b.state.nextRunAtMs ?? Infinity),
      );
  }

  get(id: string): CronJob | undefined {
    return this._store.getJob(id);
  }

  getByName(name: string): CronJob | undefined {
    return this._store.getJobByName(name);
  }

  add(input: CronJobCreate): CronJob {
    if (this._store.getJobByName(input.name)) {
      throw new Error(`A cron job named "${input.name}" already exists`);
    }
    const now = this.deps.nowMs();
    const job: CronJob = {
      id: randomUUID(),
      name: input.name,
      description: input.description,
      enabled: input.enabled ?? true,
      schedule: input.schedule,
      payload: input.payload,
      deleteAfterRun: input.deleteAfterRun,
      createdAtMs: now,
      updatedAtMs: now,
      state: {},
      ownerId: input.ownerId,
    };

    job.state.nextRunAtMs = computeJobNextRunAtMs(job, now);

    this._store.addJob(job);
    this._store.persist();

    this.emit(job.id, "added", { nextRunAtMs: job.state.nextRunAtMs });
    this.armTimer();

    return job;
  }

  update(id: string, patch: CronJobUpdate): CronJob | undefined {
    const job = this._store.getJob(id);
    if (!job) return undefined;

    const now = this.deps.nowMs();

    if (patch.name !== undefined) job.name = patch.name;
    if (patch.description !== undefined) job.description = patch.description;
    if (patch.enabled !== undefined) job.enabled = patch.enabled;
    if (patch.schedule !== undefined) job.schedule = patch.schedule;
    if (patch.deleteAfterRun !== undefined) job.deleteAfterRun = patch.deleteAfterRun;

    if (patch.payload) {
      if (patch.payload.kind && patch.payload.kind !== job.payload.kind) {
        job.payload = patch.payload as typeof job.payload;
      } else {
        Object.assign(job.payload, patch.payload);
      }
    }

    job.updatedAtMs = now;
    job.state.nextRunAtMs = computeJobNextRunAtMs(job, now);

    this._store.updateJob(id, job);
    this._store.persist();

    this.emit(job.id, "updated", { nextRunAtMs: job.state.nextRunAtMs });
    this.armTimer();

    return job;
  }

  remove(id: string): boolean {
    const removed = this._store.removeJob(id);
    if (removed) {
      this._store.persist();
      this.emit(id, "removed");
      this.armTimer();
    }
    return removed;
  }

  async run(
    id: string,
    options?: { forced?: boolean },
  ): Promise<
    | CronExecutionResult
    | { status: "not_found"; error?: string }
  > {
    const job = this._store.getJob(id);
    if (!job) {
      return { status: "not_found", error: "Job not found" };
    }
    if (typeof job.state.runningAtMs === "number") {
      return { status: "skipped", error: "Job is already running" };
    }
    return this.executeJob(job, { forced: options?.forced ?? true });
  }

  /** Get all jobs (delegates to the store). */
  getAll(): CronJob[] {
    return this._store.getJobs();
  }

  reload(): void {
    this._store.reload();
    this.recomputeAllNextRuns();
    this.armTimer();
  }

  // -- private internals -----------------------------------------------------

  private resolveJobTimeoutMs(job: CronJob): number {
    if (
      job.payload.kind === "agentTurn" &&
      typeof job.payload.timeoutSeconds === "number"
    ) {
      return job.payload.timeoutSeconds * 1000;
    }
    return this.deps.defaultJobTimeoutMs;
  }

  private emit(
    jobId: string,
    action: CronEventAction,
    extra?: Partial<CronEvent>,
  ): void {
    this.deps.onEvent({
      jobId,
      action,
      timestamp: this.deps.nowMs(),
      ...extra,
    });
  }

  private recomputeAllNextRuns(): void {
    const now = this.deps.nowMs();
    let changed = false;

    for (const job of this._store.getJobs()) {
      // Recover stuck runs from a previous process lifetime.
      if (
        typeof job.state.runningAtMs === "number" &&
        now - job.state.runningAtMs > STUCK_RUN_MS
      ) {
        job.state.runningAtMs = undefined;
        changed = true;
      }

      const next = computeJobNextRunAtMs(job, now);
      if (next !== job.state.nextRunAtMs) {
        job.state.nextRunAtMs = next;
        changed = true;
      }

      // One-time at-jobs that passed during downtime get disabled and emitted
      // as 'missed' so callers can surface them in logs/UI.
      if (
        next === undefined &&
        job.enabled &&
        job.schedule.kind === "at" &&
        job.schedule.atMs < now &&
        typeof job.state.lastRunAtMs !== "number"
      ) {
        job.enabled = false;
        changed = true;
        this.emit(job.id, "missed", { runAtMs: job.schedule.atMs });
      }
    }

    if (changed) this._store.persist();
  }

  private armTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.started || !this.deps.enabled) return;

    // Find the nearest due job.
    const now = this.deps.nowMs();
    let nearestMs: number | undefined;
    for (const job of this._store.getEnabledJobs()) {
      const next = job.state.nextRunAtMs;
      if (next && (nearestMs === undefined || next < nearestMs)) {
        nearestMs = next;
      }
    }
    if (nearestMs === undefined) return;

    const delay = Math.min(Math.max(nearestMs - now, 0), MAX_TIMEOUT_MS);
    this.timer = setTimeout(() => {
      void this.onTimer();
    }, delay);
    this.timer.unref?.();
  }

  private async onTimer(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.runDueJobs();
    } finally {
      this.running = false;
      this.armTimer();
    }
  }

  private async runDueJobs(): Promise<void> {
    const now = this.deps.nowMs();
    const dueJobs = this._store.getEnabledJobs().filter(
      (job) =>
        typeof job.state.runningAtMs !== "number" &&
        job.state.nextRunAtMs !== undefined &&
        now >= job.state.nextRunAtMs,
    );
    for (const job of dueJobs) {
      await this.executeJob(job, { forced: false });
    }
  }

  private async executeJob(
    job: CronJob,
    options: { forced: boolean },
  ): Promise<CronExecutionResult> {
    const startMs = this.deps.nowMs();

    job.state.runningAtMs = startMs;
    this._store.updateJob(job.id, job);
    this._store.persist();
    this.emit(job.id, "started", { runAtMs: startMs });

    let status: CronExecutionResult["status"] = "ok";
    let error: string | undefined;
    let summary: string | undefined;
    let deleted = false;

    try {
      const result = await withTimeout(
        this.deps.executeJob(job),
        this.resolveJobTimeoutMs(job),
      );
      status = result.status;
      error = result.error;
      summary = result.summary;
    } catch (err) {
      status = "error";
      error = err instanceof Error ? err.message : String(err);
    }

    const endMs = this.deps.nowMs();
    const durationMs = endMs - startMs;

    job.state.runningAtMs = undefined;
    job.state.lastRunAtMs = startMs;
    job.state.lastStatus = status;
    job.state.lastDurationMs = durationMs;
    job.state.lastError = error;
    job.state.runCount = (job.state.runCount ?? 0) + 1;

    if (job.schedule.kind === "at" && status === "ok") {
      if (job.deleteAfterRun) {
        this._store.removeJob(job.id);
        deleted = true;
      } else {
        job.enabled = false;
      }
    }

    if (!options.forced && job.enabled && !deleted) {
      job.state.nextRunAtMs = computeJobNextRunAtMs(job, endMs);
    }

    if (!deleted) this._store.updateJob(job.id, job);
    this._store.persist();

    this.emit(job.id, "finished", {
      runAtMs: startMs,
      durationMs,
      status,
      error,
      summary,
      nextRunAtMs: job.state.nextRunAtMs,
    });

    return { status, error, summary };
  }
}