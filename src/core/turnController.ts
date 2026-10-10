import type { AgentTool, BeforeToolCallContext, BeforeToolCallResult, StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TranscriptContext } from "@earendil-works/pi-ai";

/** What a session lends its controller: usage accounting and owner-visible notices. */
export interface TurnHost {
  recordUsage(usage: AssistantMessage["usage"]): void;
  enqueueAssistant(text: string): Promise<void>;
}

type ToolGate = (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;

/**
 * Runtime-owned behaviour layered onto a session's turns. The session calls these hooks at fixed
 * points of its lifecycle and knows nothing about what a controller decides or which tools it uses.
 */
export interface TurnController {
  /** Tools the controller contributes beside the session's own. */
  tools(): AgentTool<any>[];
  /** Wraps the checked model stream; `unchecked` bypasses the evidence boundary for internal requests. */
  wrapStream(checked: StreamFn, tools: () => AgentTool<any>[], unchecked: StreamFn): StreamFn;
  /** Decides a tool call first; call `ownerGate` to fall through to the owner's policy and approvals. */
  beforeToolCall(context: BeforeToolCallContext, signal: AbortSignal | undefined, ownerGate: ToolGate): Promise<BeforeToolCallResult | undefined>;
  /** An owner message that starts or steers a turn. */
  ownerMessage(requestId: string, text: string): void;
  runStarting(): void;
  stopped(): void;
  toolResults(messages: TranscriptContext["messages"]): void;
  /** The run ended; requests of messages queued for the next run stay open. */
  runEnded(keepRequestIds: Set<string>): void;
}

export type TurnControllerFactory = (host: TurnHost) => TurnController;
