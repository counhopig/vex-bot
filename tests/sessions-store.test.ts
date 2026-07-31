/**
 * Session store — WebChat UI session list + per-session transcript persistence.
 *
 * Source-of-truth design notes (per review-rule #5 — "preserve the safety
 * behavior, not the code"):
 *  - Atomic index write: temp file + rename (no half-written sessions.json).
 *  - Write-lock around read-modify-write of the index, so concurrent
 *    getOrCreate / append / delete cannot lose updates or interleave.
 *  - `delete()` actually removes the transcript file on disk, not renames it.
 *    Archived flag: "delete must actually delete the user's data, not rename
 *    it to a .deleted.* file that lingers forever."
 *  - `expandHomePath("~/foo")` is honored for the custom store path.
 *
 * Recovery (cold load with missing/corrupt index): rebuild from transcript
 * files. Two shapes must be understood:
 *   1. flat `<sessionId>.jsonl` written by this store itself;
 *   2. nested per-session event logs written by AgentRuntime in directories
 *      named after `sanitizeSessionKey(channel:sender)` (":" → "_"). Rebuild
 *      the canonical `channel:sender` key from the sanitized directory name.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

import { FileSessionStore } from "../src/sessions/store.js";
import type { SessionEntry } from "../src/sessions/types.js";

function mkTmpDir(): string {
  return path.join(
    os.tmpdir(),
    `vex-sessions-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
}

describe("sessions/store", () => {
  let testDir: string;
  let store: FileSessionStore;

  beforeEach(() => {
    testDir = mkTmpDir();
    fs.mkdirSync(testDir, { recursive: true });
    store = new FileSessionStore(testDir);
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("constructor", () => {
    it("creates the store directory if missing", () => {
      const nested = path.join(testDir, "nested", "sessions");
      const s = new FileSessionStore(nested);
      expect(fs.existsSync(nested)).toBe(true);
      expect(s).toBeInstanceOf(FileSessionStore);
    });

    it("expands a leading ~ in the custom path", () => {
      const dirName = `.vex-sessions-expand-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const expanded = path.join(os.homedir(), dirName);
      const literal = path.join(process.cwd(), "~", dirName);
      try {
        new FileSessionStore(`~/${dirName}`);
        expect(fs.existsSync(expanded)).toBe(true);
        expect(fs.existsSync(literal)).toBe(false);
      } finally {
        fs.rmSync(expanded, { recursive: true, force: true });
        fs.rmSync(literal, { recursive: true, force: true });
      }
    });
  });

  describe("getOrCreate", () => {
    it("creates a new session entry with default fields", async () => {
      const entry = await store.getOrCreate("k1");
      expect(entry.sessionKey).toBe("k1");
      expect(entry.sessionId).toBeTruthy();
      expect(typeof entry.createdAt).toBe("number");
      expect(typeof entry.updatedAt).toBe("number");
      expect(entry.messageCount).toBe(0);
    });

    it("returns the existing entry for the same key", async () => {
      const a = await store.getOrCreate("k1");
      const b = await store.getOrCreate("k1");
      expect(b.sessionId).toBe(a.sessionId);
      expect(b.sessionKey).toBe(a.sessionKey);
    });
  });

  describe("get", () => {
    it("returns null for a missing key", async () => {
      expect(await store.get("missing")).toBeNull();
    });

    it("returns the entry that getOrCreate just created", async () => {
      await store.getOrCreate("k1");
      const entry = await store.get("k1");
      expect(entry).not.toBeNull();
      expect(entry?.sessionKey).toBe("k1");
    });
  });

  describe("upsert", () => {
    it("creates a new entry on first upsert", async () => {
      const e: SessionEntry = {
        sessionId: "id-1",
        sessionKey: "k-1",
        createdAt: 1,
        updatedAt: 1,
        messageCount: 5,
      };
      await store.upsert(e);
      const got = await store.get("k-1");
      expect(got?.sessionId).toBe("id-1");
      expect(got?.messageCount).toBe(5);
    });

    it("replaces fields on subsequent upsert", async () => {
      await store.upsert({
        sessionId: "id-1",
        sessionKey: "k-1",
        createdAt: 1,
        updatedAt: 1,
        messageCount: 5,
      });
      await store.upsert({
        sessionId: "id-1",
        sessionKey: "k-1",
        createdAt: 1,
        updatedAt: 2,
        messageCount: 10,
        totalTokens: 1000,
      });
      const got = await store.get("k-1");
      expect(got?.messageCount).toBe(10);
      expect(got?.totalTokens).toBe(1000);
    });
  });

  describe("delete", () => {
    it("removes the index entry", async () => {
      await store.getOrCreate("k1");
      expect(await store.get("k1")).not.toBeNull();
      await store.delete("k1");
      expect(await store.get("k1")).toBeNull();
    });

    it("is a no-op for a missing key (does not throw)", async () => {
      await expect(store.delete("never-existed")).resolves.toBeUndefined();
    });

    it("removes the transcript file from disk (F3 — actually delete)", async () => {
      await store.getOrCreate("k1");
      const entry = await store.get("k1");
      expect(entry).not.toBeNull();
      const transcriptPath = store.getTranscriptPath(entry!.sessionId);
      await store.appendTranscript(entry!.sessionId, "k1", {
        role: "user",
        content: "hi",
        timestamp: Date.now(),
      });
      expect(fs.existsSync(transcriptPath)).toBe(true);
      await store.delete("k1");
      expect(fs.existsSync(transcriptPath)).toBe(false);
    });
  });

  describe("list", () => {
    it("returns all entries", async () => {
      await store.getOrCreate("a");
      await store.getOrCreate("b");
      await store.getOrCreate("c");
      const list = await store.list();
      const keys = list.map((s) => s.sessionKey);
      expect(keys).toContain("a");
      expect(keys).toContain("b");
      expect(keys).toContain("c");
    });

    it("filters by search (case-insensitive substring on sessionKey)", async () => {
      await store.upsert({
        sessionId: "id-search-1",
        sessionKey: "search-apple",
        createdAt: 1,
        updatedAt: 1,
      });
      await store.upsert({
        sessionId: "id-search-2",
        sessionKey: "search-banana",
        createdAt: 1,
        updatedAt: 1,
      });
      await store.upsert({
        sessionId: "id-other",
        sessionKey: "other",
        createdAt: 1,
        updatedAt: 1,
      });
      const list = await store.list({ search: "search" });
      const keys = list.map((s) => s.sessionKey);
      expect(keys).toContain("search-apple");
      expect(keys).toContain("search-banana");
      expect(keys).not.toContain("other");
    });

    it("applies limit after sort", async () => {
      await store.getOrCreate("l1");
      await store.getOrCreate("l2");
      await store.getOrCreate("l3");
      const list = await store.list({ limit: 2 });
      expect(list.length).toBe(2);
    });

    it("sorts by updatedAt descending", async () => {
      // Distinct updatedAt values without real timers: feed the store
      // entries with explicit updatedAt timestamps and rely on the store's
      // own ordering. This is exactly the contract — list() sorts by the
      // field, not by wall-clock insertion order.
      await store.upsert({
        sessionId: "id-s1",
        sessionKey: "s1",
        createdAt: 1,
        updatedAt: 100,
      });
      await store.upsert({
        sessionId: "id-s2",
        sessionKey: "s2",
        createdAt: 1,
        updatedAt: 200,
      });
      await store.upsert({
        sessionId: "id-s3",
        sessionKey: "s3",
        createdAt: 1,
        updatedAt: 300,
      });
      const list = await store.list();
      expect(list.map((s) => s.sessionKey)).toEqual(["s3", "s2", "s1"]);
    });

    it("returns SessionListItem shape (subset of fields including provider)", async () => {
      await store.upsert({
        sessionId: "id-shape",
        sessionKey: "shape-key",
        createdAt: 1,
        updatedAt: 2,
        messageCount: 3,
        totalTokens: 9,
        model: "m1",
        provider: "p1",
        transcriptFile: "/tmp/x.jsonl",
      });
      const list = await store.list();
      const item = list.find((s) => s.sessionKey === "shape-key");
      expect(item).toEqual({
        sessionKey: "shape-key",
        sessionId: "id-shape",
        updatedAt: 2,
        messageCount: 3,
        totalTokens: 9,
        model: "m1",
        provider: "p1",
      });
    });
  });

  describe("recovery from transcripts", () => {
    it("rebuilds the index from a flat transcript when sessions.json is missing", async () => {
      const transcriptPath = path.join(testDir, "id-recover-1.jsonl");
      fs.writeFileSync(
        transcriptPath,
        [
          JSON.stringify({
            type: "session",
            version: 1,
            sessionId: "id-recover-1",
            sessionKey: "webchat:restored",
            timestamp: "2026-07-02T00:00:00.000Z",
          }),
          JSON.stringify({
            role: "user",
            content: "hi",
            timestamp: Date.now(),
          }),
          JSON.stringify({
            role: "assistant",
            content: "hello",
            timestamp: Date.now(),
            usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
            model: "m1",
            provider: "p1",
          }),
        ].join("\n") + "\n",
      );
      const fresh = new FileSessionStore(testDir);
      const list = await fresh.list();
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        sessionKey: "webchat:restored",
        sessionId: "id-recover-1",
        messageCount: 2,
        totalTokens: 3,
        model: "m1",
        provider: "p1",
      });
      // After recovery, sessions.json exists so the next load is a cache hit.
      expect(fs.existsSync(path.join(testDir, "sessions.json"))).toBe(true);
    });

    it("rebuilds from a nested AgentRuntime-style session log (sanitized directory name)", async () => {
      // AgentRuntime's sanitizeSessionKey("weixin:o9cq800...") → "weixin_o9cq800...".
      // The store must reverse that to derive the canonical sessionKey.
      const sessionDir = path.join(testDir, "weixin_o9cq800xxx.jsonl");
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(
        path.join(sessionDir, "2026-07-02T08-50-43-724Z_runtime-session.jsonl"),
        [
          JSON.stringify({
            type: "session",
            version: 3,
            id: "runtime-session",
            timestamp: "2026-07-02T08:50:43.724Z",
            cwd: "/workspace",
          }),
          JSON.stringify({
            type: "model_change",
            provider: "longcat",
            modelId: "LongCat-2.0",
            timestamp: "2026-07-02T08:50:43.727Z",
          }),
          JSON.stringify({
            type: "message",
            id: "msg-user",
            timestamp: "2026-07-02T08:50:43.735Z",
            message: {
              role: "user",
              content: [{ type: "text", text: "你好" }],
            },
          }),
          JSON.stringify({
            type: "message",
            id: "msg-assistant",
            timestamp: "2026-07-02T08:50:46.264Z",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "你好!" }],
            },
          }),
        ].join("\n") + "\n",
      );
      const fresh = new FileSessionStore(testDir);
      const list = await fresh.list();
      expect(list).toHaveLength(1);
      expect(list[0]?.sessionKey).toBe("weixin:o9cq800xxx");
      expect(list[0]?.sessionId).toBe("runtime-session");
      expect(list[0]?.messageCount).toBe(2);
      expect(list[0]?.model).toBe("LongCat-2.0");
      expect(list[0]?.provider).toBe("longcat");
    });
  });

  describe("transcript append", () => {
    it("writes a header on a new transcript file", async () => {
      const entry = await store.getOrCreate("k1");
      await store.appendTranscript(entry.sessionId, "k1", {
        role: "user",
        content: "hi",
        timestamp: Date.now(),
      });
      const transcriptPath = store.getTranscriptPath(entry.sessionId);
      const lines = fs.readFileSync(transcriptPath, "utf-8").split("\n").filter(Boolean);
      expect(lines.length).toBe(2);
      const header = JSON.parse(lines[0]!);
      expect(header.type).toBe("session");
      expect(header.sessionId).toBe(entry.sessionId);
      expect(header.sessionKey).toBe("k1");
      const msg = JSON.parse(lines[1]!);
      expect(msg.role).toBe("user");
      expect(msg.content).toBe("hi");
    });

    it("increments messageCount and accumulates token usage on append", async () => {
      const entry = await store.getOrCreate("k1");
      const t = Date.now();
      await store.appendTranscript(entry.sessionId, "k1", {
        role: "user",
        content: "a",
        timestamp: t,
      });
      await store.appendTranscript(entry.sessionId, "k1", {
        role: "assistant",
        content: "b",
        timestamp: t + 1,
        usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
      });
      const got = await store.get("k1");
      expect(got?.messageCount).toBe(2);
      expect(got?.inputTokens).toBe(2);
      expect(got?.outputTokens).toBe(3);
      expect(got?.totalTokens).toBe(5);
    });
  });
});
