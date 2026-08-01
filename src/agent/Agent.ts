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
 *     runtime: AgentRuntime        // per-Agent LLM wrapper
 *   }
 *
 * processMessage() orchestrates:
 *   1. Run pipeline interceptors (short-circuit on first match)
 *   2. Build system prompt from persona
 *   3. Gather prompt injections
 *   4. Call LLM via runtime.chat(systemPrompt, ctx)
 *   5. Run pipeline observers
 */

import type { EffectiveConfig } from "../config/EffectiveConfig.js";
import type { InboundMessageContext } from "../channels/ChannelAdapter.js";
import { Pipeline } from "./Pipeline.js";
import type { Persona } from "./persona/Persona.js";
import { assembleSystemPrompt } from "./SystemPromptAssembler.js";
import type { AgentRuntime, AgentRuntimeReply } from "./AgentRuntime.js";
import { getChildLogger } from "../utils/logger.js";
import { emitAgentStart, emitAgentEnd } from "../hooks/index.js";

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

export interface AgentDependencies {
  pipeline: Pipeline;
  persona: Persona | null;
  runtime: AgentRuntime;
  /** Pre-assembled skills section for the system prompt ("" or undefined =
   *  section omitted). Built by the bootstrap from the user's skill dirs. */
  skillsPrompt?: string;
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export class Agent {
  readonly persona: Persona | null;
  readonly pipeline: Pipeline;
  readonly skillsPrompt?: string;
  private readonly runtime: AgentRuntime;

  constructor(
    private readonly ownerId: string,
    private readonly config: EffectiveConfig,
    deps: AgentDependencies,
  ) {
    this.persona = deps.persona;
    this.pipeline = deps.pipeline;
    this.runtime = deps.runtime;
    this.skillsPrompt = deps.skillsPrompt;
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
      skills: this.skillsPrompt,
    });

    // 3. Gather prompt injections (appended after the base system prompt)
    const injections = await this.pipeline.gatherPromptInjections(ctx);
    const finalPrompt = injections.length > 0
      ? systemPrompt + "\n\n---\n\n" + injections.join("\n\n---\n\n")
      : systemPrompt;

    emitAgentStart({
      provider: this.config.agent.defaultProvider,
      model: this.config.agent.defaultModel,
      messages: [],
    });

    const startMs = Date.now();
    let reply: AgentRuntimeReply | undefined;
    try {
      // 4. Call LLM via the per-Agent AgentRuntime
      reply = await this.runtime.chat(finalPrompt, ctx);
      // 5. Run pipeline observers
      await this.pipeline.runObservers(ctx, reply.content);
      return {
        content: reply.content,
        provider: reply.provider,
        model: reply.model,
        ...(reply.usage ? { usage: reply.usage } : {}),
      };
    } finally {
      emitAgentEnd({
        provider: reply?.provider ?? this.config.agent.defaultProvider,
        model: reply?.model ?? this.config.agent.defaultModel,
        response: reply?.content ?? "",
        durationMs: Date.now() - startMs,
      });
    }
  }

  async shutdown(): Promise<void> {
    logger.debug("Agent shutting down");
    await this.runtime.shutdown();
  }
}
