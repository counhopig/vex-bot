/**
 * Agent - Message processing core
 * Uses AgentRuntime (built on pi-coding-agent) as the underlying engine
 */

import type {
  InboundMessageContext,
  ProviderId,
  VexConfig,
  WeatherConfig,
} from "../types/index.js";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { AgentRuntime, createAgentRuntime, type ChatResponse, type StreamEvent } from "./runtime.js";
import { getChildLogger } from "../utils/logger.js";
import { createBuiltinTools, type BuiltinToolsOptions } from "../tools/builtin/index.js";
import { getAllTools } from "../tools/registry.js";
import { initSkills, type SkillsRegistry } from "../skills/index.js";
import type { MemoryManager } from "../memory/index.js";
import { getCronService } from "../cron/service.js";
import { createDefaultCronExecuteJob } from "../cron/executor.js";
import { initExtensions } from "../extensions/index.js";

const logger = getChildLogger("agent");

// ============== Agent configuration ==============

/** Agent configuration */
export interface AgentOptions {
  model: string;
  provider?: ProviderId;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  maxHistoryMessages?: number;
  maxHistoryTurns?: number;
  contextWindow?: number;
  enableTools?: boolean;
  toolPolicy?: { allow?: string[]; deny?: string[] };
  enableCompaction?: boolean;
  compactionThreshold?: number;
  maxToolRounds?: number;
  workingDirectory?: string;
  enableFunctionCalling?: boolean;
  memoryManager?: MemoryManager;
  weatherConfig?: WeatherConfig;
}

/** Agent response */
export interface AgentResponse {
  content: string;
  toolCalls?: ToolCallResult[];
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  provider: ProviderId;
  model: string;
}

/** Tool call result */
export interface ToolCallResult {
  toolCallId: string;
  name: string;
  result: {
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  };
  isError: boolean;
  durationMs: number;
}

// ============== Agent Class ==============

/** Agent class - wraps AgentRuntime */
export class Agent {
  private runtime: AgentRuntime;
  private options: AgentOptions;
  private tools: AgentTool[] = [];

  constructor(runtime: AgentRuntime, options: AgentOptions) {
    this.runtime = runtime;
    this.options = options;

    if (this.options.enableTools) {
      this.initializeTools();
    }
  }

  private initializeTools(): void {
    const builtinOptions: BuiltinToolsOptions = {
      filesystem: { allowedPaths: [this.options.workingDirectory ?? process.cwd()] },
      bash: { allowedPaths: [this.options.workingDirectory ?? process.cwd()] },
      enableBrowser: true,
      enableMemory: !!this.options.memoryManager,
      memoryManager: this.options.memoryManager,
      enableCron: false,
      weather: { config: this.options.weatherConfig },
    };

    const builtinTools = createBuiltinTools(builtinOptions);
    const toolsByName = new Map<string, AgentTool>();
    for (const tool of builtinTools) {
      toolsByName.set(tool.name, tool);
    }
    for (const tool of getAllTools()) {
      toolsByName.set(tool.name, tool);
    }
    this.tools = Array.from(toolsByName.values());

    // Register tools to runtime
    for (const tool of this.tools) {
      this.runtime.registerCustomTool(tool);
    }

    logger.info({ toolCount: this.tools.length }, "Tools initialized");
  }

  setSkillsRegistry(registry: SkillsRegistry): void {
    this.runtime.setSkillsRegistry(registry);
  }

  registerTool(tool: AgentTool): void {
    this.tools.push(tool);
    this.runtime.registerCustomTool(tool);
  }

  /** Process message (non-streaming) */
  async processMessage(context: InboundMessageContext): Promise<AgentResponse> {
    const response = await this.runtime.chat(context);

    return {
      content: response.content,
      usage: response.usage,
      provider: response.provider,
      model: response.model,
    };
  }

