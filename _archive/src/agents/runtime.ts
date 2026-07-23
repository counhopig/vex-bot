/**
 * Agent Runtime - uses pi-coding-agent createAgentSession high-level API
 * Manages multiple sessions, provides chat and chatStream interfaces
 */

import { join } from "path";
import * as os from "os";
import {
  createAgentSession,
  AgentSession,
  SessionManager,
  AuthStorage,
  ModelRegistry,
  type ToolDefinition,
  type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";
import type { AgentTool, AgentToolResult, ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { VexConfig, ProviderId, InboundMessageContext } from "../types/index.js";
import { resolveModel, initModelResolver, getApiKeyForProvider } from "../providers/model-resolver.js";
import { getChildLogger } from "../utils/logger.js";
import { expandHomePath } from "../utils/path.js";
import { buildSystemPrompt } from "./system-prompt.js";
import type { SkillsRegistry } from "../skills/index.js";
import type { MemoryManager } from "../memory/index.js";
import type { CronService } from "../cron/service.js";
import { gatherPromptInjections } from "../pipeline/index.js";
import { emitToolStart, emitToolEnd } from "../hooks/index.js";

const logger = getChildLogger("runtime");

type ErrorAwareToolResult = AgentToolResult<unknown> & {
  isError?: boolean;
};

function hasToolErrorFlag(result: AgentToolResult<unknown>): result is ErrorAwareToolResult {
  return "isError" in result && result.isError === true;
}

function getToolErrorMessage(result: AgentToolResult<unknown>): string {
  const text = result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n")
    .trim();
  return text || "Tool execution failed";
}

function wrapErrorAwareTool(tool: AgentTool): AgentTool {
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const result = await tool.execute(toolCallId, params, signal, onUpdate);
      if (hasToolErrorFlag(result)) {
        throw new Error(getToolErrorMessage(result));
      }
      return result;
    },
  };
}

/** Wrap a tool so every execution fires the tool_start/tool_end plugin hooks. */
export function wrapToolWithHookEvents(tool: AgentTool): AgentTool {
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const startedAt = Date.now();
      emitToolStart({ toolName: tool.name, toolCallId, arguments: params });
      try {
        const result = await tool.execute(toolCallId, params, signal, onUpdate);
        emitToolEnd({
          toolName: tool.name,
          toolCallId,
          result,
          isError: hasToolErrorFlag(result),
          durationMs: Date.now() - startedAt,
        });
        return result;
      } catch (error) {
        emitToolEnd({
          toolName: tool.name,
          toolCallId,
          result: error instanceof Error ? error.message : String(error),
          isError: true,
          durationMs: Date.now() - startedAt,
        });
        throw error;
      }
    },
  };
}

/** Runtime configuration */
export interface RuntimeConfig {
  model: string;
  provider: ProviderId;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  workingDirectory?: string;
  sessionDir?: string;
  memoryManager?: MemoryManager;
  cronService?: CronService;
  /**
   * When persona is enabled it injects the assistant's identity per turn, so the
   * base prompt omits its default identity to avoid a competing one.
   */
  personaEnabled?: boolean;
}

/** Chat response */
export interface ChatResponse {
  content: string;
  provider: ProviderId;
  model: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/** Stream event */
export type StreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_start"; name: string; argsPreview: string }
  | { type: "tool_end"; isError: boolean };

/**
 * AgentRuntime - manages AgentSession instances
 */
export class AgentRuntime {
  private sessions = new Map<string, AgentSession>();
  private config: RuntimeConfig;
  private sessionDir: string;
  private skillsRegistry: SkillsRegistry | null = null;
  private customTools: AgentTool[] = [];
  // Per-sessionKey exclusive lock. A turn mutates the shared AgentSession's
  // system prompt (applyPromptInjections) and drives session.prompt(); two
  // concurrent turns on the same key would corrupt each other's injected prompt
  // and interleave the underlying pi session. Serialize them here so overlapping
  // requests for one session run one-at-a-time instead of racing.
  private readonly sessionLocks = new Map<string, Promise<void>>();

