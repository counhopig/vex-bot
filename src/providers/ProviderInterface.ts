/**
 * ProviderInterface — LLM provider abstraction layer.
 *
 * Architecture doc (§11): Model resolution, API key management,
 * provider-specific quirks.
 *
 * Message/response types live in `src/agent/messages.ts` (single source
 * of truth — the Agent layer owns the conversation shape). This file
 * re-exports them so provider-layer consumers can import everything
 * from one place.
 */

export type { ChatMessage, ChatResponse, ChatRole, ChatUsage } from "../agent/messages.js";

import type { ChatMessage, ChatResponse } from "../agent/messages.js";

/** LLM provider interface — implemented by ModelResolver's resolved models
 *  and by AgentRuntime's pi-coding-agent integration. */
export interface LLMProvider {
  chat(systemPrompt: string, messages: ChatMessage[]): Promise<ChatResponse>;
}
