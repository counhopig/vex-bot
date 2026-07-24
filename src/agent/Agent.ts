/**
 * Agent — the core processing unit.
 *
 * Architecture doc (§3): "An Agent instance owns its Persona, Tools, Skills,
 * Memory, and Pipeline. No process-global state bleeding across instances."
 *
 * Agent lifecycle:
 *   create(effectiveConfig) → Agent {
 *     persona: Persona | null      // null = bare tool executor
 *     pipeline: Pipeline           // per-Agent instance
 *   }
 *
 * processMessage() orchestrates:
 *   1. Run pipeline interceptors (short-circuit on first match)
 *   2. Build system prompt from persona
 *   3. Gather prompt injections
 *   4. Call LLM via injected chat function
 *   5. Run pipeline observers
 */

import type { EffectiveConfig } from "../config/EffectiveConfig.js";
import type { InboundMessageContext } from "../channels/ChannelAdapter.js";
import { Pipeline } from "./Pipeline.js";
import type { Persona } from "./persona/Persona.js";
import { getChildLogger } from "../utils/logger.js";

const logger = getChildLogger("agent");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentResponse {
  content: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  provider: string;
  model: string;
}

export type ChatFn = (
  systemPrompt: string,
  messages: Array<{ role: string; content: string }>,
) => Promise<{ content: string }>;

export interface AgentDependencies {
  pipeline: Pipeline;
  persona: Persona | null;
  chat: ChatFn;
}

// ---------------------------------------------------------------------------
// Default identity (used when persona is null / disabled)
// ---------------------------------------------------------------------------

export const DEFAULT_IDENTITY =
  "You are a helpful AI assistant. Be concise, accurate, and polite.";

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export class Agent {
  readonly persona: Persona | null;
  readonly pipeline: Pipeline;

  constructor(
    private readonly ownerId: string,
    private readonly config: EffectiveConfig,
    private readonly deps: AgentDependencies,
  ) {
    this.persona = deps.persona;
    this.pipeline = deps.pipeline;
  }

  async processMessage(ctx: InboundMessageContext): Promise<AgentResponse> {
    logger.debug({ channelId: ctx.channelId, content: ctx.content.slice(0, 100) }, "Processing message");

    // 1. Pipeline interceptors (may short-circuit)
    const intercepted = await this.pipeline.runInterceptors(ctx);
    if (intercepted !== null) {
      logger.debug("Message intercepted, short-circuiting");
      return {
        content: intercepted,
        provider: "interceptor",
        model: "interceptor",
      };
    }

    // 2. Build system prompt: persona → prompt injections
    const sections: string[] = [];

    if (this.persona) {
      const personaBlock = await this.persona.buildPrompt(ctx);
      if (personaBlock) {
        sections.push("【Section 1: 角色身份】\n" + personaBlock);
      }
    }

    sections.push("【Section 2: 行为准则】\n" + DEFAULT_IDENTITY);

    // 3. Gather prompt injections
    const injections = await this.pipeline.gatherPromptInjections(ctx);
    for (const inj of injections) {
      sections.push(inj);
    }

    const systemPrompt = sections.join("\n\n---\n\n");

    // 4. Call LLM
    const response = await this.deps.chat(systemPrompt, [
      { role: "user", content: ctx.content },
    ]);

    // 5. Run pipeline observers
    await this.pipeline.runObservers(ctx, response.content);

    return {
      content: response.content,
      provider: this.config.agent.defaultProvider,
      model: this.config.agent.defaultModel,
    };
  }

  async shutdown(): Promise<void> {
    logger.debug("Agent shutting down");
    // Cleanup owned resources
  }
}