  constructor(config: RuntimeConfig) {
    this.config = config;
    this.sessionDir = config.sessionDir ? expandHomePath(config.sessionDir) : join(os.homedir(), ".vex", "sessions");

    logger.info({ sessionDir: this.sessionDir }, "AgentRuntime initialized");
  }

  /** Set SkillsRegistry */
  setSkillsRegistry(registry: SkillsRegistry): void {
    this.skillsRegistry = registry;
  }

  /** Register custom tool */
  registerCustomTool(tool: AgentTool): void {
    this.customTools.push(wrapToolWithHookEvents(wrapErrorAwareTool(tool)));
    logger.debug({ toolName: tool.name, toolCount: this.customTools.length }, "Custom tool registered");
  }

  /**
   * Acquire the exclusive per-sessionKey lock, returning a release function.
   * Callers MUST call release() in a finally so the chain can't wedge.
   */
  private async lockSession(sessionKey: string): Promise<() => void> {
    const prev = this.sessionLocks.get(sessionKey) ?? Promise.resolve();
    let release!: () => void;
    const done = new Promise<void>((resolve) => { release = resolve; });
    const tail = prev.then(() => done);
    this.sessionLocks.set(sessionKey, tail);
    await prev.catch(() => {});
    return () => {
      release();
      // Drop the entry only if nobody chained a newer waiter after us.
      if (this.sessionLocks.get(sessionKey) === tail) {
        this.sessionLocks.delete(sessionKey);
      }
    };
  }

  /** Get or create session */
  private async getOrCreateSession(sessionKey: string): Promise<AgentSession> {
    let session = this.sessions.get(sessionKey);
    if (session) {
      logger.debug({ sessionKey }, "Reusing existing session");
      return session;
    }

    // Resolve model
    const model = resolveModel(this.config.provider, this.config.model);
    if (!model) {
      throw new Error(`Cannot resolve model: ${this.config.provider}/${this.config.model}`);
    }
    logger.debug(
      {
        sessionKey,
        provider: this.config.provider,
        model: this.config.model,
        resolvedProvider: model.provider,
        customToolCount: this.customTools.length,
      },
      "Creating agent session"
    );

    // Create independent SessionManager per session
    const sessionFile = join(this.sessionDir, `${this.sanitizeSessionKey(sessionKey)}.jsonl`);
    const sessionManager = SessionManager.create(this.config.workingDirectory ?? process.cwd(), sessionFile);

    // Create AuthStorage and pre-fill API key from vex config
    const authStorage = AuthStorage.inMemory();

    // Important: use model.provider (set by resolveModel) not this.config.provider
    // because createAgentSession looks up API key via model.provider internally
    const modelProvider = model.provider;
    const apiKey = getApiKeyForProvider(this.config.provider);
    if (apiKey) {
      // Set both config.provider and model.provider (if different)
      authStorage.set(this.config.provider, { type: "api_key", key: apiKey });
      if (modelProvider !== this.config.provider) {
        authStorage.set(modelProvider, { type: "api_key", key: apiKey });
      }
      logger.debug({ provider: this.config.provider, modelProvider }, "API key set from vex config");
    }

    // Set fallback resolver to support other providers
    authStorage.setFallbackResolver((provider: string) => {
      // Try direct lookup
      let key = getApiKeyForProvider(provider);
      // If not found, try config.provider key (may be different alias for same service)
      if (!key && provider === modelProvider) {
        key = getApiKeyForProvider(this.config.provider);
      }
      if (key) {
        logger.debug({ provider }, "Got API key from vex config via fallback");
      }
      return key;
    });

    // Create ModelRegistry using the same authStorage
    const modelRegistry = new ModelRegistry(authStorage);

    // Build custom tool definitions
    const customToolDefinitions: ToolDefinition[] = this.customTools.map((tool) => ({
      name: tool.name,
      label: tool.label ?? tool.name,
      description: tool.description,
      parameters: tool.parameters,
      execute: tool.execute,
    }));

    // Create AgentSession
    const { session: newSession } = await createAgentSession({
      cwd: this.config.workingDirectory ?? process.cwd(),
      authStorage,
      modelRegistry,
      model,
      thinkingLevel: "low" as ThinkingLevel,
      sessionManager,
      customTools: customToolDefinitions,
      tools: [], // Do not use default coding tools, only custom tools
    });

    // Apply configured sampling parameters to every LLM call. createAgentSession
    // exposes no temperature/maxTokens options, so wrap the agent's streamFn.
    const { temperature, maxTokens } = this.config;
    if (temperature !== undefined || maxTokens !== undefined) {
      const innerStreamFn = newSession.agent.streamFn;
      newSession.agent.streamFn = (model, context, options) =>
        innerStreamFn(model, context, {
          ...options,
          ...(temperature !== undefined && { temperature }),
          ...(maxTokens !== undefined && { maxTokens }),
        });
    }

    // Override system prompt (must also set _baseSystemPrompt, otherwise prompt() resets it each time)
    const systemPrompt = this.buildSystemPromptText();
    newSession.agent.setSystemPrompt(systemPrompt);
    (newSession as any)._baseSystemPrompt = systemPrompt;

    if (this.customTools.length > 0) {
      newSession.agent.setTools(this.customTools);
    }

    this.sessions.set(sessionKey, newSession);
    logger.debug({ sessionKey, systemPromptLength: systemPrompt.length, customToolCount: this.customTools.length }, "New session created");

    return newSession;
  }

