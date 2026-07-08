/**
 * Cron job service
 *
 * Based on moltbot cron service implementation
 * Provides job management, scheduling, event notification, etc.
 */

import { randomUUID } from "crypto";
import type {
  CronJob,
  CronJobCreate,
  CronJobUpdate,
  CronServiceDeps,
  CronEvent,
  CronEventAction,
} from "./types.js";
import { STUCK_RUN_MS } from "./types.js";
import { CronStore, DEFAULT_CRON_STORE_PATH } from "./store.js";
import { computeJobNextRunAtMs, formatSchedule } from "./schedule.js";

/** Maximum safe setTimeout value (~24.8 days) */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * Cron job service
 */
export class CronService {
  private deps: Required<CronServiceDeps>;
  private store: CronStore;
  private timer: NodeJS.Timeout | null = null;
  private running: boolean = false;
  private started: boolean = false;

  constructor(deps?: CronServiceDeps) {
    this.deps = {
      nowMs: deps?.nowMs ?? (() => Date.now()),
      storePath: deps?.storePath ?? DEFAULT_CRON_STORE_PATH,
      enabled: deps?.enabled ?? true,
      executeJob: deps?.executeJob ?? (async () => ({ status: "ok" as const })),
      onEvent: deps?.onEvent ?? (() => {}),
    };
    this.store = new CronStore(this.deps.storePath);
  }

  /** Start service */
  start(): void {
    if (this.started) return;
    this.started = true;

    // Recompute all job next run times
    this.recomputeAllNextRuns();

    // Arm timer
    if (this.deps.enabled) {
      this.armTimer();
    }
  }

  /** Stop service */
  stop(): void {
    if (!this.started) return;
    this.started = false;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** List all jobs */
  list(options?: { includeDisabled?: boolean }): CronJob[] {
    const { includeDisabled = false } = options || {};
    const jobs = this.store.getJobs();

    return (includeDisabled ? jobs : jobs.filter(j => j.enabled))
      .sort((a, b) => (a.state.nextRunAtMs ?? Infinity) - (b.state.nextRunAtMs ?? Infinity));
  }

  /** Get single job */
  get(id: string): CronJob | undefined {
    return this.store.getJob(id);
  }

  /** Get job by name */
  getByName(name: string): CronJob | undefined {
    return this.store.getJobByName(name);
  }

  /** Add job */
  add(input: CronJobCreate): CronJob {
    const now = this.deps.nowMs();
    const id = randomUUID();

    const job: CronJob = {
      id,
      name: input.name,
      description: input.description,
      enabled: input.enabled ?? true,
      schedule: input.schedule,
      payload: input.payload,
      deleteAfterRun: input.deleteAfterRun,
      createdAtMs: now,
      updatedAtMs: now,
      state: {},
    };

    // Compute next run time
    job.state.nextRunAtMs = computeJobNextRunAtMs(job, now);

    this.store.addJob(job);
    this.store.persist();

    this.emit(job.id, "added", { nextRunAtMs: job.state.nextRunAtMs });
    this.armTimer();

    return job;
  }

  /** Update job */
  update(id: string, patch: CronJobUpdate): CronJob | undefined {
    const job = this.store.getJob(id);
    if (!job) return undefined;

    const now = this.deps.nowMs();

    // Apply update
    if (patch.name !== undefined) job.name = patch.name;
    if (patch.description !== undefined) job.description = patch.description;
    if (patch.enabled !== undefined) job.enabled = patch.enabled;
    if (patch.schedule !== undefined) job.schedule = patch.schedule;
    if (patch.deleteAfterRun !== undefined) job.deleteAfterRun = patch.deleteAfterRun;

    // Merge payload
    if (patch.payload) {
      if (patch.payload.kind && patch.payload.kind !== job.payload.kind) {
        job.payload = patch.payload as typeof job.payload;
      } else {
        Object.assign(job.payload, patch.payload);
      }
    }

    job.updatedAtMs = now;

    // Recompute next run time
    job.state.nextRunAtMs = computeJobNextRunAtMs(job, now);

    this.store.updateJob(id, job);
    this.store.persist();

    this.emit(job.id, "updated", { nextRunAtMs: job.state.nextRunAtMs });
    this.armTimer();

    return job;
  }

  /** Remove job */
  remove(id: string): boolean {
    const removed = this.store.removeJob(id);
    if (removed) {
      this.store.persist();
      this.emit(id, "removed");
      this.armTimer();
    }
    return removed;
  }

  /** Run job immediately */
  async run(id: string, options?: { forced?: boolean }): Promise<{
    status: "ok" | "error" | "skipped" | "not_found";
    error?: string;
    summary?: string;
  }> {
    const job = this.store.getJob(id);
    if (!job) {
      return { status: "not_found", error: "Job not found" };
    }

    return this.executeJob(job, { forced: options?.forced ?? true });
  }

  /** Reload store */
  reload(): void {
    this.store.reload();
    this.recomputeAllNextRuns();
    this.armTimer();
  }

  // ============== Private methods ==============

  /** Emit event */
  private emit(jobId: string, action: CronEventAction, extra?: Partial<CronEvent>): void {
    const event: CronEvent = {
      jobId,
      action,
      timestamp: this.deps.nowMs(),
      ...extra,
    };
    this.deps.onEvent(event);
  }

  /** Recompute all job next run times */
  private recomputeAllNextRuns(): void {
    const now = this.deps.nowMs();
    let changed = false;

    for (const job of this.store.getJobs()) {
      // Clear stuck run state
      if (
        typeof job.state.runningAtMs === "number" &&
        now - job.state.runningAtMs > STUCK_RUN_MS
      ) {
        job.state.runningAtMs = undefined;
        changed = true;
      }

      // Recompute next run time
      const next = computeJobNextRunAtMs(job, now);
      if (next !== job.state.nextRunAtMs) {
        job.state.nextRunAtMs = next;
        changed = true;
      }
    }

    if (changed) {
      this.store.persist();
    }
  }

  /** Arm timer */
  private armTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (!this.started || !this.deps.enabled) return;

    // Find the nearest due job
    const now = this.deps.nowMs();
    let nearestMs: number | undefined;

    for (const job of this.store.getEnabledJobs()) {
      const next = job.state.nextRunAtMs;
      if (next && (nearestMs === undefined || next < nearestMs)) {
        nearestMs = next;
      }
    }

    if (nearestMs === undefined) return;

    const delay = Math.min(Math.max(nearestMs - now, 0), MAX_TIMEOUT_MS);

    this.timer = setTimeout(() => {
      this.onTimer();
    }, delay);

    // Do not prevent process exit
    this.timer.unref?.();
  }

