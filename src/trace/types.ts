export interface TokenUsage { input: number; output: number; cacheRead: number; cacheWrite: number }

/** Estimated input tokens of one model request, by what carries them. */
export interface ContextBreakdown { system: number; tools: number; conversation: number; messages: number; total: number }

/**
 * One line of a run's trace. `parent` is the tool call that a delegated sub-agent's steps belong to.
 * Payload strings are redacted and bounded before they are written.
 */
export type TraceEvent =
  | { t: number; type: "run_start"; id: string; session: string; source: string; model: string; text: string }
  | { t: number; type: "user"; text: string; source?: string }
  | { t: number; type: "llm_start"; id: string; parent?: string; model: string; context: ContextBreakdown; system?: string }
  | { t: number; type: "llm_end"; id: string; parent?: string; ms: number; ttftMs?: number; usage: TokenUsage; stopReason: string; error?: string; thinking?: string; text?: string; toolCalls: { id: string; name: string }[] }
  | { t: number; type: "tool_start"; id: string; parent?: string; name: string; args: string }
  | { t: number; type: "gate"; id: string; parent?: string; name: string; ms: number; blocked: boolean; reason?: string }
  | { t: number; type: "tool_end"; id: string; parent?: string; name: string; ms: number; isError: boolean; result: string; details?: string }
  | { t: number; type: "compaction"; replaced: number; summaryChars: number }
  | { t: number; type: "retry"; attempt: number; delayMs: number; error: string }
  | { t: number; type: "check"; parent?: string; kind: "evidence" | "budget"; detail: string }
  | { t: number; type: "delivery"; ok: boolean; error?: string }
  | { t: number; type: "truncated"; bytes: number }
  | { t: number; type: "run_end"; ms: number; outcome: TraceOutcome; error?: string; reply?: string };

export type TraceOutcome = "ok" | "error" | "stopped";

/** What the run list shows; rebuilt from the index file after a restart. */
export interface TraceSummary {
  id: string;
  session: string;
  source: string;
  model: string;
  title: string;
  startedAt: number;
  endedAt?: number;
  ms?: number;
  outcome: TraceOutcome | "running" | "interrupted";
  error?: string;
  llmCalls: number;
  toolCalls: number;
  toolErrors: number;
  input: number;
  output: number;
  delivered?: boolean;
}

/** An event as handed to a run trace, which stamps its time. */
export type TraceRecord = TraceEvent extends infer E ? E extends { t: number } ? Omit<E, "t"> : never : never;
