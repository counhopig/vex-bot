import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { isCompactionRecord, type CompactionRecord } from "../context/compaction.js";
import type { Usage } from "../providers/usage.js";
import { scanJsonl, scanJsonlLines } from "../store/jsonl.js";

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
