/**
 * ModelResolver — wraps @mariozechner/pi-ai to turn an
 * (EffectiveConfig, providerId, modelId) tuple into a Model<Api>.
 *
 * Ported from _archive/src/providers/model-resolver.ts. Key changes:
 *   - Class-based lifecycle (init / reset) instead of module-global state.
 *     The archive kept a process-global `modelRegistry` because every
 *     runtime shared the same provider config; here we make that explicit
 *     — each ModelResolver is one initialized snapshot, replaceable by
 *     re-initing.
 *   - ProviderId is derived from PROVIDER_IDS so the type can't drift
 *     from the runtime table.
 *   - The 3-step resolution path is preserved verbatim:
 *       1. Local registry (built at init from the config).
 *       2. pi-ai getModel() for built-in providers (openai, anthropic,
 *          groq, openrouter).
 *       3. Dynamic fallback for any provider with a baseUrl + config.
 *   - The custom-openai / custom-anthropic paths are structurally distinct
 *     (config-supplied models[] and apiVersion, not a fixed table) and
 *     remain full first-class citizens of the resolver.
 */

import type { Model, Api, Provider } from "@mariozechner/pi-ai";
import { getModel as piAiGetModel } from "@mariozechner/pi-ai";
import { PROVIDER_IDS } from "./ProviderMetadata.js";
import { getChildLogger } from "../utils/logger.js";

const logger = getChildLogger("model-resolver");

/** ProviderId is the union of every id in PROVIDERS. Adding a new id
 *  to PROVIDERS automatically widens this type — no separate edit needed. */
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** Per-provider config surface. Wider than EffectiveConfig.providers[id]
 *  because the custom-* providers need config-supplied models[] and
 *  apiVersion, which the underlying Zod schema allows via .passthrough(). */
export interface CustomProviderModelConfig {
	id: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	supportsVision?: boolean;
	supportsReasoning?: boolean;
}

export interface ProviderConfig {
	baseUrl?: string;
	apiKey?: string;
	headers?: Record<string, string>;
	models?: CustomProviderModelConfig[];
	apiVersion?: string;
}

/** Input to init() — the relevant slice of EffectiveConfig. Kept narrow
 *  so callers don't have to plumb the full EffectiveConfig through. */
export interface ModelResolverInit {
	providers?: Record<string, ProviderConfig | undefined>;
}

/** Resolved model info. */
export interface ResolvedModel {
	model: Model<Api>;
	providerId: ProviderId | string;
}

// ---------------------------------------------------------------------------
// Static tables — preserved verbatim from the archive's
// CHINA_PROVIDER_BASE_URLS / CHINA_PROVIDER_MODELS / PRESET_PROVIDER_CONFIGS.
// ---------------------------------------------------------------------------

const CHINA_PROVIDER_BASE_URLS: Record<string, string> = {
	deepseek: "https://api.deepseek.com/v1",
	kimi: "https://api.moonshot.cn/v1",
	stepfun: "https://api.stepfun.com/v1",
	doubao: "https://ark.cn-beijing.volces.com/api/v3",
	minimax: "https://api.minimaxi.com/anthropic",
	modelscope: "https://api-inference.modelscope.cn/v1",
	dashscope: "https://dashscope.aliyuncs.com/compatible-mode/v1",
	zhipu: "https://open.bigmodel.cn/api/paas/v4",
	longcat: "https://api.longcat.chat/openai/v1",
};

interface ModelDefinition {
	id: string;
	name: string;
	provider: string;
	api: "openai-completions" | "anthropic-messages";
	contextWindow: number;
	maxTokens: number;
	supportsVision: boolean;
	supportsReasoning: boolean;
}

