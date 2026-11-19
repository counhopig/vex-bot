import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { isCompactionRecord, type CompactionRecord } from "../context/compaction.js";
import type { Usage } from "../providers/usage.js";
import { zeroUsage } from "../providers/usage.js";
import { scanJsonl, scanJsonlLines } from "../store/jsonl.js";

/** The `vex*` metadata a transcript record may carry; the disk fields keep these exact names. */
export interface TranscriptMeta {
  /** The runtime source that sent this user message; owner messages have none. */
  source?: string;
  /** A bus-facing id linking an owner message back to its delivery (WeChat message id). */
  requestId?: string;
  /** True for runtime-injected notices the model must not echo back. */
  notice?: boolean;
  /** The trace run that produced this message, linking memory hits back to their run. */
  run?: string;
}

/**
 * The single boundary for the `vex*` fields stored beside transcript messages. The flat on-disk
 * shape is unchanged — old files remain readable — but no other module reads or writes these
 * fields directly.
 */
export function transcriptMeta(message: AgentMessage): TranscriptMeta {
  const record = message as { vexSource?: unknown; vexRequestId?: unknown; vexNotice?: unknown; vexRun?: unknown };
  return {
    ...(record.vexSource !== undefined ? { source: record.vexSource as string } : {}),
    ...(record.vexRequestId !== undefined ? { requestId: record.vexRequestId as string } : {}),
    ...(record.vexNotice === true ? { notice: true } : {}),
    ...(record.vexRun !== undefined ? { run: record.vexRun as string } : {}),
  };
}

/** An owner or runtime user message, carrying its source and delivery id in the transcript. */
export function attachTranscriptMeta(message: UserMessage, meta: { source?: string; requestId?: string }): UserMessage {
  return { ...message, ...(meta.source !== undefined ? { vexSource: meta.source } : {}), ...(meta.requestId !== undefined ? { vexRequestId: meta.requestId } : {}) };
}

/** A runtime notice for the transcript: delivered to the owner, labelled for the model. */
export function noticeAssistantMessage(text: string, model: { api: AssistantMessage["api"]; provider: string; id: string }): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: zeroUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
    vexNotice: true,
  } as unknown as AssistantMessage;
}

/** Stamps the trace run a message belongs to, so a memory hit can be traced back to its run. */
export function withRun(message: AgentMessage, run: string | undefined): AgentMessage {
  return run === undefined ? message : { ...message, vexRun: run } as unknown as AgentMessage;
}

/** True for messages the runtime delivered as notices; `transcriptMeta(message).notice` in typed form. */
export function isNotice(message: AgentMessage): boolean {
  return (message as { vexNotice?: unknown }).vexNotice === true;
}


/**
 * One record of a session transcript, classified for every consumer: a message, a compaction
 * checkpoint, a usage flush, or something unread that all readers skip.
 */
export type TranscriptEntry =
  | { type: "message"; message: AgentMessage }
  | { type: "compaction"; compaction: CompactionRecord }
  | { type: "provider_usage"; usage: Usage; timestamp: number | undefined }
  | { type: "unknown" };

export function isTranscriptMessage(value: unknown): value is AgentMessage {
  if (!value || typeof value !== "object") return false;
  const role = (value as { role?: unknown }).role;
  return role === "user" || role === "assistant" || role === "toolResult";
}

/** The single definition of what a transcript line means, shared by session restore, history paging and memory indexing. */
export function classifyTranscriptRecord(record: unknown): TranscriptEntry {
  if (isTranscriptMessage(record)) return { type: "message", message: record };
  if (isCompactionRecord(record)) return { type: "compaction", compaction: record };
  if (record && typeof record === "object" && !Array.isArray(record) && (record as { type?: unknown }).type === "provider_usage") {
    const usage = (record as { usage?: unknown }).usage;
    const timestamp = (record as { timestamp?: unknown }).timestamp;
    if (usage && typeof usage === "object") {
      return { type: "provider_usage", usage: usage as Usage, timestamp: typeof timestamp === "number" ? timestamp : undefined };
    }
  }
  return { type: "unknown" };
}

export async function* scanTranscript(path: string): AsyncGenerator<TranscriptEntry> {
  for await (const record of scanJsonl(path)) yield classifyTranscriptRecord(record);
}

export interface TranscriptLine { entry: TranscriptEntry; start: number; end: number; complete: boolean }

/** Like `scanTranscript`, but keeps byte ranges so history paging can index checkpoints. */
export async function* scanTranscriptLines(path: string, from = 0): AsyncGenerator<TranscriptLine> {
  for await (const { record, start, end, complete } of scanJsonlLines(path, from)) {
    yield { entry: classifyTranscriptRecord(record), start, end, complete };
  }
}
