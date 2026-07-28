/**
 * ProviderInterface — LLM provider abstraction layer.
 *
 * Architecture doc (§11): Model resolution, API key management,
 * provider-specific quirks.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResponse {
  content: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/** LLM provider interface — implemented by ModelResolver's resolved models
 *  and by AgentRuntime's pi-coding-agent integration. */
export interface LLMProvider {
  chat(systemPrompt: string, messages: ChatMessage[]): Promise<ChatResponse>;
}