const CHINA_PROVIDER_MODELS: Record<string, ModelDefinition[]> = {
	deepseek: [
		{ id: "deepseek-chat", name: "DeepSeek Chat", provider: "deepseek", api: "openai-completions", contextWindow: 64000, maxTokens: 8192, supportsVision: false, supportsReasoning: false },
		{ id: "deepseek-reasoner", name: "DeepSeek Reasoner (R1)", provider: "deepseek", api: "openai-completions", contextWindow: 64000, maxTokens: 8192, supportsVision: false, supportsReasoning: true },
	],
	doubao: [
		{ id: "doubao-seed-1-8-251228", name: "Doubao Seed 1.8", provider: "doubao", api: "openai-completions", contextWindow: 262144, maxTokens: 32768, supportsVision: true, supportsReasoning: true },
		{ id: "doubao-seed-1-6-lite-251015", name: "Doubao Seed 1.6 Lite", provider: "doubao", api: "openai-completions", contextWindow: 262144, maxTokens: 32768, supportsVision: true, supportsReasoning: true },
		{ id: "doubao-seed-1-6-flash-250828", name: "Doubao Seed 1.6 Flash", provider: "doubao", api: "openai-completions", contextWindow: 262144, maxTokens: 32768, supportsVision: true, supportsReasoning: true },
	],
	kimi: [
		{ id: "kimi-k2.5", name: "Kimi K2.5", provider: "kimi", api: "openai-completions", contextWindow: 128000, maxTokens: 65536, supportsVision: true, supportsReasoning: true },
		{ id: "kimi-latest", name: "Kimi Latest", provider: "kimi", api: "openai-completions", contextWindow: 128000, maxTokens: 65536, supportsVision: true, supportsReasoning: false },
		{ id: "moonshot-v1-128k", name: "Moonshot V1 128K", provider: "kimi", api: "openai-completions", contextWindow: 128000, maxTokens: 65536, supportsVision: false, supportsReasoning: false },
	],
	stepfun: [
		{ id: "step-2-mini", name: "Step 2 Mini", provider: "stepfun", api: "openai-completions", contextWindow: 32000, maxTokens: 8192, supportsVision: false, supportsReasoning: true },
		{ id: "step-1-128k", name: "Step 1 128K", provider: "stepfun", api: "openai-completions", contextWindow: 128000, maxTokens: 65536, supportsVision: false, supportsReasoning: false },
	],
	minimax: [
		{ id: "MiniMax-M3", name: "MiniMax M3", provider: "minimax", api: "anthropic-messages", contextWindow: 1000000, maxTokens: 65536, supportsVision: true, supportsReasoning: true },
		{ id: "MiniMax-M2.5", name: "MiniMax M2.5", provider: "minimax", api: "anthropic-messages", contextWindow: 1000000, maxTokens: 65536, supportsVision: false, supportsReasoning: true },
		{ id: "MiniMax-M2.1", name: "MiniMax M2.1", provider: "minimax", api: "anthropic-messages", contextWindow: 1000000, maxTokens: 65536, supportsVision: false, supportsReasoning: true },
	],
	modelscope: [
		{ id: "Qwen/Qwen2.5-72B-Instruct", name: "Qwen 2.5 72B", provider: "modelscope", api: "openai-completions", contextWindow: 131072, maxTokens: 8192, supportsVision: false, supportsReasoning: false },
		{ id: "deepseek-ai/DeepSeek-R1", name: "DeepSeek R1 (ModelScope)", provider: "modelscope", api: "openai-completions", contextWindow: 65536, maxTokens: 8192, supportsVision: false, supportsReasoning: true },
		{ id: "deepseek-ai/DeepSeek-V3", name: "DeepSeek V3 (ModelScope)", provider: "modelscope", api: "openai-completions", contextWindow: 65536, maxTokens: 8192, supportsVision: false, supportsReasoning: false },
	],
	dashscope: [
		{ id: "qwen3-235b-a22b", name: "Qwen3 235B (MoE)", provider: "dashscope", api: "openai-completions", contextWindow: 131072, maxTokens: 8192, supportsVision: false, supportsReasoning: true },
		{ id: "qwen3-32b", name: "Qwen3 32B", provider: "dashscope", api: "openai-completions", contextWindow: 131072, maxTokens: 8192, supportsVision: false, supportsReasoning: true },
		{ id: "qwen-max", name: "Qwen Max", provider: "dashscope", api: "openai-completions", contextWindow: 32768, maxTokens: 8192, supportsVision: false, supportsReasoning: false },
		{ id: "qwen-plus", name: "Qwen Plus", provider: "dashscope", api: "openai-completions", contextWindow: 131072, maxTokens: 8192, supportsVision: false, supportsReasoning: false },
		{ id: "qwq-plus", name: "QwQ Plus", provider: "dashscope", api: "openai-completions", contextWindow: 131072, maxTokens: 16384, supportsVision: false, supportsReasoning: true },
		{ id: "deepseek-r1", name: "DeepSeek R1 (DashScope)", provider: "dashscope", api: "openai-completions", contextWindow: 65536, maxTokens: 8192, supportsVision: false, supportsReasoning: true },
	],
	zhipu: [
		{ id: "glm-z1-plus", name: "GLM-Z1 Plus", provider: "zhipu", api: "openai-completions", contextWindow: 128000, maxTokens: 8192, supportsVision: false, supportsReasoning: true },
		{ id: "glm-z1-flash", name: "GLM-Z1 Flash (Free)", provider: "zhipu", api: "openai-completions", contextWindow: 128000, maxTokens: 8192, supportsVision: false, supportsReasoning: true },
		{ id: "glm-4.7", name: "GLM-4.7", provider: "zhipu", api: "openai-completions", contextWindow: 128000, maxTokens: 8192, supportsVision: false, supportsReasoning: false },
		{ id: "glm-4-plus", name: "GLM-4 Plus", provider: "zhipu", api: "openai-completions", contextWindow: 128000, maxTokens: 4096, supportsVision: false, supportsReasoning: false },
		{ id: "glm-4-flash", name: "GLM-4 Flash (Free)", provider: "zhipu", api: "openai-completions", contextWindow: 128000, maxTokens: 4096, supportsVision: false, supportsReasoning: false },
		{ id: "glm-4v-plus", name: "GLM-4V Plus", provider: "zhipu", api: "openai-completions", contextWindow: 8192, maxTokens: 1024, supportsVision: true, supportsReasoning: false },
	],
	longcat: [
		{ id: "LongCat-2.0", name: "LongCat 2.0", provider: "longcat", api: "openai-completions", contextWindow: 1000000, maxTokens: 131072, supportsVision: false, supportsReasoning: true },
	],
};

