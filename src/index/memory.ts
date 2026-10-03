import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { markdownChunks, tokenize } from "./tokenize.js";

export type MemoryScope = "memory" | "sessions" | "all";
export interface MemoryResult { text: string; source: string; date: string; session: string | null; score: number }
export interface MemoryIndexOptions { databasePath: string; workspace: string; sessions: string; onWarning?: (message: string) => void }
interface FileState { source: string; mtime: number; size: number; offset: number; hash: string }

async function files(root: string, recursive = false): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const result: string[] = [];
    for (const entry of entries) {
      if (entry.isFile()) result.push(join(root, entry.name));
      else if (recursive && entry.isDirectory()) result.push(...await files(join(root, entry.name), true));
    }
    return result;
  } catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return []; throw err; }
}
function digest(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }

export class MemoryIndex {
  private db!: Database.Database;
  private queue: Promise<void> = Promise.resolve();
  private constructor(private readonly opts: MemoryIndexOptions) {}
  static async open(opts: MemoryIndexOptions): Promise<MemoryIndex> {
    const index = new MemoryIndex(opts);
    await mkdir(dirname(opts.databasePath), { recursive: true });
    try { index.connect(); }
    catch (err) {
      index.db?.close();
      if (!/SQLITE_(CORRUPT|NOTADB)/.test(String((err as { code?: string }).code))) throw err;
      opts.onWarning?.("检索索引损坏，正在重建");
      for (const suffix of ["", "-wal", "-shm"]) await unlink(opts.databasePath + suffix).catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; });
      index.connect();
    }
    await index.sync();
    return index;
  }
  private connect(): void {
    this.db = new Database(this.opts.databasePath);
    const check = this.db.pragma("quick_check", { simple: true });
    if (check !== "ok") throw Object.assign(new Error(String(check)), { code: "SQLITE_CORRUPT" });
    this.db.exec(`CREATE TABLE IF NOT EXISTS files(source TEXT PRIMARY KEY, mtime REAL, size INTEGER, offset INTEGER, hash TEXT);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(tokens, text UNINDEXED, source UNINDEXED, date UNINDEXED, session UNINDEXED, scope UNINDEXED, tokenize='unicode61');`);
  }
  sync(): Promise<void> {
    const run = this.queue.then(() => this.syncFiles());
    this.queue = run.catch(() => {});
    return run;
  }
  private async syncFiles(): Promise<void> {
    const memory = [join(this.opts.workspace, "MEMORY.md"), join(this.opts.workspace, "USER.md"), ...await files(join(this.opts.workspace, "memory"))].filter(p => p.endsWith(".md"));
    const sessions = (await files(this.opts.sessions, true)).filter(p => p.endsWith(".jsonl"));
    const existing = new Set<string>();
    for (const source of [...memory, ...sessions]) {
      let info;
      try { info = await stat(source); } catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; throw err; }
      existing.add(source);
      const old = this.db.prepare("SELECT * FROM files WHERE source = ?").get(source) as FileState | undefined;
      if (old && old.mtime === info.mtimeMs && old.size === info.size) continue;
      const bytes = await readFile(source);
      const isSession = source.endsWith(".jsonl");
      const append = isSession && old && bytes.length >= old.offset && digest(bytes.subarray(0, old.offset)) === old.hash;
      const offset = isSession ? bytes.lastIndexOf(10) + 1 : bytes.length;
      const start = append ? old.offset : 0;
      const date = /\d{4}-\d{2}-\d{2}/.exec(basename(source))?.[0] ?? new Date(info.mtimeMs).toISOString().slice(0, 10);
      const insert = this.db.prepare("INSERT INTO chunks(tokens,text,source,date,session,scope) VALUES(?,?,?,?,?,?)");
      this.db.transaction(() => {
        if (!append) this.db.prepare("DELETE FROM chunks WHERE source = ?").run(source);
        if (!isSession) {
          for (const text of markdownChunks(bytes.toString("utf8"))) insert.run(tokenize(text, true).join(" "), text, source, date, null, "memory");
        } else {
          for (const line of bytes.subarray(start, offset).toString("utf8").split("\n")) {
            if (!line.trim()) continue;
            let record;
            try { record = JSON.parse(line); } catch { continue; }
            if (!record || typeof record !== "object" || Array.isArray(record)) continue;
            const message = record.message ?? record;
            if (!message || typeof message !== "object" || Array.isArray(message)) continue;
            if (message.role !== "user" && message.role !== "assistant") continue;
            const text = typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.flatMap((part: unknown) => part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string" ? [(part as { text: string }).text] : []).join("\n") : "";
            if (!text.trim()) continue;
            const timestamp = message.timestamp ?? record.timestamp;
            const parsedDate = timestamp === undefined ? undefined : new Date(timestamp);
            insert.run(tokenize(text, true).join(" "), text, source, parsedDate && Number.isFinite(parsedDate.getTime()) ? parsedDate.toISOString().slice(0, 10) : date, relative(this.opts.sessions, source).replace(/\.jsonl$/, ""), "sessions");
          }
        }
        this.db.prepare("INSERT OR REPLACE INTO files VALUES(?,?,?,?,?)").run(source, info.mtimeMs, bytes.length, offset, digest(bytes.subarray(0, offset)));
      })();
    }
    this.db.transaction(() => {
      for (const { source } of this.db.prepare("SELECT source FROM files").all() as { source: string }[]) {
        if (existing.has(source)) continue;
        this.db.prepare("DELETE FROM chunks WHERE source = ?").run(source);
        this.db.prepare("DELETE FROM files WHERE source = ?").run(source);
      }
    })();
  }
  search(query: string, limit = 5, scope: MemoryScope = "all"): MemoryResult[] {
    if (!["memory", "sessions", "all"].includes(scope)) throw new Error("无效的检索范围");
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("limit 必须为 1–50 的整数");
    const terms = [...new Set(tokenize(query))];
    if (!terms.length) return [];
    const match = terms.map(term => `"${term.replaceAll('"', '""')}"`).join(" OR ");
    return this.db.prepare(`SELECT text,source,date,session,bm25(chunks) AS score FROM chunks WHERE chunks MATCH ? ${scope === "all" ? "" : "AND scope = ?"} ORDER BY score LIMIT ?`).all(...(scope === "all" ? [match, limit] : [match, scope, limit])) as MemoryResult[];
  }
  close(): void { this.db.close(); }
}
