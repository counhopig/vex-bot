import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFile, mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MemoryIndex } from "../src/index/memory.js";
import { markdownChunks, tokenize } from "../src/index/tokenize.js";
import { createMemorySearchTool } from "../src/index/tool.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

describe("memory retrieval index", () => {
  let root: string;
  let index: MemoryIndex | undefined;
  beforeEach(async () => { root = await makeTmpDir(); await mkdir(join(root, "workspace/memory"), { recursive: true }); await mkdir(join(root, "sessions/web"), { recursive: true }); });
  afterEach(async () => { index?.close(); index = undefined; await removeTmpDir(root); });
  const open = async () => { index = await MemoryIndex.open({ databasePath: join(root, "index.sqlite"), workspace: join(root, "workspace"), sessions: join(root, "sessions") }); return index; };
  it("tokenizes Chinese bigrams and chunks headings with paragraphs", () => {
    expect(tokenize("喜欢编程 TypeScript")).toEqual(["喜欢", "欢编", "编程", "typescript"]);
    expect(markdownChunks("# 喜好\n喜欢茶\n\n喜欢咖啡\n# 工作\n写程序")).toEqual(["# 喜好\n喜欢茶", "# 喜好\n喜欢咖啡", "# 工作\n写程序"]);
  });
  it("retrieves Chinese and English with source, date, scope, and limits", async () => {
    await writeFile(join(root, "workspace/memory/2026-10-03.md"), "# 偏好\n主人喜欢编程 TypeScript\n\n主人喜欢喝茶");
    await writeFile(join(root, "sessions/web/abc.jsonl"), JSON.stringify({ role: "assistant", content: [{ type: "text", text: "主人喜欢编程 TypeScript" }], timestamp: Date.UTC(2026, 9, 2) }) + "\n" + JSON.stringify({ role: "toolResult", content: "编程" }) + "\n");
    const db = await open();
    expect(db.search("编程", 5, "memory")).toHaveLength(1);
    expect(db.search("TypeScript", 5, "sessions")[0]).toMatchObject({ session: "web/abc", date: "2026-10-02" });
    expect(db.search("编程", 1)).toHaveLength(1);
    expect(db.search('" OR *')).toEqual([]);
    expect(() => db.search("a", 0)).toThrow();
  });
  it("retrieves Latin and CJK terms adjacent without spaces in either direction", async () => {
    expect(tokenize("使用TypeScript编程")).toEqual(["使用", "typescript", "编程"]);
    expect(tokenize("TypeScript编程TypeScript")).toEqual(["typescript", "编程", "typescript"]);
    expect(tokenize("使用Python开发TypeScript工具")).toEqual(["使用", "python", "开发", "typescript", "工具"]);
    await writeFile(join(root, "workspace/MEMORY.md"), "使用TypeScript编程\n\nTypeScript编程TypeScript");
    const db = await open();
    expect(db.search("编程", 5, "memory")).toHaveLength(2);
    expect(db.search("TypeScript", 5, "memory")).toHaveLength(2);
    expect(db.search("使用TypeScript", 5, "memory")).toHaveLength(2);
  });
  it("updates memory edits and removes deleted sources", async () => {
    const file = join(root, "workspace/MEMORY.md");
    await writeFile(file, "喜欢咖啡");
    const db = await open();
    await writeFile(file, "喜欢茶叶"); await db.sync();
    expect(db.search("咖啡")).toHaveLength(0); expect(db.search("茶叶")).toHaveLength(1);
    await unlink(file); await db.sync(); expect(db.search("茶叶")).toHaveLength(0);
  });
  it("indexes complete JSONL records once, recovers partial appends and rewrites", async () => {
    const file = join(root, "sessions/wechat.jsonl");
    await writeFile(file, JSON.stringify({ role: "user", content: "第一条记忆" }) + "\n");
    const db = await open();
    await appendFile(file, '{"role":"user","content":"第二条记忆"'); await db.sync();
    expect(db.search("第二")).toHaveLength(0);
    await appendFile(file, '}\n'); await db.sync(); await db.sync();
    expect(db.search("第二")).toHaveLength(1); expect(db.search("第一")).toHaveLength(1);
    await writeFile(file, JSON.stringify({ role: "user", content: "第三条记忆" }) + "\n"); await db.sync();
    expect(db.search("第一")).toHaveLength(0); expect(db.search("第三")).toHaveLength(1);
  });
  it("rebuilds a corrupt database from source files", async () => {
    await writeFile(join(root, "index.sqlite"), "not a database");
    await writeFile(join(root, "workspace/USER.md"), "主人喜欢音乐");
    const db = await open(); expect(db.search("音乐")).toHaveLength(1);
  });
  it("skips malformed JSONL values and content blocks without losing later valid messages", async () => {
    const file = join(root, "sessions/wechat.jsonl");
    const records = [null, [], 42, { message: null }, { message: [] }, { role: "assistant", content: [null, 2, { type: "text", text: null }] }, { role: "assistant", content: [null, { type: "text", text: "有效记忆" }] }];
    await writeFile(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const db = await open();
    expect(db.search("有效记忆")).toHaveLength(1);
    await appendFile(file, JSON.stringify({ role: "user", content: "增量记忆" }) + "\n");
    await db.sync();
    await db.sync();
    expect(db.search("有效")).toHaveLength(1);
    expect(db.search("增量")).toHaveLength(1);
  });
  it("ranks stronger matches first and refreshes through the tool", async () => {
    await writeFile(join(root, "workspace/MEMORY.md"), "TypeScript TypeScript TypeScript\n\nTypeScript and many unrelated languages databases networks systems computers libraries");
    const db = await open();
    const hits = db.search("typescript");
    expect(hits[0]?.text).toBe("TypeScript TypeScript TypeScript");
    expect(hits[0]!.score).toBeLessThan(hits[1]!.score);
    await writeFile(join(root, "workspace/USER.md"), "喜欢摄影");
    const result = await createMemorySearchTool(db).execute("call", { query: "摄影", scope: "memory", limit: 2 });
    expect(result.details.results).toHaveLength(1);
    expect(result.content[0]).toMatchObject({ type: "text" });
  });
});
