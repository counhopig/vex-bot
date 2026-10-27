import { randomUUID } from "node:crypto";
import type { TurnController, TurnControllerFactory } from "./turnController.js";
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
import { ContextCompactor, isCompactionRecord, type CompactionOptions, type CompactionRecord } from "../context/compaction.js";
import { CONTEXT_BUDGET_ERROR, ContextBudgetError, withContextBudget } from "../context/budget.js";
import { TOOL_EVIDENCE_ERROR, withEvidenceBoundary, type EvidenceBoundaryOptions } from "../context/evidence.js";
import { addUsage, zeroUsage } from "../providers/usage.js";
import { PROVIDER_OVERLOADED } from "../providers/errors.js";
import { appendJsonl, scanJsonl } from "../store/jsonl.js";
import { summarizeArgs } from "../tools/summary.js";
import type { RunTrace, TraceScope } from "../trace/store.js";
import { toolTracer, tracedGate, tracedStream } from "../trace/observe.js";
import type { HistoryItem, SessionEvent } from "./events.js";
import { HistoryWindow, isTranscriptMessage, TranscriptHistory } from "./history.js";
import { TranscriptCursor } from "../context/cursor.js";
import { MessageWindow } from "../context/window.js";

export interface SessionOptions {
  key: string;
  transcriptPath: string;
  model: Model<Api>;
  thinking?: ThinkingSetting;
  tools: AgentTool<any>[];
  streamFn: StreamFn;
  getApiKey: (provider: string) => string | undefined;
  buildSystemPrompt: () => Promise<string>;
  /** What tool results prove, optional outside advice, and the secrets kept out of that advice. */
  evidence: Pick<EvidenceBoundaryOptions, "profiles" | "advisor" | "secrets" | "warn">;
  /** Runtime-owned turn behaviour, such as the owner's link actions. */
  controller?: TurnControllerFactory;
  beforeToolCall?: (ctx: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
  emit: (event: SessionEvent) => void;
  onError?: (err: unknown) => void;
  retry?: { attempts: number; baseDelayMs: number };
  compaction?: Omit<CompactionOptions, "model" | "streamFn" | "getApiKey" | "save" | "loadHistory" | "cursor">;
  onRunEnd?: () => Promise<void>;
  onOwnerMessage?: () => void;
  onOwnerInteraction?: (count: number) => Promise<void>;
  onDispose?: () => void;
  /**
   * Sources of runtime-started runs that stay quiet until the owner joins: their failures, aborted
   * replies and replyless endings are not shown, and their busy event is marked `quiet`.
   */
  quietSources?: readonly string[];
  /** Where each run's steps are recorded. */
  trace?: TraceScope;
}

const DEFAULT_RETRY = { attempts: 3, baseDelayMs: 1000 };
const OVERLOAD_BACKOFF = 10;

/**
 * Where the current run is. Messages that arrive while it is stopping, or finishing (the agent loop has
 * ended and only settlement hooks remain, so steering would strand them), start the next run instead.
 */
type RunPhase = "idle" | "running" | "finishing" | "stopping";

export class Session {
  readonly key: string;
  private readonly agent: Agent;
  private current: Promise<void> | undefined;
  private phase: RunPhase = "idle";
  // Whether the latest run was stopped; read after it ends.
  private stopped = false;
  private backoff: AbortController | undefined;
  // Messages sent while a stopped or finishing run winds down; they start a fresh run afterwards.
  private afterStop: { text: string; source?: string; requestId?: string }[] = [];
  private assistantQueue: string[] = [];
  private assistantDrain: Promise<void> | undefined;
  private readonly recentHistory: HistoryWindow;
  private readonly transcriptHistory: TranscriptHistory;
  private readonly compactor?: ContextCompactor;
  private readonly cursor = new TranscriptCursor();
  private pendingOwner = 0;
  private writes: Promise<void> = Promise.resolve();
  private closing = false;
  private runSource?: string;
  private runFailed = false;
  private runFailureReason?: string;
  private observedBudgetFailure?: string;
  private readonly failedTools = new Set<string>();
  private lastResponse?: AssistantMessage;
  private readonly controller?: TurnController;
  private pendingProviderUsage = zeroUsage();
  private activeRunStart = 0;
  private readonly currentTrace = (): RunTrace | undefined => this.opts.trace?.current;

  get successfulReply(): string | undefined {
    return !this.runFailed && !this.stopped && this.lastResponse && this.lastResponse.stopReason !== "error" && this.lastResponse.stopReason !== "aborted" ? assistantText(this.lastResponse) : undefined;
  }

