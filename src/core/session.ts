import { setTimeout as delay } from "node:timers/promises";
import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type BeforeToolCallContext,
  type BeforeToolCallResult,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, ImageContent, Model, TextContent, UserMessage } from "@earendil-works/pi-ai";
import type { ThinkingSetting } from "../config/schema.js";
import { appendJsonl, readJsonl } from "../store/jsonl.js";
import { summarizeArgs } from "../tools/summary.js";
import type { HistoryItem, SessionEvent } from "./events.js";

export interface SessionOptions {
  key: string;
  transcriptPath: string;
  model: Model<Api>;
  thinking?: ThinkingSetting;
  tools: AgentTool<any>[];
  streamFn: StreamFn;
  getApiKey: (provider: string) => string | undefined;
  buildSystemPrompt: () => Promise<string>;
  beforeToolCall?: (ctx: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
  emit: (event: SessionEvent) => void;
  onError?: (err: unknown) => void;
  retry?: { attempts: number; baseDelayMs: number };
}

const DEFAULT_RETRY = { attempts: 3, baseDelayMs: 1000 };

export class Session {
  readonly key: string;
  private readonly agent: Agent;
  private current: Promise<void> | undefined;
  private stopRequested = false;

  static async open(opts: SessionOptions): Promise<Session> {
    const records = await readJsonl<AgentMessage>(opts.transcriptPath);
    return new Session(opts, records.filter(isTranscriptMessage));
  }

  private constructor(
    private readonly opts: SessionOptions,
    messages: AgentMessage[],
  ) {
    this.key = opts.key;
    this.agent = new Agent({
      initialState: {
        systemPrompt: "",
        model: opts.model,
        thinkingLevel: opts.thinking ?? "off",
        tools: opts.tools,
        messages,
      },
      streamFn: opts.streamFn,
      getApiKey: opts.getApiKey,
      beforeToolCall: opts.beforeToolCall,
      // Rebuilt before every request so time, window and workspace files are always current.
      prepareRequest: async ({ context }) => ({
        context: { ...context, messages: withSystemPrompt(context.messages, await opts.buildSystemPrompt()) },
      }),
      sessionId: opts.key,
    });
    this.agent.subscribe((event) => this.onAgentEvent(event));
  }

  get busy(): boolean {
    return this.current !== undefined;
  }

  send(text: string): void {
    const message: UserMessage = { role: "user", content: text, timestamp: Date.now() };
    if (this.current) {
      this.agent.steer(message);
      return;
    }
    this.stopRequested = false;
    this.opts.emit({ kind: "busy", busy: true });
    this.current = this.run(message)
      .catch((err: unknown) => {
        this.opts.onError?.(err);
        this.opts.emit({ kind: "error", message: `处理消息时出错：${err instanceof Error ? err.message : String(err)}` });
      })
      .finally(() => {
        this.current = undefined;
        this.opts.emit({ kind: "busy", busy: false });
      });
  }

  stop(): void {
    if (!this.current) return;
    this.stopRequested = true;
    this.agent.clearAllQueues();
    this.agent.abort();
  }

  whenIdle(): Promise<void> {
    return this.current ?? Promise.resolve();
  }

  async dispose(): Promise<void> {
    this.stop();
    await this.whenIdle();
  }

  history(): { items: HistoryItem[]; streaming?: string } {
    const items: HistoryItem[] = [];
    const toolItems = new Map<string, Extract<HistoryItem, { kind: "tool" }>>();
    for (const message of this.agent.state.messages) {
      if (message.role === "user") {
        items.push({ kind: "user", text: contentText(message.content), timestamp: message.timestamp });
      } else if (message.role === "assistant") {
        const text = assistantText(message);
        if (text || message.stopReason === "aborted") {
          items.push({ kind: "assistant", text, stopReason: message.stopReason, timestamp: message.timestamp });
        }
        for (const block of message.content) {
          if (block.type !== "toolCall") continue;
          const item: Extract<HistoryItem, { kind: "tool" }> = {
            kind: "tool",
            toolCallId: block.id,
            toolName: block.name,
            summary: summarizeArgs(block.name, block.arguments),
          };
          toolItems.set(block.id, item);
          items.push(item);
        }
      } else if (message.role === "toolResult") {
        const item = toolItems.get(message.toolCallId);
        if (item) item.isError = message.isError;
      }
    }
    const streaming = this.agent.state.streamingMessage;
    return { items, streaming: streaming?.role === "assistant" ? assistantText(streaming) : undefined };
  }

  private async run(first: UserMessage): Promise<void> {
    await this.agent.prompt(first);
    await this.settle();
    // A message steered in just as the loop finished is still queued; run it now.
    while (!this.stopRequested && this.agent.hasQueuedMessages()) {
      await this.agent.continue();
      await this.settle();
    }
  }

  private async settle(): Promise<void> {
    const { attempts, baseDelayMs } = this.opts.retry ?? DEFAULT_RETRY;
    for (let attempt = 1; ; attempt++) {
      const last = this.agent.state.messages.at(-1);
      if (last?.role !== "assistant" || last.stopReason !== "error") return;
      this.agent.state.messages = this.agent.state.messages.slice(0, -1);
      if (this.stopRequested) return;
      if (attempt > attempts) {
        this.opts.emit({ kind: "error", message: `模型调用失败：${last.errorMessage ?? "未知错误"}` });
        return;
      }
      await delay(baseDelayMs * 2 ** (attempt - 1));
      if (this.stopRequested) return;
      await this.agent.continue();
    }
  }

  private async onAgentEvent(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case "message_update":
        if (event.assistantMessageEvent.type === "text_delta") {
          this.opts.emit({ kind: "text_delta", delta: event.assistantMessageEvent.delta });
        }
        return;
      case "message_end": {
        const message = event.message;
        // System messages are rebuilt from the current prompt and tools on every start.
        if (message.role === "system") return;
        if (message.role === "assistant" && message.stopReason === "error") return;
        await appendJsonl(this.opts.transcriptPath, message);
        if (message.role === "user") {
          this.opts.emit({ kind: "user_message", text: contentText(message.content), timestamp: message.timestamp });
        } else if (message.role === "assistant") {
          const text = assistantText(message);
          if (text || message.stopReason === "aborted") {
            this.opts.emit({ kind: "assistant_message", text, stopReason: message.stopReason, timestamp: message.timestamp });
          }
        }
        return;
      }
      case "tool_execution_start":
        this.opts.emit({
          kind: "tool_start",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          summary: summarizeArgs(event.toolName, event.args),
        });
        return;
      case "tool_execution_end":
        this.opts.emit({ kind: "tool_end", toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError });
        return;
      default:
        return;
    }
  }
}

function isTranscriptMessage(value: unknown): value is AgentMessage {
  if (!value || typeof value !== "object") return false;
  const role = (value as { role?: unknown }).role;
  return role === "user" || role === "assistant" || role === "toolResult";
}

function withSystemPrompt(messages: AgentMessage[], prompt: string): AgentMessage[] {
  const [head, ...rest] = messages;
  if (head?.role === "system") return [{ ...head, content: prompt }, ...rest];
  return [{ role: "system", content: prompt, timestamp: Date.now() }, ...messages];
}

function contentText(content: string | (TextContent | ImageContent)[]): string {
  if (typeof content === "string") return content;
  return content.map((c) => (c.type === "text" ? c.text : "[图片]")).join("");
}

function assistantText(message: AssistantMessage): string {
  return message.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
}