const PRESET_PROVIDER_CONFIGS: Record<string, { baseUrl: string; headers?: Record<string, string> }> = {
	openrouter: {
		baseUrl: "https://openrouter.ai/api/v1",
		headers: { "HTTP-Referer": "https://github.com/King-Chau/vex", "X-Title": "Vex" },
	},
	together: { baseUrl: "https://api.together.xyz/v1" },
	groq: { baseUrl: "https://api.groq.com/openai/v1" },
	ollama: { baseUrl: "http://localhost:11434/v1" },
	vllm: { baseUrl: "http://localhost:8000/v1" },
};

/** The pi-ai built-in providers we delegate to in resolveModel() step 2.
 *  Subset of pi-ai's larger known-provider list — only those the archive
 *  considered safe to delegate to without a per-provider override. */
const PI_AI_KNOWN_PROVIDERS: Record<string, string> = {
	openai: "openai",
	anthropic: "anthropic",
	groq: "groq",
	openrouter: "openrouter",
};

/** Providers that don't need an apiKey (local inference servers). */
const LOCAL_PROVIDERS: ReadonlySet<string> = new Set(["ollama", "vllm"]);

// ---------------------------------------------------------------------------
// Model builders
// ---------------------------------------------------------------------------

function buildOpenAIModel(
	modelId: string,
	modelDef: ModelDefinition,
	baseUrl: string,
	provider: string,
	headers?: Record<string, string>,
): Model<"openai-completions"> {
	return {
		id: modelId,
		name: modelDef.name,
		api: "openai-completions",
		provider: provider as Provider,
		baseUrl,
		reasoning: modelDef.supportsReasoning,
		input: modelDef.supportsVision ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: modelDef.contextWindow,
		maxTokens: modelDef.maxTokens,
		headers,
	};
}

function buildAnthropicModel(
	modelId: string,
	modelDef: ModelDefinition,
	baseUrl: string,
	provider: string,
	apiVersion?: string,
	headers?: Record<string, string>,
): Model<"anthropic-messages"> {
	return {
		id: modelId,
		name: modelDef.name,
		api: "anthropic-messages",
		provider: provider as Provider,
		baseUrl,
		reasoning: modelDef.supportsReasoning,
		input: modelDef.supportsVision ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: modelDef.contextWindow,
		maxTokens: modelDef.maxTokens,
		headers: {
			"anthropic-version": apiVersion ?? "2023-06-01",
			...headers,
		},
	};
}

