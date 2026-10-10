import { Agent, type AgentOptions, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { redactSecrets } from "../config/secrets.js";
import { boundedEvidenceReceipt, withEvidenceBoundary, type EvidenceBoundaryOptions } from "../context/evidence.js";
import { addUsage, zeroUsage } from "../providers/usage.js";
import { profileSection, residentFileSection, SystemPromptBuilder } from "../context/prompt.js";
import { RESIDENT_LINE_LIMITS } from "../workspace/workspace.js";
import { CONTEXT_BUDGET_ERROR, ContextBudgetError, withContextBudget } from "../context/budget.js";

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
  /** The parent's evidence rules; the sub-agent's claims are checked the same way. */
  evidence: Pick<EvidenceBoundaryOptions, "profiles" | "advisor" | "secrets" | "warn">;
}

export function createDelegateTool(opts: DelegateOptions): AgentTool<typeof DelegateParams> {
  return {
    name: "delegate",
    label: "Delegate task",
    description: "Hands a self-contained task to a sub-agent that has no conversation history and returns its final reply. The sub-agent cannot delegate further.",
    parameters: DelegateParams,
    executionMode: "parallel",
    async execute(_id, { task, tools }, signal, onUpdate) {
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
      let agent!: Agent;
      agent = new Agent({
        initialState: { model: opts.model, systemPrompt: prompt, tools: selected, messages: [] },
        streamFn: withContextBudget(withEvidenceBoundary(opts.streamFn, { ...opts.evidence, tools: () => selected, messages: () => agent.state.messages })),
        getApiKey: opts.getApiKey,
        beforeToolCall: opts.beforeToolCall,
      });
      const unsubscribe = agent.subscribe((event) => {
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
        const messages = agent.state.messages;
        const secrets = opts.evidence.secrets?.() ?? [];
        const calls = messages.flatMap((message) => message.role === "assistant" ? message.content.filter((part) => part.type === "toolCall") : []);
        const results = messages.flatMap((message) => message.role === "toolResult" ? [message] : []);
        const evidence = calls.flatMap((call) => {
          const result = results.find((candidate) => candidate.toolCallId === call.id && candidate.toolName === call.name);
          return result ? [{ tool: call.name, callId: call.id, arguments: redactSecrets(JSON.stringify(call.arguments), secrets).slice(0, 1000), error: result.isError,
            result: redactSecrets(result.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n"), secrets).slice(0, 1000),
            receipt: result.details && typeof result.details === "object" && "receipt" in result.details ? boundedEvidenceReceipt(result.details.receipt, secrets) : undefined }] : [];
        }).slice(-12);
        const checkedReply = redactSecrets(last.content.flatMap((part) => part.type === "text" ? [part.text] : []).join(""), secrets).slice(0, 4000);
        const usage = messages.reduce((total, message) => message.role === "assistant" ? addUsage(total, message.usage) : total, zeroUsage());
        const receipt = { version: 1, evidence, checkedReply, usage };
        return { content: [{ type: "text", text: JSON.stringify(receipt) }], details: { receipt }, usage };
      } finally {
        signal?.removeEventListener("abort", abort);
        unsubscribe();
      }
    },
  };
}
