/**
 * 会话存储测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Mock logger
vi.mock("../src/utils/logger.js", () => ({
  getChildLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock generateId for predictable IDs
vi.mock("../src/utils/index.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/utils/index.js")>();
  let counter = 0;
  return {
    ...original,
    generateId: (prefix?: string) => {
      counter++;
      return prefix ? `${prefix}_test${counter}` : `test${counter}`;
    },
  };
});

import { FileSessionStore, initSessionStore, getSessionStore } from "../src/sessions/store.js";
import type { SessionEntry, TranscriptMessage } from "../src/sessions/types.js";

describe("sessions/store", () => {
  let testDir: string;
  let store: FileSessionStore;

  beforeEach(() => {
    // 创建临时测试目录
    testDir = path.join(os.tmpdir(), `vex-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(testDir, { recursive: true });
    store = new FileSessionStore(testDir);
  });

  afterEach(() => {
    // 清理测试目录
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("FileSessionStore", () => {
    describe("constructor", () => {
      it("should create store with custom path", () => {
        expect(store).toBeInstanceOf(FileSessionStore);
      });

      it("should create directory if not exists", () => {
        const newDir = path.join(testDir, "nested", "sessions");
        const newStore = new FileSessionStore(newDir);
        expect(fs.existsSync(newDir)).toBe(true);
      });

      it("should expand home directory shorthand in custom path", () => {
        const dirName = `.vex-session-expand-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const expandedDir = path.join(os.homedir(), dirName);
        const literalDir = path.join(process.cwd(), "~", dirName);

        try {
          new FileSessionStore(`~/${dirName}`);

          expect(fs.existsSync(expandedDir)).toBe(true);
          expect(fs.existsSync(literalDir)).toBe(false);
        } finally {
          fs.rmSync(expandedDir, { recursive: true, force: true });
          fs.rmSync(literalDir, { recursive: true, force: true });
        }
      });
    });

    describe("getOrCreate", () => {
      it("should create new session when not exists", async () => {
        const entry = await store.getOrCreate("test-session-1");

        expect(entry.sessionKey).toBe("test-session-1");
        expect(entry.sessionId).toBeDefined();
        expect(entry.createdAt).toBeDefined();
        expect(entry.updatedAt).toBeDefined();
        expect(entry.messageCount).toBe(0);
      });

      it("should return existing session", async () => {
        const first = await store.getOrCreate("test-session-2");
        const second = await store.getOrCreate("test-session-2");

        expect(second.sessionId).toBe(first.sessionId);
        expect(second.sessionKey).toBe(first.sessionKey);
      });
    });

    describe("get", () => {
      it("should return null for non-existent session", async () => {
        const entry = await store.get("non-existent");
        expect(entry).toBeNull();
      });

      it("should return existing session", async () => {
        await store.getOrCreate("get-test");
        const entry = await store.get("get-test");

        expect(entry).not.toBeNull();
        expect(entry?.sessionKey).toBe("get-test");
      });
    });

    describe("upsert", () => {
      it("should create new entry", async () => {
        const entry: SessionEntry = {
          sessionId: "upsert-id-1",
          sessionKey: "upsert-key-1",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          messageCount: 5,
        };

        await store.upsert(entry);
        const retrieved = await store.get("upsert-key-1");

        expect(retrieved?.sessionId).toBe("upsert-id-1");
        expect(retrieved?.messageCount).toBe(5);
      });

      it("should update existing entry", async () => {
        const entry1: SessionEntry = {
          sessionId: "upsert-id-2",
          sessionKey: "upsert-key-2",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          messageCount: 5,
        };

        await store.upsert(entry1);

        const entry2: SessionEntry = {
          ...entry1,
          messageCount: 10,
          totalTokens: 1000,
        };

        await store.upsert(entry2);
        const retrieved = await store.get("upsert-key-2");

        expect(retrieved?.messageCount).toBe(10);
        expect(retrieved?.totalTokens).toBe(1000);
      });
    });

    describe("delete", () => {
      it("should delete session", async () => {
        await store.getOrCreate("delete-test");
        expect(await store.get("delete-test")).not.toBeNull();

        await store.delete("delete-test");
        expect(await store.get("delete-test")).toBeNull();
      });

      it("should handle deleting non-existent session", async () => {
        // Should not throw
        await store.delete("non-existent-delete");
      });
    });

    describe("list", () => {
      it("should list all sessions", async () => {
        await store.getOrCreate("list-1");
        await store.getOrCreate("list-2");
        await store.getOrCreate("list-3");

        const list = await store.list();

        expect(list.length).toBeGreaterThanOrEqual(3);
        const keys = list.map((s) => s.sessionKey);
        expect(keys).toContain("list-1");
        expect(keys).toContain("list-2");
        expect(keys).toContain("list-3");
      });

      it("should filter by search", async () => {
        await store.getOrCreate("search-apple");
        await store.getOrCreate("search-banana");
        await store.getOrCreate("other-item");

        const list = await store.list({ search: "search" });

        expect(list.length).toBe(2);
        const keys = list.map((s) => s.sessionKey);
        expect(keys).toContain("search-apple");
        expect(keys).toContain("search-banana");
      });

      it("should limit results", async () => {
        await store.getOrCreate("limit-1");
        await store.getOrCreate("limit-2");
        await store.getOrCreate("limit-3");

        const list = await store.list({ limit: 2 });

        expect(list.length).toBeLessThanOrEqual(2);
      });

      it("should sort by updatedAt descending", async () => {
        const entry1 = await store.getOrCreate("sort-1");
        await new Promise((r) => setTimeout(r, 10));
        const entry2 = await store.getOrCreate("sort-2");
        await new Promise((r) => setTimeout(r, 10));
        const entry3 = await store.getOrCreate("sort-3");

        const list = await store.list({ search: "sort-" });

        // Most recently updated should be first
        expect(list[0]?.sessionKey).toBe("sort-3");
      });

      it("should recover sessions from transcript files when index is missing", async () => {
        const transcriptPath = path.join(testDir, "session-id-1.jsonl");
        fs.writeFileSync(
          transcriptPath,
          [
            JSON.stringify({
              type: "session",
              version: 1,
              sessionId: "session-id-1",
              sessionKey: "webchat:restored",
              timestamp: "2026-07-02T00:00:00.000Z",
            }),
            JSON.stringify({
              role: "user",
              content: "Hello",
              timestamp: Date.now(),
            }),
            JSON.stringify({
              role: "assistant",
              content: "Hi",
              timestamp: Date.now(),
              usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
              model: "test-model",
              provider: "test-provider",
            }),
          ].join("\n") + "\n",
        );

        const restoredStore = new FileSessionStore(testDir);
        const list = await restoredStore.list();

        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({
          sessionKey: "webchat:restored",
          sessionId: "session-id-1",
          messageCount: 2,
          totalTokens: 3,
          model: "test-model",
        });
        expect(fs.existsSync(path.join(testDir, "sessions.json"))).toBe(true);
      });

      it("should recover nested AgentRuntime session event logs", async () => {
        const sessionDir = path.join(testDir, "weixin_sender.jsonl");
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
                content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "你好！" }],
                provider: "longcat",
                model: "LongCat-2.0",
                usage: { input: 10, output: 20, totalTokens: 30 },
              },
            }),
          ].join("\n") + "\n",
        );

        const restoredStore = new FileSessionStore(testDir);
        const list = await restoredStore.list();

        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({
          sessionKey: "weixin:sender",
          sessionId: "runtime-session",
          messageCount: 2,
          totalTokens: 30,
          model: "LongCat-2.0",
        });

        const messages = await restoredStore.loadTranscript("runtime-session");
        expect(messages).toHaveLength(2);
        expect(messages[0]).toMatchObject({ role: "user", content: "你好" });
        expect(messages[1]).toMatchObject({
          role: "assistant",
          content: "你好！",
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        });
      });

      it("should classify the channel from the sanitized key even when the sender id contains underscores", async () => {
        // AgentRuntime sanitizes "weixin:o9cq...-_im_wechat" into a directory name,
        // replacing the ":" separator with "_". Recovery must still classify the
        // channel as "weixin" (not the whole sanitized blob) and rebuild the key.
        const sessionDir = path.join(testDir, "weixin_o9cq800ta-_im_wechat.jsonl");
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(
          path.join(sessionDir, "2026-07-02T08-50-43-724Z_runtime-session.jsonl"),
          [
            JSON.stringify({ type: "session", version: 3, id: "runtime-session", timestamp: "2026-07-02T08:50:43.724Z" }),
            JSON.stringify({
              type: "message",
              id: "msg-user",
              timestamp: "2026-07-02T08:50:43.735Z",
              message: { role: "user", content: [{ type: "text", text: "hi" }] },
            }),
          ].join("\n") + "\n",
        );

        const restoredStore = new FileSessionStore(testDir);
        const entry = await restoredStore.get("weixin:o9cq800ta-_im_wechat");
        expect(entry).not.toBeNull();
        expect(entry?.channel).toBe("weixin");
        expect(entry?.sessionKey).toBe("weixin:o9cq800ta-_im_wechat");
      });

      it("should not duplicate a webchat session that has both a flat record and a nested runtime log", async () => {
        // Webchat writes an authoritative flat transcript AND produces a nested
        // pi-agent event log. Both must collapse to a single canonical entry.
        fs.writeFileSync(
          path.join(testDir, "flat-session-id.jsonl"),
          [
            JSON.stringify({
              type: "session",
              version: 1,
              sessionId: "flat-session-id",
              sessionKey: "webchat:client_abc",
              timestamp: "2026-07-02T00:00:00.000Z",
            }),
            JSON.stringify({ role: "user", content: "hello", timestamp: Date.now() }),
          ].join("\n") + "\n",
        );

        const sessionDir = path.join(testDir, "webchat_client_abc.jsonl");
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(
          path.join(sessionDir, "2026-07-02T08-50-43-724Z_runtime-session.jsonl"),
          [
            JSON.stringify({ type: "session", version: 3, id: "runtime-session", timestamp: "2026-07-02T08:50:43.724Z" }),
            JSON.stringify({
              type: "message",
              id: "msg-user",
              timestamp: "2026-07-02T08:50:43.735Z",
              message: { role: "user", content: [{ type: "text", text: "hello" }] },
            }),
          ].join("\n") + "\n",
        );

        const restoredStore = new FileSessionStore(testDir);
        const list = await restoredStore.list();

        expect(list).toHaveLength(1);
        expect(list[0]?.sessionKey).toBe("webchat:client_abc");
      });

      it("should delete recovered nested transcript files so they do not reappear", async () => {
        const sessionDir = path.join(testDir, "weixin_sender.jsonl");
        const transcriptPath = path.join(sessionDir, "2026-07-02T08-50-43-724Z_runtime-session.jsonl");
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(
          transcriptPath,
          [
            JSON.stringify({
              type: "session",
              version: 3,
              id: "runtime-session",
              timestamp: "2026-07-02T08:50:43.724Z",
              cwd: "/workspace",
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
          ].join("\n") + "\n",
        );

        const restoredStore = new FileSessionStore(testDir);
        expect(await restoredStore.list()).toHaveLength(1);

        await restoredStore.delete("weixin:sender");

        expect(fs.existsSync(transcriptPath)).toBe(false);
        expect(fs.readdirSync(sessionDir).some((name) => name.includes(".deleted."))).toBe(true);

        const freshStore = new FileSessionStore(testDir);
        expect(await freshStore.list()).toHaveLength(0);
      });

      it("should migrate a legacy sanitized index key and delete the nested transcript", async () => {
        const sessionDir = path.join(testDir, "weixin_sender.jsonl");
        const transcriptPath = path.join(sessionDir, "2026-07-02T08-50-43-724Z_runtime-session.jsonl");
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(
          transcriptPath,
          [
            JSON.stringify({
              type: "session",
              version: 3,
              id: "runtime-session",
              timestamp: "2026-07-02T08:50:43.724Z",
              cwd: "/workspace",
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
          ].join("\n") + "\n",
        );
        fs.writeFileSync(
          path.join(testDir, "sessions.json"),
          JSON.stringify({
            "weixin_sender:runtime-session": {
              sessionId: "runtime-session",
              sessionKey: "weixin_sender:runtime-session",
              createdAt: Date.now(),
              updatedAt: Date.now(),
              messageCount: 1,
            },
          }, null, 2),
        );

        const indexedStore = new FileSessionStore(testDir);
        // The legacy sanitized key is migrated to the canonical channel:sender form on load.
        const migrated = await indexedStore.list();
        expect(migrated).toHaveLength(1);
        expect(migrated[0]?.sessionKey).toBe("weixin:sender");

        await indexedStore.delete("weixin:sender");

        expect(fs.existsSync(transcriptPath)).toBe(false);

        const freshStore = new FileSessionStore(testDir);
        expect(await freshStore.list()).toHaveLength(0);
      });
    });

    describe("reset", () => {
      it("should create new session and preserve old", async () => {
        const original = await store.getOrCreate("reset-test");
        const originalId = original.sessionId;

        const newEntry = await store.reset("reset-test");

        expect(newEntry.sessionId).not.toBe(originalId);
        expect(newEntry.messageCount).toBe(0);

        // Old session should still exist
        const oldEntry = await store.get("reset-test");
        expect(oldEntry?.sessionId).toBe(originalId);
      });

      it("should preserve channel prefix in new sessionKey", async () => {
        await store.getOrCreate("webchat:original-key");
        const newEntry = await store.reset("webchat:original-key");

        expect(newEntry.sessionKey).toMatch(/^webchat:/);
      });

      it("should preserve authenticated WebChat owner namespace in new sessionKey", async () => {
        await store.getOrCreate("webchat:user-a:client-1");
        const newEntry = await store.reset("webchat:user-a:client-1");

        expect(newEntry.sessionKey).toMatch(/^webchat:user-a:session_/);
      });
    });

    describe("transcript operations", () => {
      it("should get transcript path", () => {
        const transcriptPath = store.getTranscriptPath("session-123");
        expect(transcriptPath).toContain("session-123.jsonl");
      });

      it("should load empty transcript for new session", async () => {
        const messages = await store.loadTranscript("new-session");
        expect(messages).toEqual([]);
      });

      it("should append and load transcript", async () => {
        const entry = await store.getOrCreate("transcript-test");

        const message: TranscriptMessage = {
          role: "user",
          content: "Hello",
          timestamp: Date.now(),
        };

        await store.appendTranscript(entry.sessionId, entry.sessionKey, message);

        const loaded = await store.loadTranscript(entry.sessionId);
        expect(loaded).toHaveLength(1);
        expect(loaded[0]?.content).toBe("Hello");
        expect(loaded[0]?.role).toBe("user");
      });

      it("should update session stats on transcript append", async () => {
        const entry = await store.getOrCreate("stats-test");

        const message: TranscriptMessage = {
          role: "assistant",
          content: "Response",
          timestamp: Date.now(),
          usage: {
            promptTokens: 10,
            completionTokens: 20,
            totalTokens: 30,
          },
          model: "test-model",
          provider: "test-provider",
        };

        await store.appendTranscript(entry.sessionId, entry.sessionKey, message);

        const updated = await store.get(entry.sessionKey);
        expect(updated?.messageCount).toBe(1);
        expect(updated?.inputTokens).toBe(10);
        expect(updated?.outputTokens).toBe(20);
        expect(updated?.totalTokens).toBe(30);
        expect(updated?.model).toBe("test-model");
        expect(updated?.provider).toBe("test-provider");
      });

      it("should clear transcript", async () => {
        const entry = await store.getOrCreate("clear-transcript-test");

        await store.appendTranscript(entry.sessionId, entry.sessionKey, {
          role: "user",
          content: "Test",
          timestamp: Date.now(),
        });

        // Verify transcript exists
        const before = await store.loadTranscript(entry.sessionId);
        expect(before.length).toBe(1);

        await store.clearTranscript(entry.sessionId);

        const after = await store.loadTranscript(entry.sessionId);
        expect(after).toEqual([]);
      });
    });
  });

  describe("global store functions", () => {
    describe("getSessionStore", () => {
      it("should return singleton instance", () => {
        const store1 = getSessionStore();
        const store2 = getSessionStore();
        expect(store1).toBe(store2);
      });
    });

    describe("initSessionStore", () => {
      it("should initialize with custom path", () => {
        const customPath = path.join(testDir, "custom-sessions");
        const store = initSessionStore(customPath);

        expect(store).toBeInstanceOf(FileSessionStore);
        expect(fs.existsSync(customPath)).toBe(true);
      });
    });
  });
});
