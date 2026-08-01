/**
 * MemoryManager — long-term memory with hybrid vector + keyword recall.
 *
 * Class-based and instantiated per Agent (architecture principle #5: no
 * process-global state bleeding across instances). The archive's design is
 * preserved: each manager owns its own JsonMemoryStore + SimpleEmbedding, so
 * two managers (two users / two agents) never share an index.
 *
 * Safety behaviors preserved from _archive/src/memory/manager.ts:
 *  - remember() catches embedding failures and stores the entry without a
 *    vector (null-safe in recall() scoring) — embedding must never be a
 *    hard dependency of remembering.
 *  - recall() never throws: search failures degrade to [].
 *  - enabled=false short-circuits every operation (remember → null, others
 *    → empty/false), matching the archived contract.
 */

import { getChildLogger } from "../utils/logger.js";
import type { MemoryEntry, EmbeddingProvider, MemoryListFilter } from "./types.js";
import { JsonMemoryStore, cosineSimilarity } from "./JsonMemoryStore.js";
import { SimpleEmbedding } from "./embedding/SimpleEmbedding.js";

const logger = getChildLogger("memory-manager");

export interface MemoryManagerOptions {
  enabled?: boolean;
  directory?: string;
}

export class MemoryManager {
  private store: JsonMemoryStore;
  private embedding: EmbeddingProvider;
  private _enabled: boolean;

  constructor(options?: MemoryManagerOptions) {
    this._enabled = options?.enabled ?? true;
    this.store = new JsonMemoryStore({ directory: options?.directory });
    this.embedding = new SimpleEmbedding();
  }

  /** Store a memory. Returns the new entry id, or null when disabled. */
  async remember(
    content: string,
    metadata?: Partial<MemoryEntry["metadata"]>,
  ): Promise<string | null> {
    if (!this._enabled) return null;

    let embedding: number[] | undefined;

    try {
      const [emb] = await this.embedding.embed([content]);
      embedding = emb;
    } catch (error) {
      logger.warn({ error }, "Failed to generate embedding");
    }

    return this.store.add({
      content,
      embedding,
      metadata: {
        type: metadata?.type ?? "note",
        source: metadata?.source,
        timestamp: metadata?.timestamp ?? Date.now(),
        tags: metadata?.tags,
      },
    });
  }

  /** Search memories by hybrid vector + keyword score. Never throws. */
  async recall(query: string, limit = 5): Promise<MemoryEntry[]> {
    if (!this._enabled || !query.trim()) {
      return [];
    }

    try {
      const [queryEmbedding] = await this.embedding.embed([query]);
      const entries = await this.store.search(query, limit * 3);

      if (entries.length === 0) {
        return [];
      }

      const results: Array<MemoryEntry & { vectorScore: number; textScore: number }> = [];

      for (const entry of entries) {
        const vectorScore = entry.embedding && queryEmbedding
          ? cosineSimilarity(queryEmbedding, entry.embedding)
          : 0;
        const textScore = this.computeTextScore(query, entry.content);

        results.push({
          ...entry,
          vectorScore,
          textScore,
          score: vectorScore * 0.7 + textScore * 0.3,
        });
      }

      return results
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, limit)
        .map((r) => ({
          id: r.id,
          content: r.content,
          embedding: r.embedding,
          metadata: r.metadata,
          score: r.score,
        }));
    } catch (error) {
      logger.error({ error, query }, "Memory search failed");
      return [];
    }
  }

  /** Keyword match ratio (0.7) + position bonus (0.3), 0..1. */
  private computeTextScore(query: string, content: string): number {
    const queryWords = query.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
    if (queryWords.length === 0) return 0;

    const contentLower = content.toLowerCase();
    let matchCount = 0;
    let positionBonus = 0;

    for (const word of queryWords) {
      const index = contentLower.indexOf(word);
      if (index !== -1) {
        matchCount++;
        positionBonus += 1 / (index + 1);
      }
    }

    const matchRatio = matchCount / queryWords.length;
    const positionFactor = positionBonus / queryWords.length;

    return matchRatio * 0.7 + positionFactor * 0.3;
  }

  /** Get a memory by id. */
  async get(id: string): Promise<MemoryEntry | undefined> {
    if (!this._enabled) return undefined;
    return this.store.get(id);
  }

  /** Delete a memory by id. Returns whether it existed. */
  async forget(id: string): Promise<boolean> {
    if (!this._enabled) return false;
    return this.store.delete(id);
  }

  /** List memories with optional type/tag filtering. */
  async list(filter?: MemoryListFilter): Promise<MemoryEntry[]> {
    if (!this._enabled) return [];
    return this.store.list(filter);
  }

  /** Clear all memories. */
  async clearAll(): Promise<void> {
    if (!this._enabled) return;
    await this.store.clear();
  }

  /** Format entries for prompt injection. Empty input → "". */
  formatForContext(entries: MemoryEntry[]): string {
    if (entries.length === 0) return "";

    const lines = ["## Relevant Memories", ""];
    for (const entry of entries) {
      const date = new Date(entry.metadata.timestamp).toLocaleDateString();
      const score = entry.score ? ` (relevance: ${(entry.score * 100).toFixed(0)}%)` : "";
      lines.push(
        `- [${entry.metadata.type}] ${entry.content.slice(0, 200)}${score} (${date})`,
      );
    }
    return lines.join("\n");
  }

  /** Flush pending writes. */
  async close(): Promise<void> {
    await this.store.close();
  }

  /** Enable/disable the manager at runtime. */
  set enabled(value: boolean) {
    this._enabled = value;
  }

  get isEnabled(): boolean {
    return this._enabled;
  }
}

/** Factory — creates a fresh per-owner MemoryManager (never a singleton). */
export function createMemoryManager(options?: MemoryManagerOptions): MemoryManager {
  return new MemoryManager(options);
}
