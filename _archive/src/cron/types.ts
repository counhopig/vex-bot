/**
 * Cron job type definitions
 */

/** Schedule type: one-time */
export interface ScheduleAt {
  kind: "at";
  /** Execution time (millisecond timestamp) */
  atMs: number;
}

/** Schedule type: periodic */
export interface ScheduleEvery {
  kind: "every";
  /** Interval (milliseconds) */
  everyMs: number;
  /** Anchor time (for alignment, millisecond timestamp) */
  anchorMs?: number;
}

/** Schedule type: Cron expression */
export interface ScheduleCron {
  kind: "cron";
  /** Cron expression (supports seconds: "sec min hour day month weekday") */
  expr: string;
  /** Timezone (defaults to system timezone) */
  tz?: string;
}

/** Schedule configuration */
export type CronSchedule = ScheduleAt | ScheduleEvery | ScheduleCron;

/** Job payload: system event */
export interface PayloadSystemEvent {
  kind: "systemEvent";
  /** Event content */
  message: string;
}

/** Job payload: Agent execution */
export interface PayloadAgentTurn {
  kind: "agentTurn";
  /** User message */
  message: string;
  /** Specify model (optional) */
  model?: string;
  /** Timeout (seconds) */
  timeoutSeconds?: number;
  /** Whether to deliver results */
  deliver?: boolean;
  /** Delivery channel */
  channel?: string;
  /** Delivery target */
  to?: string;
}

/** Job payload */
export type CronPayload = PayloadSystemEvent | PayloadAgentTurn;

/** Job run state */
export interface CronJobState {
  /** Next run time */
  nextRunAtMs?: number;
  /** Last run time */
  lastRunAtMs?: number;
  /** Last run status */
  lastStatus?: "ok" | "error" | "skipped";
  /** Last run duration (milliseconds) */
  lastDurationMs?: number;
  /** Last run error */
  lastError?: string;
  /** Current run start time (for re-entry prevention) */
  runningAtMs?: number;
  /** Run count */
  runCount?: number;
}

/** Cron job */
export interface CronJob {
  /** Job ID */
  id: string;
  /** Job name */
  name: string;
  /** Job description */
  description?: string;
  /** Whether enabled */
  enabled: boolean;
  /** Schedule configuration */
  schedule: CronSchedule;
  /** Job payload */
  payload: CronPayload;
  /** Creation time */
  createdAtMs: number;
  /** Update time */
  updatedAtMs: number;
  /** Delete after run (one-time jobs only) */
  deleteAfterRun?: boolean;
  /** Run state */
  state: CronJobState;
}

/** Job creation input */
export interface CronJobCreate {
  name: string;
  description?: string;
  enabled?: boolean;
  schedule: CronSchedule;
  payload: CronPayload;
  deleteAfterRun?: boolean;
}

/** Job update input */
export interface CronJobUpdate {
  name?: string;
  description?: string;
  enabled?: boolean;
  schedule?: CronSchedule;
  payload?: Partial<CronPayload>;
  deleteAfterRun?: boolean;
}

/** Cron event type */
export type CronEventAction = "added" | "updated" | "removed" | "started" | "finished" | "missed";

/** Cron event */
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

/** Cron service dependencies */
export interface CronServiceDeps {
  /** Custom clock (for testing) */
  nowMs?: () => number;
  /** Store file path */
  storePath?: string;
  /** Whether scheduling is enabled */
  enabled?: boolean;
  /** Job execution callback */
  executeJob?: (job: CronJob) => Promise<{ status: "ok" | "error" | "skipped"; error?: string; summary?: string }>;
  /** Event callback */
  onEvent?: (event: CronEvent) => void;
  /** Fallback execution timeout when a job has no timeoutSeconds (ms). */
  defaultJobTimeoutMs?: number;
}

/** Store file format */
export interface CronStoreFile {
  version: 1;
  jobs: CronJob[];
}

/** Common time constants */
export const TIME_CONSTANTS = {
  SECOND: 1000,
  MINUTE: 60 * 1000,
  HOUR: 60 * 60 * 1000,
  DAY: 24 * 60 * 60 * 1000,
  WEEK: 7 * 24 * 60 * 60 * 1000,
} as const;

/** Stuck job detection threshold (2 hours) */
export const STUCK_RUN_MS = 2 * TIME_CONSTANTS.HOUR;
