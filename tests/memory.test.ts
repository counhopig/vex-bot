/**
 * Memory module — CJK-aware long-term memory (store + embedding + manager).
 *
 * Source-of-truth design notes (per coder-prompt rule #4 — "preserve the
 * safety behavior, not the code"):
 *  - JsonMemoryStore persists via atomic temp-file + rename so a crash or an
 *    overlapping writer can never leave a truncated index.json. Proven by the
 *    read-only-index test below: an in-place writeFileSync would fail EACCES,
 *    an atomic rename succeeds because rename only needs directory write.
 *  - Entries are validated on load: a hand-edited / partially-written index
 *    must not store bogus keys (e.g. `undefined`).
 *  - The index file never carries a dead embeddings cache (`raw.embeddings`
 *    must be undefined) — embeddings live inside each entry.
 *  - SimpleEmbedding is stateless (stable FNV-1a hashing trick): the same
 *    text always yields the same vector regardless of prior embed() calls or
 *    process restarts, and embedding a query mutates nothing. This is what
 *    makes stored vectors and query vectors comparable across restarts.
 *  - SimpleEmbedding tokenizes through the CJKTokenizer, so Chinese/Japanese/
 *    Korean text is decomposed into bigrams instead of collapsing into one
 *    useless token (architecture principle #6).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

vi.mock("../src/utils/logger.js", () => ({
  getChildLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  MemoryManager,
  createMemoryManager,
  JsonMemoryStore,
  SimpleEmbedding,
  cosineSimilarity,
  type MemoryEntry,
} from "../src/memory/index.js";

// Each test gets its own temp dir under os.tmpdir(); cleaned in afterEach.
const tempDirs: string[] = [];

function getTestDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vex-memory-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("JsonMemoryStore", () => {
  it("expands home directory shorthand in a custom path", () => {
    const dirName = `.vex-memory-expand-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const expandedDir = path.join(os.homedir(), dirName);
    const literalDir = path.join(process.cwd(), "~", dirName);

    try {
      new JsonMemoryStore({ directory: `~/${dirName}` });
      expect(fs.existsSync(expandedDir)).toBe(true);
      expect(fs.existsSync(literalDir)).toBe(false);
    } finally {
      fs.rmSync(expandedDir, { recursive: true, force: true });
      fs.rmSync(literalDir, { recursive: true, force: true });
    }
  });

  it("persists via atomic rename and leaves no temp file behind", async () => {
    const testDir = getTestDir();
    const indexFile = path.join(testDir, "index.json");
    // Seed a valid but read-only index; the directory stays writable. An
    // in-place writeFileSync would fail (EACCES) and silently drop the add,
    // but an atomic temp-write + rename replaces it (rename needs dir write,
    // not file write) — proving the write never truncates the live index.
    fs.writeFileSync(
      indexFile,
      JSON.stringify({ version: 2, entries: [] }),
    );
    fs.chmodSync(indexFile, 0o444);
    try {
      const store = new JsonMemoryStore({ directory: testDir });
      const id = await store.add({
        content: "survives",
        metadata: { type: "note", timestamp: Date.now() },
      });

      const reopened = new JsonMemoryStore({ directory: testDir });
      expect(await reopened.get(id)).toBeDefined();
      expect(fs.existsSync(indexFile + ".tmp")).toBe(false);
    } finally {
      fs.chmodSync(indexFile, 0o644);
    }
  });

  it("creates a store and adds entries, returning a string id", async () => {
    const store = new JsonMemoryStore({ directory: getTestDir() });
    const id = await store.add({
      content: "Test memory content",
      metadata: { type: "note", timestamp: Date.now() },
    });
    expect(id).toBeDefined();
    expect(typeof id).toBe("string");
  });

  it("retrieves an entry by id with its metadata", async () => {
    const store = new JsonMemoryStore({ directory: getTestDir() });
    const id = await store.add({
      content: "Retrievable content",
      metadata: { type: "fact", timestamp: Date.now(), tags: ["test"] },
    });
    const entry = await store.get(id);
    expect(entry?.content).toBe("Retrievable content");
    expect(entry?.metadata.type).toBe("fact");
    expect(entry?.metadata.tags).toContain("test");
  });

  it("returns undefined for a non-existent id", async () => {
    const store = new JsonMemoryStore({ directory: getTestDir() });
    expect(await store.get("non-existent-id")).toBeUndefined();
  });

  it("deletes an entry, returning true", async () => {
    const store = new JsonMemoryStore({ directory: getTestDir() });
    const id = await store.add({
      content: "To be deleted",
      metadata: { type: "note", timestamp: Date.now() },
    });
    expect(await store.delete(id)).toBe(true);
    expect(await store.get(id)).toBeUndefined();
  });

  it("returns false when deleting a non-existent entry", async () => {
    const store = new JsonMemoryStore({ directory: getTestDir() });
    expect(await store.delete("non-existent")).toBe(false);
  });

  it("lists entries with type and tag filtering", async () => {
    const store = new JsonMemoryStore({ directory: getTestDir() });
    await store.add({
      content: "Fact 1",
      metadata: { type: "fact", timestamp: Date.now(), tags: ["tag1"] },
    });
    await store.add({
      content: "Note 1",
      metadata: { type: "note", timestamp: Date.now(), tags: ["tag2"] },
    });
    await store.add({
      content: "Fact 2",
      metadata: { type: "fact", timestamp: Date.now(), tags: ["tag1", "tag2"] },
    });

    expect(await store.list()).toHaveLength(3);
    expect(await store.list({ type: "fact" })).toHaveLength(2);
    expect(await store.list({ tags: ["tag1"] })).toHaveLength(2);
    expect(await store.list({ tags: ["tag2"] })).toHaveLength(2);
  });

  it("searches entries by keyword content similarity", async () => {
    const store = new JsonMemoryStore({ directory: getTestDir() });
    await store.add({
      content: "The weather is sunny today",
      metadata: { type: "note", timestamp: Date.now() },
    });
    await store.add({
      content: "I love programming in TypeScript",
      metadata: { type: "note", timestamp: Date.now() },
    });

    const results = await store.search("sunny weather", 2);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.score).toBeDefined();
    expect(results[0]?.content).toContain("weather");
  });

  it("clears all entries", async () => {
    const store = new JsonMemoryStore({ directory: getTestDir() });
    await store.add({
      content: "Entry 1",
      metadata: { type: "note", timestamp: Date.now() },
    });
    await store.add({
      content: "Entry 2",
      metadata: { type: "note", timestamp: Date.now() },
    });
    await store.clear();
    expect(await store.list()).toHaveLength(0);
  });

  it("persists entries across store instances", async () => {
    const testDir = getTestDir();
    const store1 = new JsonMemoryStore({ directory: testDir });
    const id = await store1.add({
      content: "Persistent content",
      metadata: { type: "note", timestamp: Date.now() },
    });
    const store2 = new JsonMemoryStore({ directory: testDir });
    expect((await store2.get(id))?.content).toBe("Persistent content");
  });

  it("skips malformed entries when loading a corrupt-ish index", async () => {
    const testDir = getTestDir();
    fs.writeFileSync(
      path.join(testDir, "index.json"),
      JSON.stringify({
        version: 2,
        entries: [
          { id: "good", content: "kept", metadata: { type: "note", timestamp: 1 } },
          { content: "no id — should be skipped", metadata: { type: "note", timestamp: 1 } },
          null,
          "not an object",
        ],
      }),
    );
    const store = new JsonMemoryStore({ directory: testDir });
    expect((await store.list()).map((e) => e.id)).toEqual(["good"]);
  });

  it("does not write a dead embeddings cache into the index", async () => {
    const testDir = getTestDir();
    const store = new JsonMemoryStore({ directory: testDir });
    await store.add({
      content: "x",
      embedding: [0.1, 0.2],
      metadata: { type: "note", timestamp: 1 },
    });
    const raw = JSON.parse(
      fs.readFileSync(path.join(testDir, "index.json"), "utf-8"),
    );
    expect(raw.embeddings).toBeUndefined();
    expect(raw.entries).toHaveLength(1);
  });
});

describe("SimpleEmbedding", () => {
  it("is stateless and deterministic regardless of prior history", async () => {
    const fresh = new SimpleEmbedding();
    const primed = new SimpleEmbedding();
    // Prior unrelated documents must not shift the target embedding.
    await primed.embed(["totally unrelated noise", "more filler documents here"]);
    const [a] = await fresh.embed(["the quick brown fox"]);
    const [b] = await primed.embed(["the quick brown fox"]);
    expect(b).toEqual(a);
  });

  it("does not mutate state when embedding (no read-path side effects)", async () => {
    const embedding = new SimpleEmbedding();
    const [before] = await embedding.embed(["hello world"]);
    // Embedding queries in between must not change future embeddings.
    await embedding.embed(["some query", "another query"]);
    const [after] = await embedding.embed(["hello world"]);
    expect(after).toEqual(before);
  });

  it("produces a 256-dim L2-normalized vector for Latin text", async () => {
    const embedding = new SimpleEmbedding();
    const [vector] = await embedding.embed(["hello world"]);
    expect(vector).toHaveLength(embedding.dimension);
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it("tokenizes CJK text into bigrams instead of one collapsed token", async () => {
    // "用户名字" (4 CJK chars) must not collapse into a single useless token
    // (architecture principle #6 — CJK-native). With bigrams it maps to
    // ["用户","户名","名字"], each of which lands in a hash bucket; a vector
    // built from it must differ from an unrelated Latin-only vector.
    const embedding = new SimpleEmbedding();
    const [cjk] = await embedding.embed(["用户名字"]);
    const [latin] = await embedding.embed(["abcdefghijklmnop"]);
    expect(cjk.some((v) => v !== 0)).toBe(true);
    expect(cjk).not.toEqual(latin);
  });

  it("returns comparable vectors for similar CJK text", async () => {
    const embedding = new SimpleEmbedding();
    const [a] = await embedding.embed(["用户名字是 counhopig"]);
    const [b] = await embedding.embed(["用户名字"]);
    const [c] = await embedding.embed(["the weather is sunny"]);
    const simAB = cosineSimilarity(a, b);
    const simAC = cosineSimilarity(a, c);
    expect(simAB).toBeGreaterThan(simAC);
  });
});

describe("MemoryManager", () => {
  it("creates a manager with default config", async () => {
    const manager = new MemoryManager({ directory: getTestDir() });
    expect(manager).toBeDefined();
    expect(manager.isEnabled).toBe(true);
    await manager.close();
  });

  it("creates a manager via the createMemoryManager factory", async () => {
    const manager = createMemoryManager({ directory: getTestDir() });
    expect(manager).toBeDefined();
    await manager.close();
  });

  it("remembers and recalls content", async () => {
    const manager = new MemoryManager({ directory: getTestDir(), enabled: true });
    const id = await manager.remember("Important fact to remember", {
      type: "fact",
      tags: ["important"],
    });
    expect(id).toBeDefined();

    const results = await manager.recall("important fact", 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.content).toContain("Important fact");
    await manager.close();
  });

  it("gets a memory by id", async () => {
    const manager = new MemoryManager({ directory: getTestDir(), enabled: true });
    const id = await manager.remember("Specific memory", { type: "note" });
    expect((await manager.get(id!))?.content).toBe("Specific memory");
    await manager.close();
  });

  it("forgets a memory by id", async () => {
    const manager = new MemoryManager({ directory: getTestDir(), enabled: true });
    const id = await manager.remember("To forget", { type: "note" });
    expect(await manager.forget(id!)).toBe(true);
    expect(await manager.get(id!)).toBeUndefined();
    await manager.close();
  });

  it("lists memories with a filter", async () => {
    const manager = new MemoryManager({ directory: getTestDir(), enabled: true });
    await manager.remember("Code snippet", { type: "code" });
    await manager.remember("Random note", { type: "note" });
    const code = await manager.list({ type: "code" });
    expect(code).toHaveLength(1);
    expect(code[0]?.metadata.type).toBe("code");
    await manager.close();
  });

  it("returns empty results when disabled", async () => {
    const manager = new MemoryManager({ directory: getTestDir(), enabled: false });
    expect(await manager.remember("This won't be saved", { type: "note" })).toBeNull();
    expect(await manager.recall("anything", 5)).toEqual([]);
    expect(await manager.list()).toEqual([]);
    expect(await manager.get("x")).toBeUndefined();
    expect(await manager.forget("x")).toBe(false);
    await manager.close();
  });

  it("formats memories for context", async () => {
    const manager = new MemoryManager({ directory: getTestDir(), enabled: true });
    const entries: MemoryEntry[] = [
      {
        id: "1",
        content: "First memory",
        metadata: { type: "fact", timestamp: Date.now() },
        score: 0.95,
      },
      {
        id: "2",
        content: "Second memory",
        metadata: { type: "note", timestamp: Date.now() },
        score: 0.8,
      },
    ];
    const formatted = manager.formatForContext(entries);
    expect(formatted).toContain("Relevant Memories");
    expect(formatted).toContain("First memory");
    expect(formatted).toContain("Second memory");
    expect(formatted).toContain("95%");
    await manager.close();
  });

  it("returns an empty string for empty entries", async () => {
    const manager = new MemoryManager({ directory: getTestDir(), enabled: true });
    expect(manager.formatForContext([])).toBe("");
    await manager.close();
  });

  it("keeps one manager's data isolated from another manager's", async () => {
    const managerA = new MemoryManager({ directory: getTestDir(), enabled: true });
    const managerB = new MemoryManager({ directory: getTestDir(), enabled: true });
    await managerA.remember("A's private fact", { type: "fact" });
    await managerB.remember("B's private fact", { type: "fact" });

    const aResults = await managerA.recall("private fact", 10);
    const bResults = await managerB.recall("private fact", 10);
    expect(aResults.map((r) => r.content)).toContain("A's private fact");
    expect(aResults.map((r) => r.content)).not.toContain("B's private fact");
    expect(bResults.map((r) => r.content)).toContain("B's private fact");
    expect(bResults.map((r) => r.content)).not.toContain("A's private fact");
    await managerA.close();
    await managerB.close();
  });
});
