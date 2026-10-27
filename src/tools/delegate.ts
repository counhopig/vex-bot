import { Agent, type AgentOptions, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { addUsage, zeroUsage } from "../providers/usage.js";
import { profileSection, residentFileSection, SystemPromptBuilder } from "../context/prompt.js";
import { RESIDENT_LINE_LIMITS } from "../workspace/workspace.js";
import { CONTEXT_BUDGET_ERROR, ContextBudgetError, withContextBudget } from "../context/budget.js";
import type { RunTrace } from "../trace/store.js";
import { toolTracer, tracedGate, tracedStream } from "../trace/observe.js";
import { withProviderFailures } from "../providers/errors.js";

const DelegateParams = Type.Object({
  task: Type.String({ minLength: 1, description: "A self-contained task for the sub-agent" }),
  tools: Type.Optional(Type.Array(Type.String(), { description: "Names of the tools it may use; defaults to every tool except delegate" })),
});

export interface DelegateOptions {
  workspace: string;
  model: Model<Api>;
  streamFn: StreamFn;
  getApiKey: NonNullable<AgentOptions["getApiKey"]>;
  tools?: AgentTool<any>[];
  getTools?: () => AgentTool<any>[];
  beforeToolCall?: AgentOptions["beforeToolCall"];
  /** Receives a provider's raw error text, as the parent session does. */
  onProviderError?: (raw: string) => void;
  /** The parent's run in progress; the sub-agent's steps are recorded under the delegate call. */
  trace?: () => RunTrace | undefined;
}

export function createDelegateTool(opts: DelegateOptions): AgentTool<typeof DelegateParams> {
  return {
    name: "delegate",
    label: "Delegate task",
    description: "Hands a self-contained task to a sub-agent that has no conversation history and returns its final reply. The sub-agent cannot delegate further.",
    parameters: DelegateParams,
    executionMode: "parallel",
    async execute(id, { task, tools }, signal, onUpdate) {
      signal?.throwIfAborted();
      const available = (opts.getTools?.() ?? opts.tools ?? []).filter((tool) => tool.name !== "delegate");
      const names = new Set(available.map((tool) => tool.name));
      for (const name of tools ?? []) {
        if (!names.has(name)) throw new Error(`The sub-agent cannot use the tool: ${name}`);
      }
      const selected = tools ? available.filter((tool) => tools.includes(tool.name)) : available;
      const prompt = await new SystemPromptBuilder([
        () => `You are a delegated assistant with no conversation history. Workspace: ${opts.workspace}.`,
        profileSection("delegate"),
        residentFileSection({ workspace: opts.workspace, file: "SOUL.md", maxLines: RESIDENT_LINE_LIMITS["SOUL.md"]! }),
        () => `## Available tools\n${selected.map((tool) => tool.name).join(", ")}`,
        () => `## Task\n${task}`,
      ]).build({ now: new Date(), windowLabel: "sub-agent" });
      signal?.throwIfAborted();
      const run = opts.trace?.()?.child(id);
      const current = () => run;
      const agent = new Agent({
        initialState: { model: opts.model, systemPrompt: prompt, tools: selected, messages: [] },
        streamFn: withContextBudget(withProviderFailures(tracedStream(opts.streamFn, current), (raw) => opts.onProviderError?.(raw))),
        getApiKey: opts.getApiKey,
        beforeToolCall: tracedGate(opts.beforeToolCall, current),
      });
      const traceTools = toolTracer(current);
      const unsubscribe = agent.subscribe((event) => {
        traceTools(event);
        if (event.type === "tool_execution_start" || event.type === "tool_execution_update" || event.type === "tool_execution_end") {
          onUpdate?.({ content: [], details: event });
        }
      });
      const abort = () => agent.abort();
      signal?.addEventListener("abort", abort, { once: true });
      try {
        signal?.throwIfAborted();
        await agent.prompt(task);
        signal?.throwIfAborted();
        const last = [...agent.state.messages].reverse().find((message) => message.role === "assistant");
        if (!last || last.role !== "assistant") throw new Error("The sub-agent returned no reply");
        if (last.stopReason === "error" || last.stopReason === "aborted") {
          if (last.stopReason === "error" && last.errorMessage === CONTEXT_BUDGET_ERROR) throw new ContextBudgetError("The delegated request exceeds its provider budget.");
          throw new Error(last.errorMessage ?? "The sub-agent was interrupted");
        }
        const reply = last.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
        const usage = agent.state.messages.reduce((total, message) => message.role === "assistant" ? addUsage(total, message.usage) : total, zeroUsage());
        return { content: [{ type: "text", text: reply }], details: { usage }, usage };
      } finally {
        signal?.removeEventListener("abort", abort);
        unsubscribe();
      }
    },
  };
}