  /** Stream processing message */
  async *processMessageStream(
    context: InboundMessageContext,
    options?: { signal?: AbortSignal }
  ): AsyncGenerator<string, AgentResponse, unknown> {
    const allToolCalls: ToolCallResult[] = [];
    let fullContent = "";

    for await (const event of this.runtime.chatStream(context, options)) {
      if (event.type === "text_delta") {
        fullContent += event.delta;
        yield event.delta;
      } else if (event.type === "tool_start") {
        yield `\n⏺ ${event.name}(${event.argsPreview})`;
      } else if (event.type === "tool_end") {
        yield event.isError ? " ✗" : " ✓";
      }
    }

    // Return final response
    return {
      content: fullContent,
      toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
      provider: this.options.provider ?? ("deepseek" as ProviderId),
      model: this.options.model,
    };
  }

  clearSession(context: InboundMessageContext): void {
    this.runtime.clearSession(context);
  }

  getSessionInfo(context: InboundMessageContext): {
    messageCount: number;
    estimatedTokens: number;
    hasSummary: boolean;
    lastUpdate: Date;
  } | null {
    const info = this.runtime.getSessionInfo(context);
    if (!info) return null;

    return {
      messageCount: info.messageCount,
      estimatedTokens: 0, // Managed internally by runtime
      hasSummary: false,
      lastUpdate: info.lastUpdate,
    };
  }

  restoreSessionFromTranscript(
    sessionKey: string,
    messages: Array<{ role: "user" | "assistant"; content: string }>
  ): void {
    this.runtime.restoreSessionFromTranscript(sessionKey, messages);
  }
}

/** Create Agent */
export async function createAgent(config: VexConfig, options?: { memoryManager?: MemoryManager }): Promise<Agent> {
  let memoryManager: MemoryManager | undefined = options?.memoryManager;
  if (!memoryManager && config.memory?.enabled !== false && config.memory) {
    const { createMemoryManager } = await import("../memory/index.js");
    memoryManager = createMemoryManager({
      enabled: config.memory.enabled ?? true,
      directory: config.memory.directory,
    });
    logger.info({ directory: config.memory.directory }, "Memory system initialized");
  }

  // Create runtime
  const runtime = createAgentRuntime(config);

  // Set cron executor
  const agentExecutor = async (params: {
    message: string;
    sessionKey?: string;
    model?: string;
    timeoutSeconds?: number;
  }) => {
    try {
      const response = await runtime.chat({
        channelId: "webchat",
        chatId: params.sessionKey ?? `cron-${Date.now()}`,
        chatType: "direct",
        senderId: "cron-system",
        content: params.message,
        messageId: `cron-${Date.now()}`,
        timestamp: Date.now(),
      });
      return { success: true, output: response.content };
    } catch (err) {
      return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
    }
  };

  const cronExecuteJob = createDefaultCronExecuteJob({ agentExecutor });
  const cronService = getCronService({
    enabled: true,
    executeJob: cronExecuteJob,
    onEvent: (event) => { logger.debug({ event }, "Cron event"); },
  });
  cronService.start();
  logger.info("Cron service initialized");

  // Create Agent
  const agent = new Agent(runtime, {
    model: config.agent.defaultModel,
    provider: config.agent.defaultProvider,
    systemPrompt: config.agent.systemPrompt ?? "",
    temperature: config.agent.temperature,
    maxTokens: config.agent.maxTokens,
    workingDirectory: config.agent.workingDirectory ?? process.cwd(),
    enableFunctionCalling: config.agent.enableFunctionCalling ?? true,
    memoryManager,
    weatherConfig: config.weather,
    enableTools: true,
  });

  // Load skills
  if (config.skills?.enabled !== false) {
    try {
      const registry = await initSkills(config.skills);
      agent.setSkillsRegistry(registry);
      const skillCount = registry.getAll().length;
      if (skillCount > 0) logger.info({ skillCount }, "Skills loaded");
    } catch (error) {
      logger.warn({ error }, "Failed to load skills");
    }
  }

  await initExtensions(config, agent, { memoryManager });

  return agent;
}