  /** Build system prompt */
  private buildSystemPromptText(): string {
    return buildSystemPrompt({
      basePrompt: this.config.systemPrompt,
      workingDirectory: this.config.workingDirectory,
      includeEnvironment: true,
      includeDateTime: true,
      includeToolRules: false,
      tools: this.customTools,
      skillsPrompt: this.skillsRegistry?.buildPrompt(),
      enableMemory: !!this.config.memoryManager,
      omitDefaultIdentity: !!this.config.personaEnabled,
    });
  }

  private logApiQuery(session: AgentSession, userContent: string, sessionKey: string): void {
    const baseSystemPrompt = (session as unknown as Record<string, unknown>)._baseSystemPrompt as string | undefined;
    const tools = this.customTools.map((tool) => ({
      name: tool.name,
      label: tool.label ?? tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));

    logger.debug(
      {
        sessionKey,
        provider: this.config.provider,
        model: this.config.model,
        messages: [
          { role: "system", content: baseSystemPrompt ?? "" },
          { role: "user", content: userContent },
        ],
        toolCount: tools.length,
        tools,
      },
      "Complete LLM API query"
    );
  }

  /** Sanitize session key to be usable as filename */
  private sanitizeSessionKey(key: string): string {
    return key.replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  /** Get session key from context */
  private getSessionKey(context: InboundMessageContext): string {
    if (context.chatType === "group") {
      return `${context.channelId}:${context.chatId}`;
    }
    return `${context.channelId}:${context.senderId}`;
  }

  /** Apply prompt injections for a single turn, returning a restore function */
  private async applyPromptInjections(session: AgentSession, context: InboundMessageContext): Promise<() => void> {
    const basePrompt = this.buildSystemPromptText();
    const injections = await gatherPromptInjections(context);

    if (injections.length > 0) {
      const injectedPrompt = `${basePrompt}\n\n${injections.join("\n\n")}`;
      session.agent.setSystemPrompt(injectedPrompt);
      (session as unknown as Record<string, unknown>)._baseSystemPrompt = injectedPrompt;
      logger.debug(
        {
          channelId: context.channelId,
          chatId: context.chatId,
          senderId: context.senderId,
          injectionCount: injections.length,
          basePromptLength: basePrompt.length,
          injectedPromptLength: injectedPrompt.length,
        },
        "Prompt injected"
      );
    } else {
      logger.debug(
        { channelId: context.channelId, chatId: context.chatId, senderId: context.senderId, basePromptLength: basePrompt.length },
        "No prompt injections for turn"
      );
    }

    // Return restore function
    return () => {
      session.agent.setSystemPrompt(basePrompt);
      (session as unknown as Record<string, unknown>)._baseSystemPrompt = basePrompt;
      logger.debug(
        { channelId: context.channelId, chatId: context.chatId, senderId: context.senderId, basePromptLength: basePrompt.length },
        "Prompt restored"
      );
    };
  }

  /** Non-streaming chat */
  async chat(context: InboundMessageContext): Promise<ChatResponse> {
    const sessionKey = this.getSessionKey(context);
    const startedAt = Date.now();
    logger.debug({ sessionKey, contentPreview: context.content.slice(0, 100), contentLength: context.content.length }, "Processing message");

    const releaseLock = await this.lockSession(sessionKey);
    try {
      const session = await this.getOrCreateSession(sessionKey);
      const restorePrompt = await this.applyPromptInjections(session, context);

      this.logApiQuery(session, context.content, sessionKey);

      try {
        await session.prompt(context.content);
        await session.agent.waitForIdle();

        const lastText = session.getLastAssistantText() ?? "";

        // Get usage statistics
        const stats = session.getSessionStats();

        logger.debug(
          {
            sessionKey,
            responseLength: lastText.length,
            durationMs: Date.now() - startedAt,
            usage: stats.tokens,
          },
          "Message processed"
        );

        return {
          content: lastText,
          provider: this.config.provider,
          model: this.config.model,
          usage: {
            promptTokens: stats.tokens.input,
            completionTokens: stats.tokens.output,
            totalTokens: stats.tokens.total,
          },
        };
      } finally {
        restorePrompt();
      }
    } finally {
      releaseLock();
    }
  }

  /** Streaming chat */
  async *chatStream(
    context: InboundMessageContext,
    options?: { signal?: AbortSignal }
  ): AsyncGenerator<StreamEvent, ChatResponse, unknown> {
    const sessionKey = this.getSessionKey(context);
    const startedAt = Date.now();
    logger.debug({ sessionKey, contentPreview: context.content.slice(0, 100), contentLength: context.content.length }, "Processing message (stream)");

    const releaseLock = await this.lockSession(sessionKey);
    try {
      const session = await this.getOrCreateSession(sessionKey);
      const restorePrompt = await this.applyPromptInjections(session, context);

      this.logApiQuery(session, context.content, sessionKey);

      // Event queue plus a single-slot waiter: the subscription and the prompt
      // completion wake the consumer instead of it polling on a timer.
      const eventQueue: StreamEvent[] = [];
      let done = false;
      let promptError: Error | null = null;
      let notify: (() => void) | null = null;
      const wake = (): void => {
        const resume = notify;
        notify = null;
        if (resume) resume();
      };

      // Subscribe to events
      const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
        if (event.type === "message_update") {
          const updateEvent = event as { type: "message_update"; assistantMessageEvent: { type: string; delta?: string } };
          if (updateEvent.assistantMessageEvent?.type === "text_delta" && updateEvent.assistantMessageEvent.delta) {
            eventQueue.push({ type: "text_delta", delta: updateEvent.assistantMessageEvent.delta });
          }
        } else if (event.type === "tool_execution_start") {
          const toolEvent = event as { type: "tool_execution_start"; toolName: string; args: Record<string, unknown> };
          const argsPreview = this.getArgsPreview(toolEvent.args);
          eventQueue.push({ type: "tool_start", name: toolEvent.toolName, argsPreview });
          logger.debug({ sessionKey, toolName: toolEvent.toolName, argsPreview }, "Tool execution started");
        } else if (event.type === "tool_execution_end") {
          const toolEvent = event as { type: "tool_execution_end"; isError: boolean };
          eventQueue.push({ type: "tool_end", isError: toolEvent.isError });
          logger.debug({ sessionKey, isError: toolEvent.isError }, "Tool execution ended");
        } else if (event.type === "agent_end") {
          logger.debug({ sessionKey }, "Agent stream ended");
        }
        wake();
      });

      const onAbort = (): void => wake();
      options?.signal?.addEventListener("abort", onAbort);

      // Start prompt. Mark done in finally so the loop always terminates once
      // the turn settles, even if no agent_end event is observed.
      const promptPromise = session.prompt(context.content)
        .then(() => session.agent.waitForIdle())
        .catch((err: unknown) => {
          promptError = err instanceof Error ? err : new Error(String(err));
        })
        .finally(() => {
          done = true;
          wake();
        });

      // Stream output events
      try {
        while (!done) {
          if (options?.signal?.aborted) {
            session.agent.abort();
            throw new DOMException("Aborted", "AbortError");
          }

          while (eventQueue.length > 0) {
            yield eventQueue.shift()!;
          }

          if (!done && eventQueue.length === 0) {
            await new Promise<void>((resolve) => { notify = resolve; });
          }
        }

        // Drain remaining events
        while (eventQueue.length > 0) {
          yield eventQueue.shift()!;
        }
      } finally {
        unsubscribe();
        options?.signal?.removeEventListener("abort", onAbort);
        restorePrompt();
      }

      await promptPromise;

      if (promptError) {
        throw promptError;
      }

      // Get result
      const lastText = session.getLastAssistantText() ?? "";
      const stats = session.getSessionStats();

      logger.debug(
        {
          sessionKey,
          responseLength: lastText.length,
          durationMs: Date.now() - startedAt,
          usage: stats.tokens,
        },
        "Stream message processed"
      );

      return {
        content: lastText,
        provider: this.config.provider,
        model: this.config.model,
        usage: {
          promptTokens: stats.tokens.input,
          completionTokens: stats.tokens.output,
          totalTokens: stats.tokens.total,
        },
      };
    } finally {
      releaseLock();
    }
  }

