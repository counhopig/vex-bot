/**
 * Memory System — CJK-aware long-term memory.
 *
 * Class-based, per-Agent instantiation. No module-level singletons exported
 * (the archive's `getMemoryManager`-style global state is gone): every
 * consumer constructs its own `MemoryManager` / `JsonMemoryStore` scoped to
 * its owner's directory.
 */

// Core types
export type {
  MemoryEntry,
  MemoryStore,
  MemoryListFilter,
  MemoryStoreStatus,
  EmbeddingProvider,
} from "./types.js";

// Memory Manager
export {
  MemoryManager,
  createMemoryManager,
  type MemoryManagerOptions,
} from "./MemoryManager.js";

// Storage
export { JsonMemoryStore, cosineSimilarity, generateMemoryId } from "./JsonMemoryStore.js";

// Embedding
export { SimpleEmbedding } from "./embedding/SimpleEmbedding.js";

// Tokenizer (re-exported for convenience — the embedding layer consumes it)
export type { Tokenizer } from "./tokenizer/Tokenizer.js";
export { CJKTokenizer, tokenize } from "./tokenizer/CJKTokenizer.js";