// ---------------------------------------------------------------------------
// ModelResolver
// ---------------------------------------------------------------------------

export class ModelResolver {
	private readonly registry = new Map<string, ResolvedModel>();
	private providerConfigs: Record<string, ProviderConfig> = {};

	/** Initialize (or re-initialize) the resolver from a config snapshot.
	 *  Drops every previously registered model first, so re-init is safe. */
	init(config: ModelResolverInit): void {
		this.registry.clear();
		this.providerConfigs = (config.providers ?? {}) as Record<string, ProviderConfig>;

		for (const [id, providerConfig] of Object.entries(this.providerConfigs)) {
			if (!providerConfig) continue;

			// China providers with an apiKey: register their preset model list.
			if (CHINA_PROVIDER_BASE_URLS[id] && providerConfig.apiKey) {
				this.registerChinaProvider(id, providerConfig);
			}

			// Custom openai / anthropic endpoints — gated on having a models[]
			// and baseUrl (no apiKey required for the registration itself,
			// though isProviderAvailable() does require apiKey).
			if (id === "custom-openai") {
				this.registerCustomOpenAI(providerConfig);
			}
			if (id === "custom-anthropic") {
				this.registerCustomAnthropic(providerConfig);
			}
		}

		logger.info(
			{ registeredModels: this.registry.size, providers: Object.keys(this.providerConfigs).length },
			"Model resolver initialized",
		);
	}

	/** Drop all state. The resolver is then equivalent to a fresh instance. */
	reset(): void {
		this.registry.clear();
		this.providerConfigs = {};
	}

	/** Look up the apiKey for a provider as configured at init time. */
	getApiKeyForProvider(providerId: string): string | undefined {
		return this.providerConfigs[providerId]?.apiKey;
	}

	/** Return every (provider, modelId, model) currently in the registry. */
	getAllRegisteredModels(): Array<{ provider: string; modelId: string; model: Model<Api> }> {
		const result: Array<{ provider: string; modelId: string; model: Model<Api> }> = [];
		for (const [key, resolved] of this.registry) {
			const [, modelId] = key.split(":", 2);
			if (modelId) {
				result.push({
					provider: resolved.providerId,
					modelId,
					model: resolved.model,
				});
			}
		}
		return result;
	}

	/** Resolve a model id to a pi-ai Model<Api>. Returns undefined on miss. */
	resolveModel(providerId: string, modelId: string): Model<Api> | undefined {
		// 1. Local registry.
		const key = `${providerId}:${modelId}`;
		const registered = this.registry.get(key);
		if (registered) {
			return registered.model;
		}

		// 2. pi-ai built-in catalog (openai, anthropic, groq, openrouter).
		// PI_AI_KNOWN_PROVIDERS restricts values to known pi-ai provider ids
		// at runtime, but the upstream API is a strict string union
		// (KnownProvider) plus a per-provider model-id union we can't
		// express here. The runtime narrowing guards the unwrap; the cast
		// is an unavoidable boundary crossing.
		const piProvider = PI_AI_KNOWN_PROVIDERS[providerId];
		if (piProvider) {
			const model = piAiGetModel(
				piProvider as unknown as Parameters<typeof piAiGetModel>[0],
				modelId as unknown as Parameters<typeof piAiGetModel>[1],
			);
			if (model) {
				return model;
			}
			// getModel returns undefined for unknown model ids; fall through
			// to (3) so a config-supplied baseUrl can still serve a model.
		}

		// 3. Dynamic fallback: synthesize an OpenAI-compatible Model from any
		// provider with a baseUrl + config entry. Preserves the archive's
		// 128000/8192 defaults for unknown-model-id fallbacks.
		//
		// Skips custom-openai / custom-anthropic: those providers are strict —
		// the admin declares exactly which models exist, and synthesizing a
		// Model for an undeclared id would point the LLM call at a model the
		// proxy doesn't actually serve. China/preset providers keep the lenient
		// fallback because their preset tables don't cover every model id.
		if (providerId === "custom-openai" || providerId === "custom-anthropic") {
			logger.warn({ providerId, modelId }, "Model not declared in custom provider config");
			return undefined;
		}
		const config = this.providerConfigs[providerId];
		if (config) {
			const preset = PRESET_PROVIDER_CONFIGS[providerId];
			const chinaBaseUrl = CHINA_PROVIDER_BASE_URLS[providerId];
			const baseUrl = config.baseUrl ?? preset?.baseUrl ?? chinaBaseUrl;

			if (baseUrl) {
				const dynamicDef: ModelDefinition = {
					id: modelId,
					name: modelId,
					provider: providerId,
					api: "openai-completions",
					contextWindow: 128000,
					maxTokens: 8192,
					supportsVision: false,
					supportsReasoning: false,
				};
				const mergedHeaders = { ...preset?.headers, ...config.headers };
				const headers = Object.keys(mergedHeaders).length > 0 ? mergedHeaders : undefined;
				const model = buildOpenAIModel(modelId, dynamicDef, baseUrl, providerId, headers);

				// Cache so subsequent calls skip the path-3 build.
				this.registry.set(key, { model, providerId });
				logger.debug({ providerId, modelId, baseUrl }, "Dynamic model resolved");
				return model;
			}
		}

		logger.warn({ providerId, modelId }, "Failed to resolve model");
		return undefined;
	}