  /** Get argument preview */
  private getArgsPreview(args: Record<string, unknown>): string {
    if (!args) return "";
    const mainArg = args.path ?? args.directory ?? args.command ?? args.query ?? args.pattern;
    if (typeof mainArg === "string") {
      const preview = mainArg.replace(/\n/g, " ").trim();
      return preview.length > 40 ? preview.slice(0, 40) + "…" : preview;
    }
    return "";
  }

  /** Clear session */
  async clearSession(context: InboundMessageContext): Promise<void> {
    const sessionKey = this.getSessionKey(context);
    const session = this.sessions.get(sessionKey);
    if (session) {
      session.dispose();
      this.sessions.delete(sessionKey);
    }
    logger.debug({ sessionKey }, "Session cleared");
  }

  /** Get session info */
  getSessionInfo(context: InboundMessageContext): {
    messageCount: number;
    lastUpdate: Date;
  } | null {
    const sessionKey = this.getSessionKey(context);
    const session = this.sessions.get(sessionKey);
    if (!session) return null;

    const stats = session.getSessionStats();
    return {
      messageCount: stats.totalMessages,
      lastUpdate: new Date(),
    };
  }

  /** Close all sessions */
  async shutdown(): Promise<void> {
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
    logger.info("All sessions disposed");
  }
}

/** Create AgentRuntime */
export function createAgentRuntime(config: VexConfig): AgentRuntime {
  const runtimeConfig: RuntimeConfig = {
    model: config.agent.defaultModel,
    provider: config.agent.defaultProvider,
    systemPrompt: config.agent.systemPrompt,
    temperature: config.agent.temperature,
    maxTokens: config.agent.maxTokens,
    workingDirectory: config.agent.workingDirectory,
    sessionDir: config.sessions?.directory,
    personaEnabled: config.persona?.enabled !== false,
  };

  // Initialize model resolver
  initModelResolver(config);

  return new AgentRuntime(runtimeConfig);
}
