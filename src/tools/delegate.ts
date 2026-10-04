import { Agent, type AgentOptions, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { baseInstructionsSection, residentFileSection, SystemPromptBuilder } from "../context/prompt.js";

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
        baseInstructionsSection(opts.workspace),
        residentFileSection({ workspace: opts.workspace, file: "SOUL.md", maxLines: 200 }),
        () => `## Task\n${task}`,
      ]).build({ now: new Date(), windowLabel: "sub-agent" });
      signal?.throwIfAborted();
      const agent = new Agent({
        initialState: { model: opts.model, systemPrompt: prompt, tools: selected, messages: [] },
        streamFn: opts.streamFn,
        getApiKey: opts.getApiKey,
        beforeToolCall: opts.beforeToolCall,
      });
      const unsubscribe = agent.subscribe((event) => {
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          onUpdate?.({ content: [{ type: "text", text: event.assistantMessageEvent.delta }], details: { kind: "text_delta" } });
        } else if (event.type === "tool_execution_start" || event.type === "tool_execution_update" || event.type === "tool_execution_end") {
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
          throw new Error(last.errorMessage ?? "The sub-agent was interrupted");
        }
        return { content: [{ type: "text", text: last.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("") }], details: {} };
      } finally {
        signal?.removeEventListener("abort", abort);
        unsubscribe();
      }
    },
  };
}
