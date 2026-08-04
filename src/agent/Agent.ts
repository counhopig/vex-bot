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

/** Minimal surface the Agent needs from the per-(user, channel) plugin
 *  orchestrator — lets the Agent tear it down without coupling to the
 *  plugins module. */
export interface AgentPluginService {
  shutdown(): Promise<void>;
}

export interface AgentDependencies {
  pipeline: Pipeline;
  persona: Persona | null;
  runtime: AgentRuntime;
  /** Pre-assembled skills section for the system prompt ("" or undefined =
   *  section omitted). Built by the bootstrap from the user's skill dirs. */
  skillsPrompt?: string;
  /** Per-(user, channel) plugin orchestrator, torn down with this Agent. */
  pluginService?: AgentPluginService;
  /** Extra per-Agent resources needing teardown on shutdown (SkillLearner,
   *  ShareLink, etc.). Kept generic so Agent stays decoupled from them. */
  features?: Array<{ shutdown(): void | Promise<void> }>;
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export class Agent {
  readonly persona: Persona | null;
  readonly pipeline: Pipeline;
  readonly skillsPrompt?: string;
  private readonly pluginService?: AgentPluginService;
  private readonly features: Array<{ shutdown(): void | Promise<void> }>;
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
    this.pluginService = deps.pluginService;
    this.features = deps.features ?? [];
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
    // mutually-exclusive persona-vs-DEFAULT_IDENTITY branching. The user's
    // configured agent.systemPrompt follows identity as custom instructions.
    const personaBlock = this.persona ? await this.persona.buildPrompt(ctx) : undefined;

    const systemPrompt = assembleSystemPrompt({
      persona: personaBlock || undefined,
      customInstructions: this.config.agent.systemPrompt,
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
      // 5. Persist Persona-owned post-turn state before optional observers.
      await this.persona?.observeResponse(ctx, reply.content);
      // 6. Run pipeline observers
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
    // Tear down the plugin runtime first (stops plugin services, fires
    // cleanup/unsubscribe), then feature services (SkillLearner clears its
    // in-memory learning sessions), then the LLM runtime. AgentRegistry
    // disposes entries through this single choke point for every reason
    // (shutdown/reset/idle/overflow), so per-Agent resources cannot leak on
    // mid-process eviction.
    await this.pluginService?.shutdown();
    await Promise.allSettled(this.features.map((feature) => feature.shutdown()));
    await this.runtime.shutdown();
  }
}