  /** How the last run ended; callers decide which failed tools make it unusable. */
  get completionOutcome(): { successful: boolean; failureReason?: string; failedTools: string[] } {
    return { successful: this.successfulReply !== undefined,
      ...(this.runFailureReason ? { failureReason: this.runFailureReason } : {}), failedTools: [...this.failedTools] };
  }

  static async open(opts: SessionOptions): Promise<Session> {
    const window = new MessageWindow();
    const history = new HistoryWindow();
    let count = 0;
    let restored: CompactionRecord | undefined;
    for await (const record of scanJsonl(opts.transcriptPath)) {
      if (isTranscriptMessage(record)) {
        count++;
        window.push(record);
        history.add(record);
      } else if (opts.compaction && isCompactionRecord(record) && record.through <= count) {
        restored = record;
        window.discardThrough(record.through);
      }
    }
    return new Session(opts, window, history, restored);
  }

  private constructor(
    private readonly opts: SessionOptions,
    window: MessageWindow,
    history: HistoryWindow,
    restored?: CompactionRecord,
  ) {
    this.key = opts.key;
    this.controller = opts.controller?.({
      recordUsage: (usage) => { this.pendingProviderUsage = addUsage(this.pendingProviderUsage, usage); },
      enqueueAssistant: (text) => this.enqueueAssistant(text),
    });
    const messages = window.messages;
    this.recentHistory = history;
    this.transcriptHistory = new TranscriptHistory(opts.transcriptPath);
    this.cursor.advance(window.offset);
    this.compactor = opts.compaction ? new ContextCompactor({
      ...opts.compaction, model: opts.model, streamFn: opts.streamFn, getApiKey: opts.getApiKey, cursor: this.cursor,
      loadHistory: async function* () {
        for await (const record of scanJsonl(opts.transcriptPath)) {
          if (isTranscriptMessage(record)) yield record;
        }
      },
      save: async (record) => {
        this.writes = this.writes.then(() => appendJsonl(opts.transcriptPath, record));
        await this.writes;
      },
      onCompact: (info) => {
        opts.compaction?.onCompact?.(info);
        this.currentTrace()?.record({ type: "compaction", ...info });
      },
    }, restored) : undefined;
    this.agent = new Agent({
      initialState: {
        systemPrompt: "",
        model: opts.model,
        thinkingLevel: opts.thinking ?? "off",
        tools: this.withControllerTools(opts.tools),
        messages,
      },
      streamFn: this.captureBudgetCause(withContextBudget(this.checkedStream(opts))),
      getApiKey: opts.getApiKey,
      beforeToolCall: tracedGate(this.controller
        ? (context, signal) => this.controller!.beforeToolCall(context, signal, async (ownerContext, ownerSignal) => opts.beforeToolCall?.(ownerContext, ownerSignal))
        : opts.beforeToolCall, this.currentTrace),
      transformContext: this.compactor ? (messages, signal) => this.compactor!.transform(messages, signal) : undefined,
      // Rebuilt before every request so time, window and workspace files are always current.
      prepareRequest: async ({ context }) => {
        let prompt = await opts.buildSystemPrompt();
        if (this.cursor.offset > (this.compactor?.summarizedThrough ?? 0)) {
          prompt += "\n\nOnly the explicit summary and recent messages in this request establish earlier conversation context. Other turns remain on disk; do not assume their contents.";
        }
        return { context: { ...context, messages: withSystemPrompt(context.messages.map(markNotice), prompt) } };
      },
      sessionId: opts.key,
    });
    const traceTools = toolTracer(this.currentTrace);
    this.agent.subscribe((event) => { traceTools(event); return this.onAgentEvent(event); });
    this.releaseHistory();
  }

  /**
   * Every provider request is budget-checked, then evidence-checked; a controller may run its own
   * requests ahead of the checked stream through the unchecked budgeted one.
   */
  private checkedStream(opts: SessionOptions): StreamFn {
    const budgeted = withContextBudget(tracedStream(opts.streamFn, this.currentTrace));
    const checked = withEvidenceBoundary(budgeted, {
      ...opts.evidence,
      onCheck: (detail) => this.currentTrace()?.record({ type: "check", kind: "evidence", detail }),
      tools: () => this.agent.state.tools,
      messages: () => this.agent.state.messages.slice(this.activeRunStart),
      takeUsage: () => this.takePendingProviderUsage(),
      returnUsage: (usage) => { this.pendingProviderUsage = addUsage(this.pendingProviderUsage, usage); },
    });
    return this.controller ? this.controller.wrapStream(checked, () => this.agent.state.tools, budgeted) : checked;
  }

