import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { TraceStore } from "../trace/store.js";
import type { TraceEvent, TraceSummary } from "../trace/types.js";

const Params = Type.Object({
  action: Type.Union([Type.Literal("list"), Type.Literal("read")]),
  query: Type.Optional(Type.String({ description: "list: only runs whose trace contains this text" })),
  source: Type.Optional(Type.String({ description: "list: only runs started by this source, such as owner, scheduled task, heartbeat or background task" })),
  errorsOnly: Type.Optional(Type.Boolean({ description: "list: only runs that failed, were cut off or were not delivered" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "list: most runs to return, 20 by default" })),
  id: Type.Optional(Type.String({ description: "read: the run to read" })),
});

/** Longest text kept from one field of a step. */
const FIELD_CHARS = 400;
/** Most pages of runs one list looks through. */
const LIST_PAGES = 5;
/** Longest condensed trace returned by one read. */
const READ_CHARS = 16_000;

const cut = (text: string, limit = FIELD_CHARS) => text.length > limit ? `${text.slice(0, limit)}…` : text;

function failed(run: TraceSummary): boolean {
  return run.outcome === "error" || run.outcome === "interrupted" || run.delivered === false || run.toolErrors > 0;
}

function summaryLine(run: TraceSummary): string {
  const parts = [run.id, new Date(run.startedAt).toISOString(), run.session, run.source, run.outcome];
  if (run.ms !== undefined) parts.push(`${Math.round(run.ms / 1000)}s`);
  parts.push(`${run.llmCalls} model calls`, `${run.toolCalls} tool calls`);
  if (run.toolErrors) parts.push(`${run.toolErrors} failed`);
  if (run.delivered !== undefined) parts.push(run.delivered ? "delivered" : "not delivered");
  if (run.error) parts.push(`error: ${run.error}`);
  return `${parts.join(" · ")} · "${run.title}"`;
}

function stepLine(event: TraceEvent): string | undefined {
  const at = new Date(event.t).toISOString().slice(11, 19);
  switch (event.type) {
    case "run_start": return `${at} start ${event.session} (${event.source}, ${event.model}): ${cut(event.text)}`;
    case "user": return `${at} message${event.source ? ` (${event.source})` : ""}: ${cut(event.text)}`;
    case "llm_end": return event.error
      ? `${at} model error: ${cut(event.error)}`
      : `${at} model ${event.stopReason}${event.toolCalls.length ? ` → ${event.toolCalls.map((call) => call.name).join(", ")}` : ""}${event.text ? `: ${cut(event.text)}` : ""}`;
    case "tool_start": return `${at} ${event.parent ? "  " : ""}call ${event.name} ${cut(event.args)}`;
    case "gate": return event.blocked ? `${at} ${event.parent ? "  " : ""}blocked ${event.name}: ${event.reason ?? ""}` : undefined;
    case "tool_end": return `${at} ${event.parent ? "  " : ""}${event.isError ? "failed" : "done"} ${event.name} (${event.ms}ms): ${cut(event.result)}`;
    case "retry": return `${at} retry ${event.attempt}: ${cut(event.error)}`;
    case "check": return `${at} ${event.kind} check: ${cut(event.detail)}`;
    case "delivery": return `${at} WeChat delivery ${event.ok ? "ok" : `failed: ${event.error ?? ""}`}`;
    case "compaction": return `${at} compacted ${event.replaced} messages`;
    case "truncated": return `${at} trace truncated after ${event.bytes} bytes`;
    case "run_end": return `${at} end ${event.outcome} (${event.ms}ms)${event.error ? `: ${cut(event.error)}` : ""}${event.reply ? `\nreply: ${cut(event.reply)}` : ""}`;
    default: return undefined;
  }
}

/** Read-only access to recorded runs: what started them, their steps and how they ended. */
export function createTraceQueryTool(traces: Pick<TraceStore, "list" | "read" | "summary">): AgentTool<typeof Params> {
  return {
    name: "trace_query",
    label: "Run traces",
    description: "Lists or reads the traces of recent runs (the last seven days): owner conversations, scheduled tasks, heartbeats, background tasks and other runs. list shows one line per run, newest first; read shows a run's steps, model calls, tool calls and results, condensed. Use it to find out what happened in a run or why something failed.",
    parameters: Params,
    async execute(_id, params) {
      if (params.action === "read") {
        if (!params.id) throw new Error("Reading a run needs its id");
        const summary = traces.summary(params.id);
        if (!summary) throw new Error(`No such run: ${params.id}`);
        let text = summaryLine(summary);
        for (const event of await traces.read(params.id)) {
          const line = stepLine(event);
          if (line === undefined) continue;
          if (text.length + line.length > READ_CHARS) { text += "\n…(later steps not shown)"; break; }
          text += `\n${line}`;
        }
        return { content: [{ type: "text", text }], details: {} };
      }
      const limit = params.limit ?? 20;
      const runs: TraceSummary[] = [];
      let before: string | undefined;
      for (let pages = 0; pages < LIST_PAGES && runs.length < limit; pages++) {
        const page = await traces.list({ limit: 200, ...(params.query ? { query: params.query } : {}), ...(before ? { before } : {}) });
        runs.push(...page.runs.filter((run) => (!params.source || run.source === params.source) && (!params.errorsOnly || failed(run))));
        if (!page.nextBefore) break;
        before = page.nextBefore;
      }
      runs.splice(limit);
      return { content: [{ type: "text", text: runs.length ? runs.map(summaryLine).join("\n") : "No matching runs." }], details: {} };
    },
  };
}
