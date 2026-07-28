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
import { assembleSystemPrompt, DEFAULT_IDENTITY } from "./SystemPromptAssembler.js";
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

    // 2. Build system prompt via SystemPromptAssembler.
    // Persona owns Section 1 exclusively — assembleSystemPrompt handles the
    // mutually-exclusive persona-vs-DEFAULT_IDENTITY branching.
    const personaBlock = this.persona ? await this.persona.buildPrompt(ctx) : undefined;

    const systemPrompt = assembleSystemPrompt({
      persona: personaBlock || undefined,
    });

    // 3. Gather prompt injections (appended after the base system prompt)
    const injections = await this.pipeline.gatherPromptInjections(ctx);
    const finalPrompt = injections.length > 0
      ? systemPrompt + "\n\n---\n\n" + injections.join("\n\n---\n\n")
      : systemPrompt;

    // 4. Call LLM
    const response = await this.deps.chat(finalPrompt, [
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