  get busy(): boolean {
    return this.current !== undefined;
  }

  /** A run the runtime started (a source is set) that no owner message has joined. */
  get unattended(): boolean {
    return this.current !== undefined && this.runSource !== undefined && this.pendingOwner === 0;
  }

  /** A quiet-source run that no owner message has joined. */
  private get quiet(): boolean {
    return this.runSource !== undefined && this.pendingOwner === 0 && (this.opts.quietSources?.includes(this.runSource) ?? false);
  }

  /** No run, no queued notice or message and no pending transcript work: safe to dispose and reopen later. */
  get idle(): boolean {
    return !this.current && !this.closing && !this.assistantDrain
      && this.assistantQueue.length === 0 && this.afterStop.length === 0;
  }

  send(text: string, source?: string, requestId?: string): void {
    this.sendMessage(text, source, requestId, true);
  }

  private sendMessage(text: string, source: string | undefined, existingRequestId: string | undefined, registerOwner: boolean): void {
    if (this.closing) return;
    const requestId = !source ? existingRequestId ?? randomUUID() : undefined;
    if (!source && registerOwner) this.controller?.ownerMessage(requestId!, text);
    if (this.assistantDrain || this.phase === "stopping" || this.phase === "finishing") {
      this.afterStop.push({ text, source, ...(requestId ? { requestId } : {}) });
      return;
    }
    if (!this.current) this.controller?.runStarting();
    if (!source) { this.pendingOwner++; this.opts.onOwnerMessage?.(); }
    const message: UserMessage & { vexSource?: string; vexRequestId?: string } = { role: "user", content: text, timestamp: Date.now(), ...(source ? { vexSource: source } : {}), ...(requestId ? { vexRequestId: requestId } : {}) };
    if (this.current) {
      this.currentTrace()?.record({ type: "user", text, ...(source ? { source } : {}) });
      this.agent.steer(message);
      return;
    }
    this.phase = "running";
    this.stopped = false;
    this.runSource = source;
    this.runFailed = false;
    this.runFailureReason = undefined;
    this.observedBudgetFailure = undefined;
    this.failedTools.clear();
    this.lastResponse = undefined;
    this.opts.emit({ kind: "busy", busy: true, ...(source ? { source } : {}), ...(this.quiet ? { quiet: true } : {}) });
    this.opts.trace?.begin({ session: this.key, source: source ?? "owner", model: `${this.opts.model.provider}/${this.opts.model.id}`, text });
    this.activeRunStart = this.agent.state.messages.length;
    this.current = this.run(message)
      .catch((err: unknown) => {
        this.runFailed = true;
        this.runFailureReason = err instanceof ContextBudgetError ? `Context budget failure: ${err.reason}` : err instanceof Error ? err.message : String(err);
        if (err instanceof ContextBudgetError) this.currentTrace()?.record({ type: "check", kind: "budget", detail: err.reason });
        this.opts.onError?.(err);
        if (!this.quiet) this.opts.emit({ kind: "error", message: `Error while handling the message: ${err instanceof Error ? err.message : String(err)}` });
      })
      .finally(async () => {
        const reply = this.successfulReply;
        this.opts.trace?.finish(this.stopped ? "stopped" : this.runFailed ? "error" : "ok",
          { ...(this.runFailureReason ? { error: this.runFailureReason } : {}), ...(reply ? { reply } : {}) });
        this.current = undefined;
        this.phase = "idle";
        // Run-end hooks may enqueue notifications, so drain only after run() (and
        // its final settlement hooks) has completed.
        this.opts.emit({ kind: "busy", busy: false, ...(this.quiet && !this.successfulReply ? { discardReply: true } : {}) });
        this.pendingOwner = 0;
        await this.finishQueuedOwnerMessages().catch((err: unknown) => this.reportError(err));
      });
  }

  stop(): void {
    this.assistantQueue = [];
    this.afterStop = [];
    this.controller?.stopped();
    if (this.phase === "idle") return;
    this.phase = "stopping";
    this.stopped = true;
    this.backoff?.abort();
    this.agent.clearAllQueues();
    this.agent.abort();
  }

  async whenIdle(): Promise<void> {
    for (;;) {
      const pending = this.current ?? this.assistantDrain;
      if (pending) await pending;
      await Promise.resolve();
      if (!this.current && !this.assistantDrain && this.afterStop.length === 0) return;
    }
  }

  async dispose(): Promise<void> {
    this.closing = true;
    this.assistantQueue = [];
    this.stop();
    await this.whenIdle();
    await this.writes;
    this.opts.onDispose?.();
  }

