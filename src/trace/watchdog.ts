import type { TriggerRequest } from "../triggers/index.js";
import type { TraceStore } from "./store.js";
import type { TraceSummary } from "./types.js";

/** The source of a watchdog run; its own runs are never reported. */
export const WATCHDOG_SOURCE = "watchdog";

export const DEFAULT_WATCHDOG_EVERY = "1h";

/** Most runs one check reports to the model. */
const MAX_REPORTED = 20;
/** How far back a check looks for runs that started before its window and ended inside it. */
const START_LOOKBACK_MS = 86_400_000;

/** A run worth a look: it failed, was cut off, or its WeChat reply did not arrive. */
export function isAnomaly(run: TraceSummary): boolean {
  return run.source !== WATCHDOG_SOURCE && (run.outcome === "error" || run.outcome === "interrupted" || run.delivered === false);
}

/** Anomalous runs that ended (or, when interrupted, started) at or after `since`, newest first. */
export async function anomaliesSince(traces: Pick<TraceStore, "list">, since: number): Promise<TraceSummary[]> {
  const found: TraceSummary[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await traces.list({ limit: 200, ...(before ? { before } : {}) });
    for (const run of page.runs) {
      if (run.startedAt < since - START_LOOKBACK_MS) return found;
      if ((run.endedAt ?? run.startedAt) >= since && isAnomaly(run)) found.push(run);
    }
    if (!page.nextBefore) return found;
    before = page.nextBefore;
  }
}

function describe(run: TraceSummary): string {
  const parts = [run.id, new Date(run.startedAt).toISOString(), `session ${run.session}`, `source ${run.source}`, run.outcome];
  if (run.error) parts.push(`error: ${run.error}`);
  if (run.delivered === false) parts.push("WeChat delivery failed");
  if (run.toolErrors) parts.push(`${run.toolErrors} failed tool calls`);
  return `- ${parts.join(" · ")} · "${run.title}"`;
}

export function watchdogPrompt(runs: TraceSummary[]): string {
  const shown = runs.slice(0, MAX_REPORTED);
  return [
    "These recent runs failed, were cut off, or did not reach the owner on WeChat:",
    ...shown.map(describe),
    ...(runs.length > shown.length ? [`(${runs.length - shown.length} more not shown)`] : []),
    "",
    "Read the traces you need with trace_query to find the likely cause of each. Then call watchdog_report exactly once: notify=true with a short message when the owner should know or act (something they expected did not happen, or a fault keeps recurring), naming each affected run and its likely cause; notify=false when every problem is transient or already resolved.",
  ].join("\n");
}

export interface WatchdogOptions {
  traces: Pick<TraceStore, "list">;
  /** The check interval; the first check also covers the interval before the daemon started. */
  everyMs: number;
  /** Runs the model over the prompt; resolves to the message for the owner, or null when there is nothing to tell. */
  run: (prompt: string, signal: AbortSignal) => Promise<string | null>;
  deliver: (text: string, signal: AbortSignal) => Promise<void>;
  /** False when the check is to be recorded instead of run; absent, it runs. */
  admit?: (request: TriggerRequest) => boolean;
  now?: () => number;
}

/**
 * A check over the runs since the previous one. Only anomalies reach the model; the window advances
 * once the model has looked at them, so a failed check covers the same runs next time.
 */
export function createWatchdog(opts: WatchdogOptions): (signal: AbortSignal) => Promise<void> {
  const now = opts.now ?? Date.now;
  let since = now() - opts.everyMs;
  return async (signal) => {
    const until = now();
    const runs = await anomaliesSince(opts.traces, since);
    if (runs.length === 0) { since = until; return; }
    signal.throwIfAborted();
    const prompt = watchdogPrompt(runs);
    // A recorded check moves its window on: nothing looked into these runs, so they are not offered again.
    if (opts.admit && !opts.admit({ source: WATCHDOG_SOURCE, title: "Watchdog check", text: prompt })) { since = until; return; }
    const message = await opts.run(prompt, signal);
    since = until;
    if (message) await opts.deliver(message, signal);
  };
}
