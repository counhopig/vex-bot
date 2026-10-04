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
import { ContextCompactor, isCompactionRecord, type CompactionOptions } from "../context/compaction.js";
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
  compaction?: Omit<CompactionOptions, "model" | "streamFn" | "getApiKey" | "save">;
  onRunEnd?: () => Promise<void>;
  onOwnerMessage?: () => void;
  onOwnerInteraction?: (count: number) => Promise<void>;
  onDispose?: () => void;
}

const DEFAULT_RETRY = { attempts: 3, baseDelayMs: 1000 };

export class Session {
  readonly key: string;
  private readonly agent: Agent;
  private current: Promise<void> | undefined;
  private stopRequested = false;
  // True once the agent loop has ended and only settlement hooks remain; steering would strand the message.
  private finishing = false;
  private backoff: AbortController | undefined;
  // Messages sent while a stopped or finishing run winds down; they start a fresh run afterwards.
  private afterStop: { text: string; source?: string }[] = [];
  private readonly transcript: AgentMessage[];
  private pendingOwner = 0;
  private writes: Promise<void> = Promise.resolve();
  private closing = false;
  private runSource?: string;
  private runFailed = false;
  private lastResponse?: AssistantMessage;

  get successfulReply(): string | undefined {
    return !this.runFailed && !this.stopRequested && this.lastResponse && this.lastResponse.stopReason !== "error" && this.lastResponse.stopReason !== "aborted" ? assistantText(this.lastResponse) : undefined;
  }

  static async open(opts: SessionOptions): Promise<Session> {
    const records = await readJsonl<unknown>(opts.transcriptPath);
    return new Session(opts, records);
  }

