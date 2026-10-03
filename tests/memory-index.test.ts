import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFile, mkdir, stat, unlink, writeFile } from "node:fs/promises";
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
  it("matches single-character and two-character CJK queries", async () => {
    await writeFile(join(root, "workspace/MEMORY.md"), "主人养了一只小猫咪");
    const db = await open();
    expect(db.search("猫", 5, "memory")).toHaveLength(1);
    expect(db.search("小猫", 5, "memory")).toHaveLength(1);
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
  it("reads only appended bytes and re-indexes a rewritten file", async () => {
    const file = join(root, "sessions/wechat.jsonl");
    const first = JSON.stringify({ role: "user", content: `第一条记忆${"填".repeat(6000)}` }) + "\n";
    await writeFile(file, first);
    const db = await open();
    await writeFile(file, first.replace("第一条记忆", "另一条记忆"));
    await appendFile(file, JSON.stringify({ role: "user", content: "第二条记忆" }) + "\n");
    await db.sync();
    expect(db.search("第一")).toHaveLength(1);
    expect(db.search("第二")).toHaveLength(1);
    await writeFile(file, JSON.stringify({ role: "user", content: `全新内容${"换".repeat(9000)}` }) + "\n"); await db.sync();
    expect(db.search("第一")).toHaveLength(0);
    expect(db.search("全新")).toHaveLength(1);
  });
  it("excludes temporary run sessions and marked synthetic messages", async () => {
    await mkdir(join(root, "sessions/runs"), { recursive: true });
    await writeFile(join(root, "sessions/runs/job.jsonl"), JSON.stringify({ role: "user", content: "临时会话内容" }) + "\n");
    await writeFile(join(root, "sessions/wechat.jsonl"), [{ role: "user", content: "心跳触发内容", vexSource: "心跳" }, { role: "user", content: "正常对话内容" }].map((r) => JSON.stringify(r)).join("\n") + "\n");
    const db = await open();
    expect(db.search("临时会话")).toHaveLength(0);
    expect(db.search("心跳触发")).toHaveLength(0);
    expect(db.search("正常对话")).toHaveLength(1);
  });
  it("waits for an in-flight sync before closing", async () => {
    await writeFile(join(root, "workspace/MEMORY.md"), "喜欢茶叶");
    const db = await open();
    await writeFile(join(root, "workspace/MEMORY.md"), "喜欢咖啡");
    const pending = db.sync();
    await db.close();
    await expect(pending).resolves.toBeUndefined();
    index = undefined;
  });
  it("returns snippets of about 300 characters around the match", async () => {
    await writeFile(join(root, "workspace/MEMORY.md"), `${"前文".repeat(400)}关键线索${"后文".repeat(400)}`);
    const db = await open();
    const result = await createMemorySearchTool(db).execute("call", { query: "关键线索", scope: "memory" });
    const [hit] = result.details.results;
    expect(hit!.text).toContain("关键线索");
    expect(hit!.text.length).toBeLessThanOrEqual(310);
    await writeFile(join(root, "workspace/USER.md"), `${"😀".repeat(200)}a表情线索${"😀".repeat(200)}`);
    const emoji = await createMemorySearchTool(db).execute("call", { query: "表情线索", scope: "memory" });
    expect(emoji.details.results[0]!.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(JSON.stringify(result.content)).not.toContain("前文".repeat(150));
  });
  it("re-indexes a database created by an older index version", async () => {
    const file = join(root, "workspace/MEMORY.md");
    await writeFile(file, "主人养了一只小猫咪");
    const info = await stat(file);
    const old = new Database(join(root, "index.sqlite"));
    old.exec(`CREATE TABLE files(source TEXT PRIMARY KEY, mtime REAL, size INTEGER, offset INTEGER, hash TEXT);
      CREATE VIRTUAL TABLE chunks USING fts5(tokens, text UNINDEXED, source UNINDEXED, date UNINDEXED, session UNINDEXED, scope UNINDEXED, tokenize='unicode61');`);
    old.prepare("INSERT INTO chunks VALUES(?,?,?,?,?,?)").run("主人 人养 养了 了一 一只 只小 小猫 猫咪", "主人养了一只小猫咪", file, "2026-10-03", null, "memory");
    old.prepare("INSERT INTO files VALUES(?,?,?,?,?)").run(file, info.mtimeMs, info.size, info.size, "");
    old.close();
    const db = await open();
    expect(db.search("猫", 5, "memory")).toHaveLength(1);
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
