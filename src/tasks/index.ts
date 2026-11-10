import { randomUUID } from "node:crypto";

/** The source of the message that reports a finished background task to its conversation. */
export const BACKGROUND_TASK_SOURCE = "background task";

export const DEFAULT_TASK_LIMIT = 3;

export interface TaskInfo {
  id: string;
  title: string;
  /** The session the task was started from; its result is delivered there. */
  origin: string;
  startedAt: number;
  /** The run trace of the task, once it has started. */
  traceId?: string;
}

export interface BackgroundTaskOptions {
  /** Runs the task to completion and resolves to its final reply; rejects when it fails. `traced` names its run trace. */
  run: (task: TaskInfo & { prompt: string }, signal: AbortSignal, traced: (traceId: string) => void) => Promise<string>;
  /** Sends the report to the task's conversation. */
  deliver: (origin: string, text: string) => Promise<void>;
  onError?: (err: unknown, task: TaskInfo) => void;
  /** Called whenever the list of running tasks or one of their details changes. */
  onChange?: () => void;
  limit?: number;
  now?: () => number;
}

interface Running {
  info: TaskInfo;
  abort: AbortController;
  done: Promise<void>;
}

/** Tasks the owner handed off from a conversation; each runs on its own and reports back when it ends. */
export class BackgroundTasks {
  private readonly running = new Map<string, Running>();
  private closing = false;

  constructor(private readonly opts: BackgroundTaskOptions) {}

  start(input: { origin: string; title: string; prompt: string }): TaskInfo {
    if (this.closing) throw new Error("vexd is shutting down and cannot start a background task.");
    const limit = this.opts.limit ?? DEFAULT_TASK_LIMIT;
    if (this.running.size >= limit) throw new Error(`${limit} background tasks are already running; wait for one to finish or stop one.`);
    const info: TaskInfo = { id: randomUUID(), title: input.title, origin: input.origin, startedAt: (this.opts.now ?? Date.now)() };
    const abort = new AbortController();
    const traced = (traceId: string) => { info.traceId = traceId; this.opts.onChange?.(); };
    const done = this.opts.run({ ...info, prompt: input.prompt }, abort.signal, traced)
      .then((reply) => `[Background task "${info.title}" finished]\n${reply}`,
        (err: unknown) => {
          if (abort.signal.aborted) return undefined;
          this.opts.onError?.(err, info);
          return `[Background task "${info.title}" failed] ${err instanceof Error ? err.message : String(err)}`;
        })
      .then(async (report) => {
        this.running.delete(info.id);
        this.opts.onChange?.();
        if (report === undefined || abort.signal.aborted) return;
        await this.opts.deliver(info.origin, report);
      })
      .catch((err: unknown) => this.opts.onError?.(err, info));
    this.running.set(info.id, { info, abort, done });
    this.opts.onChange?.();
    return { ...info };
  }

  list(): TaskInfo[] {
    return [...this.running.values()].map((task) => ({ ...task.info }));
  }

  /** Stops a running task; its result is not delivered. */
  stop(id: string): boolean {
    const task = this.running.get(id);
    if (!task) return false;
    task.abort.abort();
    return true;
  }

  async close(): Promise<void> {
    this.closing = true;
    const tasks = [...this.running.values()];
    for (const task of tasks) task.abort.abort();
    await Promise.all(tasks.map((task) => task.done));
  }
}
