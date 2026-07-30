/**
 * Cron job type definitions.
 *
 * Schema change from archive: `CronJob.ownerId?: string` is new.
 * It's the per-tenant key (matches AgentRegistry's cache key) — required
 * for any cron job that triggers an agent turn, because the new
 * architecture has no globalAgent; the cron service must dispatch each
 * job back to the correct (userId, channelId) Agent through the
 * Dispatcher.dispatchSynthetic() callback (using ownerId as webUserId).
 */

export interface ScheduleAt {
  kind: "at";
  atMs: number;
}

export interface ScheduleEvery {
  kind: "every";
  everyMs: number;
  anchorMs?: number;
}

export interface ScheduleCron {
  kind: "cron";
  expr: string;
  tz?: string;
}

export type CronSchedule = ScheduleAt | ScheduleEvery | ScheduleCron;

export interface PayloadSystemEvent {
  kind: "systemEvent";
  message: string;
}

export interface PayloadAgentTurn {
  kind: "agentTurn";
  message: string;
  model?: string;
  timeoutSeconds?: number;
  deliver?: boolean;
  channel?: string;
  to?: string;
}

export type CronPayload = PayloadSystemEvent | PayloadAgentTurn;

export interface CronJobState {
  nextRunAtMs?: number;
  lastRunAtMs?: number;
  lastStatus?: "ok" | "error" | "skipped";
  lastDurationMs?: number;
  lastError?: string;
  runningAtMs?: number;
  runCount?: number;
}

export interface CronJob {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  schedule: CronSchedule;
  payload: CronPayload;
  createdAtMs: number;
  updatedAtMs: number;
  deleteAfterRun?: boolean;
  state: CronJobState;
  /** Per-tenant key — NEW (archive did not have this). When present,
   *  the executor dispatches agentTurn jobs through Dispatcher with
   *  this as webUserId, so each user gets their own Agent. */
  ownerId?: string;
}

export interface CronJobCreate {
  name: string;
  description?: string;
  enabled?: boolean;
  schedule: CronSchedule;
  payload: CronPayload;
  deleteAfterRun?: boolean;
  ownerId?: string;
}

export interface CronJobUpdate {
  name?: string;
  description?: string;
  enabled?: boolean;
  schedule?: CronSchedule;
  payload?: Partial<CronPayload>;
  deleteAfterRun?: boolean;
}

export type CronEventAction =
  | "added"
  | "updated"
  | "removed"
  | "started"
  | "finished"
  | "missed";

export interface CronEvent {
  jobId: string;
  action: CronEventAction;
  timestamp: number;
  runAtMs?: number;
  durationMs?: number;
  status?: "ok" | "error" | "skipped";
  error?: string;
  summary?: string;
  nextRunAtMs?: number;
}

export interface CronExecutionResult {
  status: "ok" | "error" | "skipped";
  error?: string;
  summary?: string;
  /** Agent output text (only when payload.kind === "agentTurn"). */
  outputText?: string;
}

export interface CronServiceDeps {
  nowMs?: () => number;
  storePath?: string;
  enabled?: boolean;
  /** Callback for executing a job. Dispatcher.dispatchSynthetic-bound
   *  by the bootstrap layer — Cron itself does not import Agent. */
  executeJob?: (
    job: CronJob,
  ) => Promise<CronExecutionResult>;
  onEvent?: (event: CronEvent) => void;
  defaultJobTimeoutMs?: number;
}

export interface CronStoreFile {
  version: 1;
  jobs: CronJob[];
}

export const TIME_CONSTANTS = {
  SECOND: 1000,
  MINUTE: 60 * 1000,
  HOUR: 60 * 60 * 1000,
  DAY: 24 * 60 * 60 * 1000,
  WEEK: 7 * 24 * 60 * 60 * 1000,
} as const;

export const STUCK_RUN_MS = 2 * TIME_CONSTANTS.HOUR;