/**
 * Simple Local Embedding Provider
 *
 * Stateless hashing-trick embedding for local/offline use. Each token is mapped
 * to a fixed vector slot by a stable hash, and the vector is normalized term
 * frequency. Because there is no mutable vocabulary, index counter, or idf that
 * drifts as documents are embedded, the embedding of a given text is:
 *   - deterministic (same text -> same vector, always),
 *   - independent of what else was embedded before or of process restarts, and
 *   - side-effect free (embedding a query does not mutate any state).
 * This is what makes stored embeddings and query embeddings comparable — the
 * previous stateful TF-IDF made vector search unreliable across restarts.
 */

import type { EmbeddingProvider } from "./types.js";

export class SimpleEmbedding implements EmbeddingProvider {
  dimension = 256;

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s一-鿿]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 0);
  }

  /** Stable FNV-1a hash of a token into a vector slot. */
  private slotFor(token: string): number {
    let hash = 2166136261;
    for (let i = 0; i < token.length; i++) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) % this.dimension;
  }

  private computeVector(tokens: string[]): number[] {
    const vector = new Array(this.dimension).fill(0);
    if (tokens.length === 0) return vector;

    const tf = new Map<string, number>();
    for (const token of tokens) {
      tf.set(token, (tf.get(token) ?? 0) + 1);
    }
    for (const [token, count] of tf) {
      vector[this.slotFor(token)] += count / tokens.length;
    }

    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
    return vector.map((v) => v / norm);
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.computeVector(this.tokenize(text)));
  }

  async embedQuery(text: string): Promise<number[]> {
    const [embedding] = await this.embed([text]);
    return embedding ?? new Array(this.dimension).fill(0);
  }
}
