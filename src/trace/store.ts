import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { redactSecrets } from "../config/secrets.js";
import { writeFileAtomic } from "../store/atomic.js";
import { readJsonl } from "../store/jsonl.js";
import type { TraceEvent, TraceOutcome, TraceRecord, TraceSummary } from "./types.js";

export interface TraceStoreOptions {
  dir: string;
  /** Values replaced in every payload before it is written or sent to a viewer. */
  secrets?: () => string[];
  retainDays?: number;
  now?: () => number;
  onWarning?: (message: string) => void;
}

export interface RunInfo { session: string; source: string; model: string; text: string }

export interface RunTrace {
  readonly id: string;
  record(event: TraceRecord): void;
  /** A view whose steps belong under the tool call `parent`, for a delegated sub-agent. */
  child(parent: string): RunTrace;
  /** A fresh step id within this run. */
  nextId(prefix: string): string;
}

export interface TraceScope {
  /** The run in progress, if any. */
  readonly current: RunTrace | undefined;
  begin(info: RunInfo): RunTrace;
  finish(outcome: TraceOutcome, detail?: { error?: string; reply?: string }): void;
}

export type TraceListener = (summary: TraceSummary, event: TraceEvent) => void;

const DEFAULT_RETAIN_DAYS = 7;
const DAY_MS = 86_400_000;
const PRUNE_EVERY_MS = 3_600_000;
const MAX_RUN_BYTES = 4 * 1024 * 1024;
const SEARCH_FILES = 500;
const ID = /^[0-9a-z]{8,9}-[0-9a-f]{6}$/;

/** Character limits per payload field; anything longer is cut with a note of what was dropped. */
const FIELD_LIMITS: Record<string, number> = { system: 65_536, result: 16_384, thinking: 16_384, text: 16_384, args: 8_192, details: 8_192, reply: 4_096 };
const DEFAULT_FIELD_LIMIT = 4_096;
const BOUNDED_FIELDS = new Set(["system", "result", "thinking", "text", "args", "details", "reply", "error", "detail", "reason"]);
const PARENTED = new Set(["llm_start", "llm_end", "tool_start", "gate", "tool_end", "check"]);

