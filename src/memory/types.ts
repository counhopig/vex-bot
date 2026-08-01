/**
 * Memory types — core data shapes for the memory system.
 *
 * Migrated from _archive/src/memory/types.ts unchanged: the entry shape,
 * list filter, store contract, and embedding provider contract are all
 * part of the persisted-data contract (index.json) and must not drift.
 */

/** A single memory entry — the persisted unit in index.json. */
export interface MemoryEntry {
  id: string;
  content: string;
  /** Optional stable hashing-trick vector; absent when embedding failed. */
  embedding?: number[];
  metadata: {
    type: "conversation" | "fact" | "note" | "code";
    source?: string;
    timestamp: number;
    tags?: string[];
  };
  /** Relevance score populated by recall()/search() — never persisted. */
  score?: number;
}

/** Filter for listing entries. */
export interface MemoryListFilter {
  type?: string;
  tags?: string[];
  since?: number;
  until?: number;
  limit?: number;
  offset?: number;
}

/** Store-specific status information. */
export interface MemoryStoreStatus {
  entries: number;
  size?: number;
  backend: "json";
  [key: string]: unknown;
}

/** Abstract storage layer contract. */
export interface MemoryStore {
  add(entry: Omit<MemoryEntry, "id">): Promise<string>;
  search(query: string, limit?: number): Promise<MemoryEntry[]>;
  get(id: string): Promise<MemoryEntry | undefined>;
  delete(id: string): Promise<boolean>;
  list(filter?: MemoryListFilter): Promise<MemoryEntry[]>;
  clear(): Promise<void>;
  close?(): Promise<void>;
  status?(): MemoryStoreStatus;
}

/** Embedding provider contract — the only implementation is SimpleEmbedding. */
export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
  dimension: number;
}
