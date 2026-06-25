/**
 * Session management type definitions
 * Reference: moltbot's session management system
 */

import type { ChatMessage } from "../types/index.js";

/** Session entry */
export interface SessionEntry {
  /** Session ID */
  sessionId: string;
  /** Session key (used for indexing) */
  sessionKey: string;
  /** Label / display name */
  label?: string;
  /** Creation time */
  createdAt: number;
  /** Last update time */
  updatedAt: number;
  /** Transcript file path */
  transcriptFile?: string;
  /** Source channel */
  channel?: string;
  /** Message count */
  messageCount?: number;
  /** Input token stats */
  inputTokens?: number;
  /** Output token stats */
  outputTokens?: number;
  /** Total token stats */
  totalTokens?: number;
  /** Model used */
  model?: string;
  /** Provider used */
  provider?: string;
}

/** Session list item (for frontend display) */
export interface SessionListItem {
  sessionKey: string;
  sessionId: string;
  label?: string;
  updatedAt: number;
  messageCount?: number;
  totalTokens?: number;
  model?: string;
}

/** Transcript message entry */
export interface TranscriptMessage {
  /** Message ID */
  id?: string;
  /** Role */
  role: "user" | "assistant" | "system" | "tool";
  /** Content */
  content: string | ChatMessage["content"];
  /** Timestamp */
  timestamp: number;
  /** Tool calls */
  tool_calls?: ChatMessage["tool_calls"];
  /** Tool call ID */
  tool_call_id?: string;
  /** Token usage */
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  /** Model */
  model?: string;
  /** Provider */
  provider?: string;
}

/** Transcript file header */
export interface TranscriptHeader {
  type: "session";
  version: number;
  sessionId: string;
  sessionKey: string;
  timestamp: string;
  cwd?: string;
}

/** Session store interface */
export interface SessionStore {
  /** List all sessions */
  list(options?: SessionListOptions): Promise<SessionListItem[]>;
  /** Get a session */
  get(sessionKey: string): Promise<SessionEntry | null>;
  /** Create or update a session */
  upsert(entry: SessionEntry): Promise<void>;
  /** Delete a session */
  delete(sessionKey: string): Promise<void>;
  /** Reset a session */
  reset(sessionKey: string): Promise<SessionEntry>;
}

/** Session list options */
export interface SessionListOptions {
  /** Limit number of results */
  limit?: number;
  /** Filter by active time (minutes) */
  activeMinutes?: number;
  /** Search keyword */
  search?: string;
}

/** Transcript manager interface */
export interface TranscriptManager {
  /** Load transcript records */
  load(sessionId: string): Promise<TranscriptMessage[]>;
  /** Append a message */
  append(sessionId: string, message: TranscriptMessage): Promise<void>;
  /** Clear transcript */
  clear(sessionId: string): Promise<void>;
}