function bound(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…[+${text.length - limit} chars]` : text;
}

/** Run traces under `dir`: one JSONL per run plus an index of run summaries. */
export class TraceStore {
  private readonly runs = new Map<string, TraceSummary>();
  private readonly scopes = new Map<string, Scope>();
  private readonly listeners = new Set<TraceListener>();
  // Run files and the index are appended through one queue, so every file keeps its event order.
  private writes: Promise<void> = Promise.resolve();
  private lastPrune = 0;
  readonly now: () => number;

  constructor(private readonly opts: TraceStoreOptions) {
    this.now = opts.now ?? Date.now;
  }

  async open(): Promise<void> {
    await mkdir(this.opts.dir, { recursive: true });
    for (const summary of await readJsonl<TraceSummary>(this.indexPath)) {
      if (summary && typeof summary.id === "string" && ID.test(summary.id)) this.runs.set(summary.id, summary);
    }
    for (const summary of this.runs.values()) if (summary.outcome === "running") summary.outcome = "interrupted";
    await this.prune(true);
  }

  on(listener: TraceListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  scope(session: string): TraceScope {
    let scope = this.scopes.get(session);
    if (!scope) { scope = new Scope(this); this.scopes.set(session, scope); }
    return scope;
  }

  /** Forgets a session that will not run again, such as a finished background run. */
  release(session: string): void {
    this.scopes.delete(session);
  }

  /** Adds an event to the session's running run, or to its last one when it has already ended. */
  note(session: string, event: TraceRecord): void {
    this.scopes.get(session)?.latest?.record(event);
  }

  /**
   * Newest first; with a query, only runs whose trace contains it, ignoring case. Runs that start in the
   * same millisecond are ordered by id, and the cursor names both, so a page boundary never skips one.
   */
  async list(opts: { before?: string; limit?: number; query?: string } = {}): Promise<{ runs: TraceSummary[]; nextBefore?: string }> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const cursor = parseCursor(opts.before);
    const candidates = [...this.runs.values()]
      .filter((run) => !cursor || run.startedAt < cursor.at || (run.startedAt === cursor.at && run.id < cursor.id))
      .sort((a, b) => b.startedAt - a.startedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    const query = opts.query?.trim().toLowerCase();
    if (!query) {
      const runs = candidates.slice(0, limit);
      return { runs, ...(candidates.length > limit ? { nextBefore: cursorOf(runs.at(-1)!) } : {}) };
    }
    const runs: TraceSummary[] = [];
    let scanned = 0;
    for (const run of candidates) {
      if (runs.length >= limit || scanned >= SEARCH_FILES) return { runs, nextBefore: cursorOf(candidates[scanned - 1] ?? run) };
      scanned++;
      const text = await readFile(this.pathOf(run.id), "utf8").catch(() => "");
      if (text.toLowerCase().includes(query) || run.title.toLowerCase().includes(query)) runs.push(run);
    }
    return { runs };
  }

  summary(id: string): TraceSummary | undefined { return this.runs.get(id); }

  async read(id: string): Promise<TraceEvent[]> {
    if (!ID.test(id) || !this.runs.has(id)) throw new Error("No such run");
    return readJsonl<TraceEvent>(this.pathOf(id));
  }

  /** Waits for every queued write; for shutdown and tests. */
  async flush(): Promise<void> {
    await this.writes;
  }

  /** @internal */
  start(info: RunInfo): Run {
    const startedAt = this.now();
    const id = `${startedAt.toString(36).padStart(8, "0")}-${randomBytes(3).toString("hex")}`;
    const summary: TraceSummary = { id, session: info.session, source: info.source, model: info.model, title: info.text.replace(/\s+/g, " ").trim().slice(0, 120),
      startedAt, outcome: "running", llmCalls: 0, toolCalls: 0, toolErrors: 0, input: 0, output: 0 };
    this.runs.set(id, summary);
    void this.prune(false);
    return new Run(this, summary);
  }

  /** @internal Stamps, bounds and redacts an event; returns the line to append. */
  prepare(event: TraceRecord): { event: TraceEvent; line: string } {
    const secrets = this.opts.secrets?.() ?? [];
    const output: Record<string, unknown> = { t: this.now(), ...event };
    for (const [key, value] of Object.entries(output)) {
      if (typeof value === "string" && BOUNDED_FIELDS.has(key)) output[key] = bound(redactSecrets(value, secrets), FIELD_LIMITS[key] ?? DEFAULT_FIELD_LIMIT);
    }
    const prepared = output as TraceEvent;
    return { event: prepared, line: `${JSON.stringify(prepared)}\n` };
  }

  /** @internal */
  append(id: string, line: string): void {
    this.writes = this.writes.then(() => appendFile(this.pathOf(id), line, "utf8"))
      .catch((err: unknown) => this.warn(`writing run trace ${id} failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  /** @internal */
  publish(summary: TraceSummary, event: TraceEvent): void {
    for (const listener of [...this.listeners]) {
      try { listener(summary, event); } catch (err) { this.warn(`trace listener failed: ${err instanceof Error ? err.message : String(err)}`); }
    }
  }

  /** @internal */
  saveSummary(summary: TraceSummary): void {
    const line = `${JSON.stringify(summary)}\n`;
    this.writes = this.writes.then(() => appendFile(this.indexPath, line, "utf8"))
      .catch((err: unknown) => this.warn(`writing the run index failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  /** @internal */
  warn(message: string): void { this.opts.onWarning?.(message); }

  private get indexPath(): string { return join(this.opts.dir, "index.jsonl"); }

  private pathOf(id: string): string { return join(this.opts.dir, `${id}.jsonl`); }

  /** Drops runs older than the retention period, with their files, and rewrites the index. */
  private async prune(force: boolean): Promise<void> {
    const now = this.now();
    if (!force && now - this.lastPrune < PRUNE_EVERY_MS) return;
    this.lastPrune = now;
    const cutoff = now - (this.opts.retainDays ?? DEFAULT_RETAIN_DAYS) * DAY_MS;
    for (const [id, run] of this.runs) if (run.startedAt < cutoff && run.outcome !== "running") this.runs.delete(id);
    const work = this.writes.then(async () => {
      const kept = new Set(this.runs.keys());
      for (const name of await readdir(this.opts.dir)) {
        const id = name.endsWith(".jsonl") ? name.slice(0, -6) : "";
        if (ID.test(id) && !kept.has(id)) await rm(join(this.opts.dir, name), { force: true });
      }
      await writeFileAtomic(this.indexPath, [...this.runs.values()].map((run) => `${JSON.stringify(run)}\n`).join(""));
    }).catch((err: unknown) => this.warn(`pruning run traces failed: ${err instanceof Error ? err.message : String(err)}`));
    this.writes = work;
    await work;
  }
}

class Run implements RunTrace {
  private bytes = 0;
  private truncated = false;
  private steps = 0;
  ended = false;

  constructor(private readonly store: TraceStore, readonly summary: TraceSummary) {}

  get id(): string { return this.summary.id; }

  nextId(prefix: string): string { return `${prefix}-${++this.steps}`; }

  child(parent: string): RunTrace {
    const view: RunTrace = {
      id: this.id,
      record: (event) => this.record(PARENTED.has(event.type) ? { ...event, parent } as TraceRecord : event),
      child: (inner) => this.child(inner),
      nextId: (prefix) => this.nextId(prefix),
    };
    return view;
  }

  record(event: TraceRecord): void {
    try { this.write(event); } catch (err) { this.store.warn(`recording run trace ${this.id} failed: ${err instanceof Error ? err.message : String(err)}`); }
  }

  private write(event: TraceRecord): void {
    const { event: prepared, line } = this.store.prepare(event);
    this.count(prepared);
    const essential = prepared.type === "run_start" || prepared.type === "run_end" || prepared.type === "delivery";
    if (this.truncated && !essential) { this.store.publish(this.summary, prepared); return; }
    this.bytes += Buffer.byteLength(line);
    if (this.bytes > MAX_RUN_BYTES && !essential) {
      this.truncated = true;
      const marker = this.store.prepare({ type: "truncated", bytes: MAX_RUN_BYTES });
      this.store.append(this.id, marker.line);
      this.store.publish(this.summary, marker.event);
      return;
    }
    this.store.append(this.id, line);
    this.store.publish(this.summary, prepared);
    if (prepared.type === "run_start" || prepared.type === "run_end" || (prepared.type === "delivery" && this.ended)) this.store.saveSummary({ ...this.summary });
  }

  private count(event: TraceEvent): void {
    const summary = this.summary;
    switch (event.type) {
      case "llm_end":
        summary.llmCalls++;
        summary.input += event.usage.input + event.usage.cacheRead + event.usage.cacheWrite;
        summary.output += event.usage.output;
        break;
      case "tool_end":
        summary.toolCalls++;
        if (event.isError) summary.toolErrors++;
        break;
      case "delivery":
        summary.delivered = event.ok && summary.delivered !== false;
        break;
      case "run_end":
        this.ended = true;
        summary.endedAt = event.t;
        summary.ms = event.ms;
        summary.outcome = event.outcome;
        if (event.error) summary.error = event.error.slice(0, 300);
        break;
    }
  }
}

class Scope implements TraceScope {
  private run: Run | undefined;
  private previous: Run | undefined;

  constructor(private readonly store: TraceStore) {}

  get current(): RunTrace | undefined { return this.run; }

  get latest(): RunTrace | undefined { return this.run ?? this.previous; }

  begin(info: RunInfo): RunTrace {
    if (this.run) this.finish("stopped");
    const run = this.store.start(info);
    this.run = run;
    run.record({ type: "run_start", id: run.id, ...info });
    return run;
  }

  finish(outcome: TraceOutcome, detail: { error?: string; reply?: string } = {}): void {
    const run = this.run;
    if (!run) return;
    this.run = undefined;
    this.previous = run;
    run.record({ type: "run_end", ms: Math.max(0, this.store.now() - run.summary.startedAt), outcome, ...(detail.error ? { error: detail.error } : {}), ...(detail.reply ? { reply: detail.reply } : {}) });
  }
}

const cursorOf = (run: TraceSummary): string => `${run.startedAt}:${run.id}`;

function parseCursor(cursor: string | undefined): { at: number; id: string } | undefined {
  if (cursor === undefined) return undefined;
  const split = cursor.indexOf(":");
  const at = Number(split < 0 ? cursor : cursor.slice(0, split));
  // A cursor without an id names only a time: the runs that started before it.
  return Number.isFinite(at) ? { at, id: split < 0 ? "" : cursor.slice(split + 1) } : undefined;
}
