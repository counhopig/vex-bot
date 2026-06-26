/**
 * Single source of truth for provider identity.
 *
 * Provider IDs, display names, default models, and tier categorization are
 * referenced from at least five places (config schema, CLI onboarding/status,
 * WebSocket config validation, Web UI option rendering, and model resolver).
 * Keeping the canonical list here prevents drift across those surfaces.
 */

export type ProviderTier = "china" | "overseas" | "custom";

export interface ProviderMeta {
	/** Stable provider id used in config keys and WS payloads. */
	readonly id: string;
	/** Human-readable display name (shown in CLI status and Web UI). */
	readonly name: string;
	/** Whether this provider exposes a pre-known list of models. */
	readonly tier: ProviderTier;
	/** Default model id suggested by the onboarding wizard. */
	readonly defaultModel: string;
	/** Whether the provider always requires an API key. Local providers (ollama/vllm) do not. */
	readonly requiresApiKey: boolean;
}

export const PROVIDERS: readonly ProviderMeta[] = [
	// China-hosted models
	{ id: "deepseek", name: "DeepSeek", tier: "china", defaultModel: "deepseek-chat", requiresApiKey: true },
	{ id: "doubao", name: "Doubao", tier: "china", defaultModel: "doubao-seed-1-8-251228", requiresApiKey: true },
	{ id: "minimax", name: "MiniMax", tier: "china", defaultModel: "MiniMax-M2.1", requiresApiKey: true },
	{ id: "kimi", name: "Kimi", tier: "china", defaultModel: "kimi-k2.5", requiresApiKey: true },
	{ id: "stepfun", name: "StepFun", tier: "china", defaultModel: "step-2-mini", requiresApiKey: true },
	{ id: "modelscope", name: "ModelScope", tier: "china", defaultModel: "Qwen/Qwen2.5-72B-Instruct", requiresApiKey: true },
	{ id: "dashscope", name: "DashScope", tier: "china", defaultModel: "qwen3-235b-a22b", requiresApiKey: true },
	{ id: "zhipu", name: "Zhipu AI", tier: "china", defaultModel: "glm-z1-flash", requiresApiKey: true },
	// Overseas / bring-your-own providers
	{ id: "openai", name: "OpenAI", tier: "overseas", defaultModel: "gpt-4o-mini", requiresApiKey: true },
	{ id: "openrouter", name: "OpenRouter", tier: "overseas", defaultModel: "openai/gpt-4o-mini", requiresApiKey: true },
	{ id: "together", name: "Together AI", tier: "overseas", defaultModel: "meta-llama/Llama-3-70b-chat-hf", requiresApiKey: true },
	{ id: "groq", name: "Groq", tier: "overseas", defaultModel: "llama-3.1-70b-versatile", requiresApiKey: true },
	{ id: "ollama", name: "Ollama", tier: "overseas", defaultModel: "llama3.1", requiresApiKey: false },
	{ id: "vllm", name: "vLLM", tier: "overseas", defaultModel: "", requiresApiKey: false },
	// Custom OpenAI / Anthropic compatible endpoints
	{ id: "custom-openai", name: "Custom OpenAI", tier: "custom", defaultModel: "", requiresApiKey: true },
	{ id: "custom-anthropic", name: "Custom Anthropic", tier: "custom", defaultModel: "", requiresApiKey: true },
];

const PROVIDERS_BY_ID: Record<string, ProviderMeta> = (() => {
	const map: Record<string, ProviderMeta> = {};
	for (const p of PROVIDERS) {
		map[p.id] = p;
	}
	return map;
})();

export const PROVIDER_IDS: readonly string[] = PROVIDERS.map((p) => p.id);

export function getProviderMeta(id: string): ProviderMeta | undefined {
	return PROVIDERS_BY_ID[id];
}

export function getProviderName(id: string): string {
	return PROVIDERS_BY_ID[id]?.name ?? id;
}

export const CHINA_PROVIDER_IDS: readonly string[] = PROVIDERS
	.filter((p) => p.tier === "china")
	.map((p) => p.id);

export const OVERSEAS_PROVIDER_IDS: readonly string[] = PROVIDERS
	.filter((p) => p.tier === "overseas")
	.map((p) => p.id);