  setTools(tools: AgentTool<any>[]): void { this.agent.state.tools = this.withControllerTools(tools); }

  private withControllerTools(tools: AgentTool<any>[]): AgentTool<any>[] {
    const added = this.controller?.tools() ?? [];
    const names = new Set(added.map((tool) => tool.name));
    return [...tools.filter((tool) => !names.has(tool.name)), ...added];
  }

  private captureBudgetCause(stream: StreamFn): StreamFn {
    return async (model, context, options) => {
      try { return await stream(model, context, options); }
      catch (error) {
        if (error instanceof ContextBudgetError) this.observedBudgetFailure = error.reason;
        throw error;
      }
    };
  }

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
    await this.deliverAssistant(text);
  }

  /** Accept a notification for delivery after the current Agent turn settles. */
  async enqueueAssistant(text: string): Promise<void> {
    if (this.closing) throw new Error("The conversation is closing");
    this.assistantQueue.push(text);
    if (!this.current) void this.finishQueuedOwnerMessages().catch((err: unknown) => this.reportError(err));
  }

  private async finishQueuedOwnerMessages(): Promise<void> {
    await this.drainAssistantQueue();
    if (!this.closing && !this.current && !this.assistantDrain) {
      for (const queued of this.afterStop.splice(0)) this.sendMessage(queued.text, queued.source, queued.requestId, false);
    }
  }

  private async drainAssistantQueue(): Promise<void> {
    if (this.assistantDrain) { await this.assistantDrain; return; }
    if (this.current || this.closing) return;
    this.assistantDrain = Promise.resolve().then(async () => { try {
      while (this.assistantQueue.length && !this.closing) {
        const text = this.assistantQueue.shift();
        if (text === undefined) continue;
        try {
          await this.deliverAssistant(text);
        } catch (err) {
          this.reportError(err);
        }
      }
    } finally {
      this.assistantDrain = undefined;
    } });
    await this.assistantDrain;
  }

