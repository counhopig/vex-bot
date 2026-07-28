/**
 * AgentRuntime — wraps @mariozechner/pi-coding-agent to provide
 * per-sessionKey, lock-serialized, single-LLM-call access.
 *
 * Architecture doc (§3): the Agent owns its runtime. Each Agent
 * instance constructs one AgentRuntime, scoped to its (userId, channelId).
 * No process-global state — the session map and the per-key lock chain
 * both live on the instance, so two Agents cannot contaminate each
 * other's sessions.
 *
 * Concurrency (ported from _archive/src/agents/runtime.ts, which
 * documents a real concurrent-same-session incident):
 *   A turn mutates the shared AgentSession's system prompt
 *   (applyPromptInjections) and drives session.prompt(). Two concurrent
 *   turns on the same sessionKey would corrupt each other's injected
 *   prompt and interleave the underlying pi session. The lock chain
 *   serializes overlapping requests for one session.
 *
 * Module split:
 *   - Real AgentRuntime wraps the live @mariozechner/pi-coding-agent
 *     session. Tests inject `createPiSession` and `modelResolver` so
 *     the full module is testable without hitting any real provider.
 */

import { getChildLogger } from "../utils/logger.js";
import type { InboundMessageContext } from "../channels/ChannelAdapter.js";
import type { ChatResponse, ChatUsage } from "./messages.js";
import type { Model, Api } from "@mariozechner/pi-ai";

const logger = getChildLogger("agent-runtime");

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AgentRuntimeConfig {
  /** Model id within `provider`. */
  model: string;
  /** Provider id from `PROVIDER_IDS`. */
  provider: string;
  /** Base system prompt, rebuilt each session. */
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  workingDirectory?: string;
  sessionDir?: string;
}

export interface AgentRuntimeReply {
  content: string;
  provider: string;
  model: string;
  usage?: ChatUsage;
}

/** Slice of the pi-ai Model object the runtime needs. */
export type RuntimeModel = Model<Api>;

/** Subset of the pi-coding-agent Agent that the runtime touches. */
export interface PiAgent {
  setSystemPrompt(text: string): void;
  setTools(tools: unknown[]): void;
  waitForIdle(): Promise<void>;

  /**
   * Sync pi-coding-agent's private `_baseSystemPrompt` field. The SDK's
   * `session.prompt()` method silently overwrites the agent's system prompt
   * with `_baseSystemPrompt` on every turn when custom tools are present
   * (see node_modules/@mariozechner/pi-coding-agent/dist/core/agent-session.js,
   * the `else { this.agent.setSystemPrompt(this._baseSystemPrompt); }` branch
   * in the before_agent_start extension hook). Without this sync, the
   * agent's identity gets dropped on every turn.
   */
  setBaseSystemPrompt(text: string): void;
}

/** Subset of the pi-coding-agent AgentSession that the runtime touches. */
export interface PiSession {
  agent: PiAgent;
  prompt(text: string): Promise<void>;
  getLastAssistantText(): string | undefined;
  getSessionStats(): PiSessionStats;
  dispose(): void;
  subscribe(listener: (event: unknown) => void): () => void;
}

export interface PiSessionStats {
  sessionFile?: string;
  sessionId: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
}

/** Factory injected at construction time so tests can supply a fake
 *  AgentSession. The real implementation will use createAgentSession()
 *  from @mariozechner/pi-coding-agent. */
export type CreatePiSessionFn = (args: {
  model: RuntimeModel;
  workingDirectory: string;
  sessionFile: string;
  apiKey?: string;
  providerForKey: string;
  modelProviderForKey: string;
}) => Promise<PiSession>;

/** Subset of ModelResolver the runtime needs. The real class implements
 *  both methods, so consumers inject `new ModelResolver()` directly. */
export interface ModelResolverLike {
  resolveModel(provider: string, modelId: string): RuntimeModel | undefined;
  getApiKeyForProvider(provider: string): string | undefined;
}

export interface AgentRuntimeDeps {
  modelResolver: ModelResolverLike;
  createPiSession: CreatePiSessionFn;
}

// ---------------------------------------------------------------------------
// AgentRuntime
// ---------------------------------------------------------------------------

