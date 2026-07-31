/**
 * Session-management type definitions.
 *
 * Two layers live under one sessionKey on disk:
 *   1. THIS module's flat `<sessionId>.jsonl` — the source of truth for the
 *      WebChat UI (session list + history panel).
 *   2. pi-coding-agent's nested per-session event logs — the source of
 *      truth for the LLM conversation context.
 *
 * Both are keyed off the same `sessionKey` (the channel-and-sender pair).
 * The store's `recoverIndexFromTranscripts` reads pi's logs back into the
 * flat index but never writes into pi's files.
 */

/** On-disk index entry. */
export interface SessionEntry {
  sessionId: string;
  sessionKey: string;
  label?: string;
  createdAt: number;
  updatedAt: number;
  transcriptFile?: string;
  channel?: string;
  messageCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  model?: string;
  provider?: string;
}

/** Trimmed shape returned by `list()` for the WebChat sidebar. */
export interface SessionListItem {
  sessionKey: string;
  sessionId: string;
  label?: string;
  updatedAt: number;
  messageCount?: number;
  totalTokens?: number;
  model?: string;
  provider?: string;
}

/** A single line in a transcript file. */
export interface TranscriptMessage {
  id?: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp: number;
  toolName?: string;
  toolCallId?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  model?: string;
  provider?: string;
}

/** First line of a transcript file. */
export interface TranscriptHeader {
  type: "session";
  version: number;
  sessionId: string;
  sessionKey: string;
  timestamp: string;
  cwd?: string;
}

/** Filters for `list()`. */
export interface SessionListOptions {
  limit?: number;
  /** Only entries whose `updatedAt >= now - activeMinutes*60_000`. */
  activeMinutes?: number;
  /** Case-insensitive substring match against `sessionKey` and `label`. */
  search?: string;
}