	/** Whether a provider has enough configuration to be usable. */
	isProviderAvailable(providerId: string): boolean {
		const config = this.providerConfigs[providerId];
		if (LOCAL_PROVIDERS.has(providerId)) {
			return true;
		}
		if (!config) {
			return false;
		}
		// Custom-* providers need both apiKey and baseUrl to actually work.
		if (providerId === "custom-openai" || providerId === "custom-anthropic") {
			return Boolean(config.apiKey && config.baseUrl);
		}
		return Boolean(config.apiKey);
	}

	// -- private registration -------------------------------------------------

	private registerChinaProvider(providerId: string, config: ProviderConfig): void {
		const defaultBaseUrl = CHINA_PROVIDER_BASE_URLS[providerId];
		if (!defaultBaseUrl) return;

		const baseUrl = config.baseUrl ?? defaultBaseUrl;
		const models = CHINA_PROVIDER_MODELS[providerId];
		if (!models) return;

		for (const modelDef of models) {
			const model = modelDef.api === "anthropic-messages"
				? buildAnthropicModel(modelDef.id, modelDef, baseUrl, providerId, undefined, config.headers)
				: buildOpenAIModel(modelDef.id, modelDef, baseUrl, providerId, config.headers);
			this.registry.set(`${providerId}:${modelDef.id}`, { model, providerId });
		}

		logger.debug({ providerId, modelCount: models.length }, "China provider registered");
	}

	private registerCustomOpenAI(config: ProviderConfig): void {
		const baseUrl = config.baseUrl;
		const models = config.models;
		if (!baseUrl || !models) return;

		for (const m of models) {
			const modelDef: ModelDefinition = {
				id: m.id,
				name: m.name ?? m.id,
				provider: "custom-openai",
				api: "openai-completions",
				contextWindow: m.contextWindow ?? 128000,
				maxTokens: m.maxTokens ?? 4096,
				supportsVision: m.supportsVision ?? false,
				supportsReasoning: m.supportsReasoning ?? false,
			};
			const model = buildOpenAIModel(m.id, modelDef, baseUrl, "custom-openai", config.headers);
			this.registry.set(`custom-openai:${m.id}`, { model, providerId: "custom-openai" });
		}
	}

	private registerCustomAnthropic(config: ProviderConfig): void {
		const baseUrl = config.baseUrl;
		const models = config.models;
		if (!baseUrl || !models) return;

		for (const m of models) {
			const modelDef: ModelDefinition = {
				id: m.id,
				name: m.name ?? m.id,
				provider: "custom-anthropic",
				api: "anthropic-messages",
				contextWindow: m.contextWindow ?? 200000,
				maxTokens: m.maxTokens ?? 8192,
				supportsVision: m.supportsVision ?? false,
				supportsReasoning: false,
			};
			const model = buildAnthropicModel(m.id, modelDef, baseUrl, "custom-anthropic", config.apiVersion, config.headers);
			this.registry.set(`custom-anthropic:${m.id}`, { model, providerId: "custom-anthropic" });
		}
	}
}