  private async deliverAssistant(text: string): Promise<void> {
    if (this.closing) return;
    const message: AssistantMessage & { vexNotice: true } = { role: "assistant", content: [{ type: "text", text }],
      api: this.opts.model.api, provider: this.opts.model.provider, model: this.opts.model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop", timestamp: Date.now(), vexNotice: true };
    this.agent.state.messages.push(message);
    this.recentHistory.add(message);
    this.queueTranscriptWrite(message);
    await this.writes;
    if (!this.current) this.releaseHistory();
    if (!this.closing) this.opts.emit({ kind: "assistant_message", text, stopReason: "stop", timestamp: message.timestamp, injected: true });
  }

  private queueTranscriptWrite(message: AgentMessage): void {
    this.writes = this.writes.catch((err: unknown) => this.reportError(err)).then(() => appendJsonl(this.opts.transcriptPath, message));
  }

  private reportError(err: unknown): void {
    try { this.opts.onError?.(err); } catch { /* logging must not break session settlement */ }
  }

  private takePendingProviderUsage(): AssistantMessage["usage"] {
    const usage = this.pendingProviderUsage;
    this.pendingProviderUsage = zeroUsage();
    return usage;
  }

  private async flushPendingProviderUsage(): Promise<void> {
    const usage = this.pendingProviderUsage;
    if (usage.totalTokens === 0 && usage.cost.total === 0) return;
    this.pendingProviderUsage = zeroUsage();
    await appendJsonl(this.opts.transcriptPath, { type: "provider_usage", usage, timestamp: Date.now() });
  }

  history(): { items: HistoryItem[]; streaming?: string } {
    const streaming = this.agent.state.streamingMessage;
    return { items: this.recentHistory.page().items, streaming: streaming?.role === "assistant" ? assistantText(streaming) : undefined };
  }

  async historyPage(before?: number): Promise<{ items: HistoryItem[]; nextBefore?: number; streaming?: string }> {
    if (before === undefined) return { ...this.recentHistory.page(), streaming: this.history().streaming };
    await this.writes;
    return { ...await this.transcriptHistory.page(before), streaming: this.history().streaming };
  }

  private releaseHistory(): void {
    const messages = this.agent.state.messages;
    const retained = this.compactor?.release(messages) ?? messages;
    const window = new MessageWindow();
    for (const message of retained) window.push(message);
    this.cursor.advance(messages.length - retained.length + window.offset);
    this.agent.state.messages = window.messages;
  }

  private async run(first: UserMessage): Promise<void> {
    try {
    await this.agent.prompt(first);
    await this.settle();
    // A message steered in just as the loop finished is still queued; run it now.
    while (!this.stopping && this.agent.hasQueuedMessages()) {
      await this.agent.continue();
      await this.settle();
    }
    this.beginFinishing();
    await this.writes;
    if (this.pendingOwner && this.successfulReply) {
      await this.opts.onOwnerInteraction?.(this.pendingOwner);
    }
    } finally {
      this.beginFinishing();
      try { await this.writes; await this.flushPendingProviderUsage(); await this.opts.onRunEnd?.(); }
      finally {
        this.controller?.runEnded(new Set(this.afterStop.flatMap((queued) => queued.requestId ? [queued.requestId] : [])));
        this.releaseHistory();
      }
    }
  }

  // A getter, so the phase is reread after every await instead of narrowed.
  private get stopping(): boolean { return this.phase === "stopping"; }

  private beginFinishing(): void {
    if (this.phase === "running") this.phase = "finishing";
  }

  private async settle(): Promise<void> {
    const { attempts, baseDelayMs } = this.opts.retry ?? DEFAULT_RETRY;
    for (let attempt = 1; ; attempt++) {
      const last = this.agent.state.messages.at(-1);
      if (last?.role !== "assistant" || last.stopReason !== "error") return;
      this.pendingProviderUsage = addUsage(this.pendingProviderUsage, last.usage);
      this.agent.state.messages = this.agent.state.messages.slice(0, -1);
      if (this.stopping) { await this.flushPendingProviderUsage(); return; }
      const budgetFailure = last.errorMessage?.includes(CONTEXT_BUDGET_ERROR) ?? false;
      if (attempt > attempts || last.errorMessage === TOOL_EVIDENCE_ERROR || budgetFailure) {
        await this.flushPendingProviderUsage();
        this.runFailed = true;
        this.runFailureReason = budgetFailure
          ? `Context budget failure (${CONTEXT_BUDGET_ERROR}): ${this.observedBudgetFailure ?? "request could not be estimated"}` : last.errorMessage;
        if (budgetFailure) this.currentTrace()?.record({ type: "check", kind: "budget", detail: this.observedBudgetFailure ?? "request could not be estimated" });
        else if (last.errorMessage === TOOL_EVIDENCE_ERROR) this.currentTrace()?.record({ type: "check", kind: "evidence", detail: last.errorMessage });
        const error = new Error(this.runFailureReason ? `Model call failed: ${this.runFailureReason}` : "Model call failed: unknown error");
        this.opts.onError?.(error);
        if (!this.quiet) this.opts.emit({ kind: "error", message: error.message });
        return;
      }
      const backoff = new AbortController();
      this.backoff = backoff;
      // An overloaded provider recovers in minutes, not seconds.
      const delayMs = baseDelayMs * (last.errorMessage?.includes(PROVIDER_OVERLOADED) ? OVERLOAD_BACKOFF : 1) * 2 ** (attempt - 1);
      this.currentTrace()?.record({ type: "retry", attempt, delayMs, error: last.errorMessage ?? "unknown error" });
      try {
        await delay(delayMs, undefined, { signal: backoff.signal });
      } catch {
        await this.flushPendingProviderUsage();
        return;
      } finally {
        this.backoff = undefined;
      }
      if (this.stopping) return;
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
        if (message.role === "toolResult" && message.isError) this.failedTools.add(message.toolName);
        if (message.role === "toolResult") this.controller?.toolResults(this.agent.state.messages);
        // System messages are rebuilt from the current prompt and tools on every start.
        if (message.role === "system") return;
        if (message.role === "assistant" && message.stopReason === "error") return;
        this.recentHistory.add(message);
        this.queueTranscriptWrite(message);
        await this.writes;
        if (message.role === "user") {
          this.opts.emit({ kind: "user_message", text: contentText(message.content), timestamp: message.timestamp, source: (message as UserMessage & { vexSource?: string }).vexSource, requestId: (message as UserMessage & { vexRequestId?: string }).vexRequestId });
        } else if (message.role === "assistant") {
          this.lastResponse = message;
          const text = assistantText(message);
          if ((text || message.stopReason === "aborted") && !(this.quiet && message.stopReason === "aborted")) {
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

const NOTICE_LABEL = "[Runtime notification, already delivered to the owner; do not repeat or restate it]";

/** Notifications and heartbeat reports the runtime delivered stay in the transcript, labelled for the model so it does not echo them. */
function markNotice(message: AgentMessage): AgentMessage {
  if (message.role !== "assistant" || !(message as AssistantMessage & { vexNotice?: boolean }).vexNotice) return message;
  return { ...message, content: [{ type: "text", text: `${NOTICE_LABEL}\n${assistantText(message)}` }] };
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