  /** Timer triggered */
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

  /** Run due jobs */
  private async runDueJobs(): Promise<void> {
    const now = this.deps.nowMs();
    const dueJobs = this.store.getEnabledJobs().filter(job =>
      typeof job.state.runningAtMs !== "number" &&
      job.state.nextRunAtMs !== undefined &&
      now >= job.state.nextRunAtMs
    );

    for (const job of dueJobs) {
      await this.executeJob(job, { forced: false });
    }
  }

  /** Execute single job */
  private async executeJob(
    job: CronJob,
    options: { forced: boolean }
  ): Promise<{
    status: "ok" | "error" | "skipped";
    error?: string;
    summary?: string;
  }> {
    const startMs = this.deps.nowMs();

    // Mark as running
    job.state.runningAtMs = startMs;
    this.store.updateJob(job.id, job);
    this.store.persist();

    this.emit(job.id, "started", { runAtMs: startMs });

    let status: "ok" | "error" | "skipped" = "ok";
    let error: string | undefined;
    let summary: string | undefined;
    let deleted = false;

    try {
      const result = await this.deps.executeJob(job);
      status = result.status;
      error = result.error;
      summary = result.summary;
    } catch (err) {
      status = "error";
      error = err instanceof Error ? err.message : String(err);
    }

    const endMs = this.deps.nowMs();
    const durationMs = endMs - startMs;

    // Update state
    job.state.runningAtMs = undefined;
    job.state.lastRunAtMs = startMs;
    job.state.lastStatus = status;
    job.state.lastDurationMs = durationMs;
    job.state.lastError = error;
    job.state.runCount = (job.state.runCount ?? 0) + 1;

    // Post-processing for one-time jobs
    if (job.schedule.kind === "at" && status === "ok") {
      if (job.deleteAfterRun) {
        this.store.removeJob(job.id);
        deleted = true;
      } else {
        job.enabled = false;
      }
    }

    // Recompute next run time
    if (!options.forced && job.enabled && !deleted) {
      job.state.nextRunAtMs = computeJobNextRunAtMs(job, endMs);
    }

    // Save updated job to store (ensure dirty flag is set)
    if (!deleted) {
      this.store.updateJob(job.id, job);
    }
    this.store.persist();

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

/** Default service instance */
let defaultService: CronService | null = null;

/** Get default Cron service */
export function getCronService(deps?: CronServiceDeps): CronService {
  if (!defaultService) {
    defaultService = new CronService(deps);
  }
  return defaultService;
}

/** Stop and drop the default Cron service (graceful shutdown / test isolation). */
export function resetCronService(): void {
  if (defaultService) {
    defaultService.stop();
    defaultService = null;
  }
}