  private constructor(
    private readonly opts: SessionOptions,
    records: unknown[],
  ) {
    this.key = opts.key;
    const messages = records.filter(isTranscriptMessage);
    this.transcript = [...messages];
    const restored = records.filter(isCompactionRecord).filter((r) => r.through <= messages.length).at(-1);
    const compactor = opts.compaction ? new ContextCompactor({
      ...opts.compaction, model: opts.model, streamFn: opts.streamFn, getApiKey: opts.getApiKey,
      save: (record) => appendJsonl(opts.transcriptPath, record),
    }, restored) : undefined;
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
      transformContext: compactor ? (messages, signal) => compactor.transform(messages, signal) : undefined,
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

  send(text: string, source?: string): void {
    if (this.current && (this.stopRequested || this.finishing)) {
      this.afterStop.push({ text, source });
      return;
    }
    if (!source) { this.pendingOwner++; this.opts.onOwnerMessage?.(); }
    const message: UserMessage & { vexSource?: string } = { role: "user", content: text, timestamp: Date.now(), ...(source ? { vexSource: source } : {}) };
    if (this.current) {
      this.agent.steer(message);
      return;
    }
    this.stopRequested = false;
    this.finishing = false;
    this.runSource = source;
    this.runFailed = false;
    this.lastResponse = undefined;
    this.opts.emit({ kind: "busy", busy: true, ...(source ? { source } : {}) });
    this.current = this.run(message)
      .catch((err: unknown) => {
        this.runFailed = true;
        this.opts.onError?.(err);
        if (this.runSource !== "proactive chat" || this.pendingOwner) this.opts.emit({ kind: "error", message: `Error while handling the message: ${err instanceof Error ? err.message : String(err)}` });
      })
      .finally(() => {
        this.current = undefined;
        this.opts.emit({ kind: "busy", busy: false, ...(this.runSource === "proactive chat" && !this.pendingOwner && !this.successfulReply ? { discardReply: true } : {}) });
        this.pendingOwner = 0;
        for (const queued of this.afterStop.splice(0)) this.send(queued.text, queued.source);
      });
  }

  stop(): void {
    if (!this.current) return;
    this.stopRequested = true;
    this.afterStop = [];
    this.backoff?.abort();
    this.agent.clearAllQueues();
    this.agent.abort();
  }

  whenIdle(): Promise<void> {
    return this.current ?? Promise.resolve();
  }

  async dispose(): Promise<void> {
    this.closing = true;
    this.stop();
    await this.whenIdle();
    await this.writes;
    this.opts.onDispose?.();
  }

  setTools(tools: AgentTool<any>[]): void { this.agent.state.tools = tools; }

  async injectAssistant(text: string, signal?: AbortSignal): Promise<void> {
    while (this.busy) {
      await new Promise<void>((resolve, reject) => {
        const aborted = () => { signal?.removeEventListener("abort", aborted); reject(signal?.reason ?? new Error("Cancelled")); };
        signal?.addEventListener("abort", aborted, { once: true });
        if (signal?.aborted) { aborted(); return; }
        this.whenIdle().then(() => { signal?.removeEventListener("abort", aborted); resolve(); }, err => { signal?.removeEventListener("abort", aborted); reject(err); });
      });
      signal?.throwIfAborted();
    }
    signal?.throwIfAborted();
    if (this.closing) throw new Error("The conversation is closing");
    const message: AssistantMessage = { role: "assistant", content: [{ type: "text", text }],
      api: this.opts.model.api, provider: this.opts.model.provider, model: this.opts.model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop", timestamp: Date.now() };
    this.agent.state.messages.push(message);
    this.transcript.push(message);
    this.writes = this.writes.then(() => appendJsonl(this.opts.transcriptPath, message));
    await this.writes;
    this.opts.emit({ kind: "assistant_message", text, stopReason: "stop", timestamp: message.timestamp, injected: true });
  }

  history(): { items: HistoryItem[]; streaming?: string } {
    const items: HistoryItem[] = [];
    const toolItems = new Map<string, Extract<HistoryItem, { kind: "tool" }>>();
    for (const message of this.transcript) {
      if (message.role === "user") {
        items.push({ kind: "user", text: contentText(message.content), timestamp: message.timestamp, source: (message as UserMessage & { vexSource?: string }).vexSource });
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
    try {
    await this.agent.prompt(first);
    await this.settle();
    // A message steered in just as the loop finished is still queued; run it now.
    while (!this.stopRequested && this.agent.hasQueuedMessages()) {
      await this.agent.continue();
      await this.settle();
    }
    this.finishing = true;
    await this.writes;
    if (this.pendingOwner && this.successfulReply) {
      await this.opts.onOwnerInteraction?.(this.pendingOwner);
    }
    } finally { this.finishing = true; await this.writes; await this.opts.onRunEnd?.(); }
  }

  private async settle(): Promise<void> {
    const { attempts, baseDelayMs } = this.opts.retry ?? DEFAULT_RETRY;
    for (let attempt = 1; ; attempt++) {
      const last = this.agent.state.messages.at(-1);
      if (last?.role !== "assistant" || last.stopReason !== "error") return;
      this.agent.state.messages = this.agent.state.messages.slice(0, -1);
      if (this.stopRequested) return;
      if (attempt > attempts) {
        this.runFailed = true;
        const error = new Error(`Model call failed: ${last.errorMessage ?? "unknown error"}`);
        this.opts.onError?.(error);
        if (this.runSource !== "proactive chat" || this.pendingOwner) this.opts.emit({ kind: "error", message: error.message });
        return;
      }
      const backoff = new AbortController();
      this.backoff = backoff;
      try {
        await delay(baseDelayMs * 2 ** (attempt - 1), undefined, { signal: backoff.signal });
      } catch {
        return;
      } finally {
        this.backoff = undefined;
      }
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
        this.transcript.push(message);
        this.writes = this.writes.then(() => appendJsonl(this.opts.transcriptPath, message));
        await this.writes;
        if (message.role === "user") {
          this.opts.emit({ kind: "user_message", text: contentText(message.content), timestamp: message.timestamp, source: (message as UserMessage & { vexSource?: string }).vexSource });
        } else if (message.role === "assistant") {
          this.lastResponse = message;
          const text = assistantText(message);
          if ((text || message.stopReason === "aborted") && !(this.runSource === "proactive chat" && !this.pendingOwner && message.stopReason === "aborted")) {
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
      case "tool_execution_update":
        const details = event.partialResult.details;
        const progress = details?.type === "tool_execution_start" ? `Started ${details.toolName}: ${summarizeArgs(details.toolName, details.args)}`
          : details?.type === "tool_execution_end" ? `${details.toolName} ${details.isError ? "failed" : "finished"}`
          : details?.type === "tool_execution_update" ? `${details.toolName} running` : "";
        this.opts.emit({ kind: "tool_update", toolCallId: event.toolCallId, toolName: event.toolName,
          text: progress ? `\n${progress}\n` : event.partialResult.content.flatMap((c: { type: string; text?: string }) => c.type === "text" ? [c.text ?? ""] : []).join("") });
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
  return content.map((c) => (c.type === "text" ? c.text : "[image]")).join("");
}

function assistantText(message: AssistantMessage): string {
  return message.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
}