export class AgentRuntime {
  private readonly sessions = new Map<string, PiSession>();
  private readonly sessionLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly config: AgentRuntimeConfig,
    private readonly deps: AgentRuntimeDeps,
  ) {
    logger.info(
      { provider: config.provider, model: config.model, sessionDir: config.sessionDir },
      "AgentRuntime initialized",
    );
  }

  // -- public API -----------------------------------------------------------

  /** Non-streaming chat. Syncs the per-turn system prompt via setBaseSystemPrompt
   *  (which pokes pi-coding-agent's private `_baseSystemPrompt` field), then
   *  drives one user turn. We call setBaseSystemPrompt, NOT setSystemPrompt:
   *  when custom tools are present, session.prompt()'s before_agent_start
   *  hook silently overwrites the agent's system prompt with `_baseSystemPrompt`
   *  (see node_modules/@mariozechner/pi-coding-agent/dist/core/agent-session.js
   *  line ~738). Without this sync, the assembled prompt would be discarded
   *  every turn. */
  async chat(systemPrompt: string, ctx: InboundMessageContext): Promise<AgentRuntimeReply> {
    const sessionKey = this.sessionKey(ctx);
    const release = await this.lockSession(sessionKey);
    try {
      const model = this.deps.modelResolver.resolveModel(this.config.provider, this.config.model);
      if (!model) {
        throw new Error(`Cannot resolve model: ${this.config.provider}/${this.config.model}`);
      }
      const session = await this.getOrCreateSession(sessionKey, model);
      // The Agent layer assembles a fresh system prompt each turn (base +
      // persona + pipeline injections). The base-prompt sync keeps that
      // value intact through the SDK's per-turn reset.
      session.agent.setBaseSystemPrompt(systemPrompt);
      await session.prompt(ctx.content);
      await session.agent.waitForIdle();
      return this.buildReply(session);
    } finally {
      release();
    }
  }

  /** Dispose one session. */
  clearSession(ctx: InboundMessageContext): void {
    const sessionKey = this.sessionKey(ctx);
    const session = this.sessions.get(sessionKey);
    if (session) {
      session.dispose();
      this.sessions.delete(sessionKey);
      logger.debug({ sessionKey }, "Session cleared");
    }
  }

  /** Dispose every session. */
  async shutdown(): Promise<void> {
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
    logger.info("All sessions disposed");
  }

  // -- internals ------------------------------------------------------------

  /** Direct chats serialize on (channelId, senderId); group chats on
   *  (channelId, chatId). Matches the archive's sessionKey derivation. */
  private sessionKey(ctx: InboundMessageContext): string {
    if (ctx.chatType === "group") {
      return `${ctx.channelId}:${ctx.chatId}`;
    }
    return `${ctx.channelId}:${ctx.senderId}`;
  }

  /** Per-key exclusive lock. The chain pattern (prev → done → tail) lets
   *  multiple waiters queue without wedging if a holder errors out. */
  private async lockSession(sessionKey: string): Promise<() => void> {
    const prev = this.sessionLocks.get(sessionKey) ?? Promise.resolve();
    const { promise: done, resolve: release } = Promise.withResolvers<void>();
    const tail = prev.then(() => done);
    this.sessionLocks.set(sessionKey, tail);
    await prev.catch(() => {});
    return () => {
      release();
      if (this.sessionLocks.get(sessionKey) === tail) {
        this.sessionLocks.delete(sessionKey);
      }
    };
  }

  private async getOrCreateSession(sessionKey: string, model: RuntimeModel): Promise<PiSession> {
    const existing = this.sessions.get(sessionKey);
    if (existing) {
      logger.debug({ sessionKey }, "Reusing existing session");
      return existing;
    }

    const workingDirectory = this.config.workingDirectory ?? process.cwd();
    const sessionFile = `${workingDirectory}/.vex/sessions/${sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_")}.jsonl`;

    const apiKey = this.deps.modelResolver.getApiKeyForProvider(this.config.provider);
    const session = await this.deps.createPiSession({
      model,
      workingDirectory,
      sessionFile,
      apiKey,
      providerForKey: this.config.provider,
      modelProviderForKey: String(model.provider),
    });
    this.sessions.set(sessionKey, session);
    logger.debug({ sessionKey, customToolCount: 0 }, "New session created");
    return session;
  }

  private buildReply(session: PiSession): AgentRuntimeReply {
    const lastText = session.getLastAssistantText() ?? "";
    const stats = session.getSessionStats();
    const usage: ChatUsage = {
      promptTokens: stats.tokens.input,
      completionTokens: stats.tokens.output,
      totalTokens: stats.tokens.total,
    };
    return {
      content: lastText,
      provider: this.config.provider,
      model: this.config.model,
      usage,
    };
  }
}
