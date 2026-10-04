import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
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
const WINDOW = 4096;
const INDEX_VERSION = 1;
function digest(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
// Reads the bytes in [start, size) of a file.
async function readRange(source: string, start: number, end = Infinity): Promise<Buffer> {
  const handle = await open(source, "r");
  try {
    const length = Math.max(0, Math.min((await handle.stat()).size, end) - start);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

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
      opts.onWarning?.("The search index is corrupt; rebuilding it");
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
    // Rows written under another tokenization or hash scheme are dropped so every file re-indexes.
    if (this.db.pragma("user_version", { simple: true }) !== INDEX_VERSION) {
      this.db.exec("DELETE FROM chunks; DELETE FROM files;");
      this.db.pragma(`user_version = ${INDEX_VERSION}`);
    }
  }
  sync(): Promise<void> {
    const run = this.queue.then(() => this.syncFiles());
    this.queue = run.catch(() => {});
    return run;
  }
  private async syncFiles(): Promise<void> {
    const memory = [join(this.opts.workspace, "MEMORY.md"), join(this.opts.workspace, "USER.md"), ...await files(join(this.opts.workspace, "memory"))].filter(p => p.endsWith(".md"));
    const runs = join(this.opts.sessions, "runs") + sep;
    const sessions = (await files(this.opts.sessions, true)).filter(p => p.endsWith(".jsonl") && !p.startsWith(runs));
    const existing = new Set<string>();
    for (const source of [...memory, ...sessions]) {
      let info;
      try { info = await stat(source); } catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; throw err; }
      existing.add(source);
      const old = this.db.prepare("SELECT * FROM files WHERE source = ?").get(source) as FileState | undefined;
      if (old && old.mtime === info.mtimeMs && old.size === info.size) continue;
      const isSession = source.endsWith(".jsonl");
      // A session file only grows by appends; the window before the stored offset detects rewrites.
      const append = isSession && !!old && info.size >= old.offset && digest(await readRange(source, Math.max(0, old.offset - WINDOW), old.offset)) === old.hash;
      const start = append ? old!.offset : 0;
      const bytes = isSession ? await readRange(source, start) : await readFile(source);
      const offset = isSession ? start + bytes.lastIndexOf(10) + 1 : bytes.length;
      const date = /\d{4}-\d{2}-\d{2}/.exec(basename(source))?.[0] ?? new Date(info.mtimeMs).toISOString().slice(0, 10);
      const state = isSession ? digest(await readRange(source, Math.max(0, offset - WINDOW), offset)) : "";
      const insert = this.db.prepare("INSERT INTO chunks(tokens,text,source,date,session,scope) VALUES(?,?,?,?,?,?)");
      this.db.transaction(() => {
        if (!append) this.db.prepare("DELETE FROM chunks WHERE source = ?").run(source);
        if (!isSession) {
          for (const text of markdownChunks(bytes.toString("utf8"))) insert.run(tokenize(text, true).join(" "), text, source, date, null, "memory");
        } else {
          for (const line of bytes.subarray(0, offset - start).toString("utf8").split("\n")) {
            if (!line.trim()) continue;
            let record;
            try { record = JSON.parse(line); } catch { continue; }
            if (!record || typeof record !== "object" || Array.isArray(record)) continue;
            const message = record.message ?? record;
            if (!message || typeof message !== "object" || Array.isArray(message)) continue;
            if (message.role !== "user" && message.role !== "assistant") continue;
            if (message.vexSource) continue;
            const text = typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.flatMap((part: unknown) => part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string" ? [(part as { text: string }).text] : []).join("\n") : "";
            if (!text.trim()) continue;
            const timestamp = message.timestamp ?? record.timestamp;
            const parsedDate = timestamp === undefined ? undefined : new Date(timestamp);
            insert.run(tokenize(text, true).join(" "), text, source, parsedDate && Number.isFinite(parsedDate.getTime()) ? parsedDate.toISOString().slice(0, 10) : date, relative(this.opts.sessions, source).replace(/\.jsonl$/, ""), "sessions");
          }
        }
        this.db.prepare("INSERT OR REPLACE INTO files VALUES(?,?,?,?,?)").run(source, info.mtimeMs, start + bytes.length, offset, state);
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
    if (!["memory", "sessions", "all"].includes(scope)) throw new Error("Invalid search scope");
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("limit must be an integer from 1 to 50");
    const terms = [...new Set(tokenize(query))];
    if (!terms.length) return [];
    const match = terms.map(term => `"${term.replaceAll('"', '""')}"`).join(" OR ");
    return this.db.prepare(`SELECT text,source,date,session,bm25(chunks) AS score FROM chunks WHERE chunks MATCH ? ${scope === "all" ? "" : "AND scope = ?"} ORDER BY score LIMIT ?`).all(...(scope === "all" ? [match, limit] : [match, scope, limit])) as MemoryResult[];
  }
  async close(): Promise<void> { await this.queue; this.db.close(); }
}
