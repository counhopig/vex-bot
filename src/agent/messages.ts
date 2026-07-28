/**
 * Agent-facing message types.
 *
 * These are the minimal, text-only message and response shapes that the
 * Agent layer exposes. Tool-call semantics are an internal concern of
 * `pi-coding-agent` and its underlying pi-ai types — they never appear
 * at the Agent/AgentRuntime boundary in the new architecture.
 *
 * Single source of truth: `src/providers/ProviderInterface.ts` re-exports
 * these for downstream code that prefers the provider-layer import path.
 */

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatResponse {
  content: string;
  usage?: ChatUsage;
}
