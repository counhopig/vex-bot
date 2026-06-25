# Memory Module

Long-term cross-session memory with local TF-IDF embedding and JSON file persistence. Zero external API dependencies.

## OVERVIEW

MemoryManager wraps JsonMemoryStore + SimpleEmbedding. Entries persist to `~/.vex/memory/index.json` (version 2 format: entries array + embeddings cache). Vocabulary is 256-dim TF-IDF with LRU eviction at 50k tokens. Hybrid scoring: cosine similarity (weight 0.7) + keyword match with position bonus (0.3). Created once in `createAgent()` if `config.memory` exists and `enabled !== false`. Injected into tools via `setMemoryManager()` singleton.

## STRUCTURE

```
memory/
├── manager.ts        # MemoryManager: remember(), recall(), forget(), list(), clearAll(),
│                     #              formatForContext(), enabled toggle
├── store.ts          # JsonMemoryStore: JSON file CRUD, keyword search, cosineSimilarity()
│                     #               embedding cache with LRU pruning, dirty-flag save
├── embedding.ts      # SimpleEmbedding: TF-IDF tokenizer, vocab management, vector compute
├── types.ts          # MemoryEntry, MemoryStore, EmbeddingProvider, MemoryListFilter
└── index.ts          # Barrel: named re-exports of all public symbols
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Entry shape | `types.ts:MemoryEntry` | `{id, content, embedding?, metadata: {type, source, timestamp, tags}, score?}` |
| Store/query flow | `manager.ts:remember()` / `recall()` | embeds content → adds to store → saves index |
| Hybrid scoring | `manager.ts:recall()` line 88 | `score = vectorScore * 0.7 + textScore * 0.3` |
| Text scoring | `manager.ts:computeTextScore()` | Keyword match ratio (0.7) + position bonus (0.3) |
| JSON persistence | `store.ts:saveIndex()` | Writes only when dirty; `index.json` with `version: 2` |
| Embedding cache | `store.ts:embeddingCache` | `Map<contentHash, number[]>`; prunes to `maxCacheEntries` (default 1000) |
| Vocab eviction | `embedding.ts:evictLeastRecentlyUsed()` | Removes oldest 10% when vocab hits 50000 |
| Agent wiring | `agent.ts:createAgent()` line 187-193 | Dynamic `import("../memory/index.js")`, passed to `createMemoryTools()` |
| Tool definitions | `tools/builtin/memory.ts` | 4 tools: `memory_search`, `memory_store`, `memory_list`, `memory_delete` |
| Tool injection | `tools/builtin/memory.ts:createMemoryTools()` | Sets singleton via `setMemoryManager()`, tools call `getManager()` |

## EMBEDDING

SimpleEmbedding implements `EmbeddingProvider`. 256-dim vectors. Tokenizer strips punctuation, splits on whitespace, keeps CJK characters (U+4e00-9fff). TF-IDF: term frequency normalized by doc length, IDF computed as `log((docCount + 1) / (docFreq + 1)) + 1`. Vector values are modulo-mapped to dimension 256 (hash bucket style). Final L2-normalized. Vocabulary is cumulative across all `embed()` calls; `updateVocabulary()` increments `docCount` and `docFreq` per token. Stateful across the MemoryManager lifetime, not per-query.

## ANTI-PATTERNS

- **NEVER create MemoryManager inside tool execute()** — singleton injected at Agent init; tools call `getManager()` which returns null if disabled
- **NEVER hardcode storage paths** — always construct via `MemoryManager` constructor's `directory` option, defaulting to `os.homedir()/.vex/memory`
- **NEVER bypass dirty-flag save** — calling `store.add()`/`delete()` sets dirty=true; `saveIndex()` only writes when dirty; concurrent writes without dirty check cause data loss
- **NEVER cast `config.memory` shape directly** — guard with `config.memory?.enabled !== false && config.memory` before constructing
- **NEVER assume embedding is available** — `remember()` catches embedding failures and stores without vector (null-safe in `recall()` scoring)
- **NEVER mutate entries from the outside** — `store.search()` returns copied entries but `store.list()` returns raw references if you hold the Map
- **NEVER add external embedding APIs** — the contract is local-only; SimpleEmbedding is the single implementation of `EmbeddingProvider`
