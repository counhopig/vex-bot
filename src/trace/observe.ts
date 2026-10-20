import type { AgentEvent, BeforeToolCallContext, BeforeToolCallResult, StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, getCurrentTools, type AssistantMessage, type Context, type TranscriptContext } from "@earendil-works/pi-ai";
import { estimateProviderInput, tokenEstimate } from "../context/budget.js";
import type { RunTrace } from "./store.js";
import type { ContextBreakdown } from "./types.js";

type Gate = (ctx: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;

/** A gate that answers quicker than this made no one wait, so only blocks and approval waits are recorded. */
const GATE_WAIT_MS = 250;

/** The instructions carried by the request's system messages, in order. */
export function systemText(context: TranscriptContext | Context): string {
  const parts: string[] = [];
  for (const message of context.messages as { role: string; content?: unknown; sections?: Record<string, string | null> }[]) {
    if (message.role !== "system") continue;
    if (typeof message.content === "string") parts.push(message.content);
    else if (Array.isArray(message.content)) parts.push(message.content.flatMap((part: { type?: string; text?: string }) => part.type === "text" ? [part.text ?? ""] : []).join(""));
    for (const section of Object.values(message.sections ?? {})) if (section) parts.push(section);
  }
  return parts.filter(Boolean).join("\n\n");
}

export function contextBreakdown(context: TranscriptContext | Context): ContextBreakdown {
  const total = estimateProviderInput(context as Context);
  const system = tokenEstimate(systemText(context));
  const tools = getCurrentTools(context.messages).reduce((sum, tool) => sum + 32 + tokenEstimate(JSON.stringify(tool)), 0);
  const messages = context.messages.filter((message) => message.role !== "system").length;
  return { system, tools, conversation: Math.max(0, total - system - tools), messages, total };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part: { type?: string; text?: string }) => part.type === "text" ? part.text ?? "" : part.type === "image" ? "[image]" : "").join("");
}

function json(value: unknown): string {
  try { return JSON.stringify(value) ?? ""; } catch { return String(value); }
}

const lastSystem = new WeakMap<RunTrace, string>();

/**
 * Records every provider request made through `stream` as an `llm` step of the current run: the
 * context it carried, time to the first generated token, usage and what came back. The system
 * prompt is written only when it differs from the previous request's.
 */
export function tracedStream(stream: StreamFn, current: () => RunTrace | undefined): StreamFn {
  return async (model, context, options) => {
    const run = current();
    if (!run) return stream(model, context, options);
    const id = run.nextId("llm");
    try {
      const system = systemText(context);
      const changed = lastSystem.get(run) !== system;
      lastSystem.set(run, system);
      run.record({ type: "llm_start", id, model: `${model.provider}/${model.id}`, context: contextBreakdown(context), ...(changed ? { system } : {}) });
    } catch {
      run.record({ type: "llm_start", id, model: `${model.provider}/${model.id}`, context: { system: 0, tools: 0, conversation: 0, messages: context.messages.length, total: 0 } });
    }
    const started = Date.now();
    let firstToken: number | undefined;
    const finish = (message: Pick<AssistantMessage, "content" | "stopReason" | "errorMessage"> & { usage?: AssistantMessage["usage"] }) => {
      const thinking = message.content.flatMap((part) => part.type === "thinking" ? [part.thinking] : []).join("\n");
      const text = message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
      const usage = message.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      run.record({ type: "llm_end", id, ms: Date.now() - started, ...(firstToken !== undefined ? { ttftMs: firstToken - started } : {}),
        usage: { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite }, stopReason: message.stopReason,
        ...(message.errorMessage ? { error: message.errorMessage } : {}), ...(thinking ? { thinking } : {}), ...(text ? { text } : {}),
        toolCalls: message.content.flatMap((part) => part.type === "toolCall" ? [{ id: part.id, name: part.name }] : []) });
    };
    let upstream;
    try {
      upstream = await stream(model, context, options);
    } catch (error) {
      finish({ content: [], stopReason: "error", errorMessage: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    const output = createAssistantMessageEventStream();
    void (async () => {
      let partial: AssistantMessage | undefined;
      let finished = false;
      try {
        for await (const event of upstream) {
          if (firstToken === undefined && event.type.endsWith("_delta")) firstToken = Date.now();
          if ("partial" in event) partial = event.partial;
          // Recorded before the terminal event is forwarded, so the step ends ahead of the tool calls it starts.
          if (event.type === "done" || event.type === "error") { finish(event.type === "done" ? event.message : event.error); finished = true; }
          output.push(event);
        }
        const message = await upstream.result();
        if (!finished) finish(message);
        output.end(message);
      } catch (error) {
        const failed = { ...(partial ?? { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() }),
          stopReason: "error", errorMessage: error instanceof Error ? error.message : String(error) } as AssistantMessage;
        if (!finished) finish(failed);
        output.push({ type: "error", reason: "error", error: failed });
        output.end(failed);
      }
    })();
    return output;
  };
}

/** Records tool starts and ends from an agent's events as steps of the current run. */
export function toolTracer(current: () => RunTrace | undefined): (event: AgentEvent) => void {
  const started = new Map<string, number>();
  return (event) => {
    const run = current();
    if (event.type === "tool_execution_start") {
      started.set(event.toolCallId, Date.now());
      run?.record({ type: "tool_start", id: event.toolCallId, name: event.toolName, args: json(event.args) });
    } else if (event.type === "tool_execution_end") {
      const begun = started.get(event.toolCallId);
      started.delete(event.toolCallId);
      const result = event.result as { content?: unknown; details?: unknown } | undefined;
      const details = result?.details === undefined ? "" : json(result.details);
      run?.record({ type: "tool_end", id: event.toolCallId, name: event.toolName, ms: begun === undefined ? 0 : Date.now() - begun, isError: event.isError,
        result: textOf(result?.content), ...(details && details !== "{}" ? { details } : {}) });
    }
  };
}

/** Records the gate's blocks and the time spent waiting for an approval. */
export function tracedGate(gate: Gate | undefined, current: () => RunTrace | undefined): Gate | undefined {
  if (!gate) return undefined;
  return async (ctx, signal) => {
    const started = Date.now();
    const result = await gate(ctx, signal);
    const ms = Date.now() - started;
    if (result?.block || ms >= GATE_WAIT_MS) {
      current()?.record({ type: "gate", id: ctx.toolCall.id, name: ctx.toolCall.name, ms, blocked: !!result?.block, ...(result?.reason ? { reason: result.reason } : {}) });
    }
    return result;
  };
}
