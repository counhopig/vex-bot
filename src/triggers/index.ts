import { randomUUID } from "node:crypto";
import { writeFileAtomic } from "../store/atomic.js";
import { appendJsonl, readJsonl } from "../store/jsonl.js";

/** Work a source asked for: the trace source it belongs to, its name, and what it would do. */
export interface TriggerRequest {
  /** The source a run would carry in its trace, such as "proactive chat". */
  source: string;
  /** One line naming the work, such as `Scheduled task "morning brief"`. */
  title: string;
  /** The prompt or message the source was about to send. */
  text: string;
}

/** Work that was recorded instead of run, so the owner can see what would have happened. */
export interface TriggerRecord extends TriggerRequest {
  id: string;
  at: number;
}

/** What a source is allowed to do: run its work, or only have it recorded. */
export type TriggerMode = "act" | "record";

/** One place Vex starts work on its own, and whether it may act without the owner's word. */
export interface TriggerSource {
  /** The name its runs carry in their traces; also the name the configuration and the viewer use. */
  name: string;
  /** A source that has not proved itself records its work until the owner lists it as allowed. */
  defaultMode: TriggerMode;
}

/** The sources built into the daemon. A new one is registered here with `defaultMode: "record"`. */
export const BUILTIN_TRIGGER_SOURCES: readonly TriggerSource[] = [
  { name: "scheduled task", defaultMode: "act" },
  { name: "missed scheduled task", defaultMode: "act" },
  { name: "heartbeat", defaultMode: "act" },
  { name: "proactive chat", defaultMode: "act" },
  { name: "wiki", defaultMode: "act" },
  { name: "watchdog", defaultMode: "act" },
];

export interface TriggerLogOptions {
  path: string;
  /** The sources that may run; absent, the built-in ones. */
  sources?: readonly TriggerSource[];
  /** Sources whose work is only recorded, whatever their default. */
  recordOnly?: readonly string[];
  /** Sources that may act although they record by default. */
  allow?: readonly string[];
  retainDays?: number;
  now?: () => number;
  /** Called after a record is added, so an open interface can refresh. */
  onRecord?: (record: TriggerRecord) => void;
  onChange?: () => void;
  onWarning?: (message: string) => void;
}

const DEFAULT_RETAIN_DAYS = 7;
const DAY_MS = 86_400_000;
/** Records kept in memory for the viewer; older ones stay in the file until they are pruned. */
const KEPT = 100;
/** The file is rewritten with the newest records once it holds this many. */
const MAX_RECORDS = 5000;
const KEPT_ON_REWRITE = 2000;
const TITLE_LIMIT = 200;
const TEXT_LIMIT = 4000;

function bound(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…[+${text.length - limit} chars]` : text;
}

function isRecord(value: unknown): value is TriggerRecord {
  const record = value as Partial<TriggerRecord> | null;
  return !!record
    && typeof record.id === "string"
    && typeof record.at === "number"
    && typeof record.source === "string"
    && typeof record.title === "string"
    && typeof record.text === "string";
}

/**
 * The log of work that was recorded instead of run, and the registry that says which sources may
 * act. A source set to record keeps its schedule and its trace source but does nothing: what it was
 * about to do is written here, and the owner decides from the viewer whether it should run again.
 */
export class TriggerLog {
  private records: TriggerRecord[] = [];
  private count = 0;
  // Appends run one at a time, so the file keeps the order the requests arrived in.
  private writes: Promise<void> = Promise.resolve();
  private readonly modes = new Map<string, TriggerMode>();
  private readonly now: () => number;

  constructor(private readonly opts: TriggerLogOptions) {
    this.now = opts.now ?? Date.now;
    for (const source of opts.sources ?? BUILTIN_TRIGGER_SOURCES) this.modes.set(source.name, source.defaultMode);
    for (const name of [...opts.allow ?? [], ...opts.recordOnly ?? []]) {
      if (!this.modes.has(name)) throw new Error(`Unknown trigger source "${name}"`);
    }
    // A source that is both listed as allowed and set to record only stays recorded.
    for (const name of opts.allow ?? []) this.modes.set(name, "act");
    for (const name of opts.recordOnly ?? []) this.modes.set(name, "record");
  }

  /** Loads the records kept from earlier runs, dropping those past the retention. */
  async open(): Promise<void> {
    const cutoff = this.now() - (this.opts.retainDays ?? DEFAULT_RETAIN_DAYS) * DAY_MS;
    const stored = await readJsonl<TriggerRecord>(this.opts.path);
    const kept = stored.filter((record) => isRecord(record) && record.at >= cutoff);
    this.records = kept.slice(-KEPT).reverse();
    this.count = kept.length;
    if (kept.length !== stored.length) await this.rewrite(kept);
  }

  /** Whether a source may act, or only be recorded; a source that is not registered is a programming error. */
  modeOf(source: string): TriggerMode {
    const mode = this.modes.get(source);
    if (!mode) throw new Error(`Unknown trigger source "${source}"`);
    return mode;
  }

  /**
   * True when the work should run. A source set to record only has its request written down
   * instead, and this returns false so the caller leaves the work undone.
   */
  admit(request: TriggerRequest): boolean {
    if (this.modeOf(request.source) === "act") return true;
    this.add(request);
    return false;
  }

  /** Recorded work, newest first. */
  list(): TriggerRecord[] {
    return this.records.map((record) => ({ ...record }));
  }

  async close(): Promise<void> {
    await this.writes;
  }

  private add(request: TriggerRequest): void {
    const record: TriggerRecord = {
      id: randomUUID(),
      at: this.now(),
      source: request.source,
      title: bound(request.title, TITLE_LIMIT),
      text: bound(request.text, TEXT_LIMIT),
    };
    this.records.unshift(record);
    if (this.records.length > KEPT) this.records.length = KEPT;
    this.count++;
    const rotate = this.count > MAX_RECORDS;
    this.writes = this.writes
      .then(async () => {
        if (!rotate) {
          await appendJsonl(this.opts.path, record);
          return;
        }
        const stored = await readJsonl<TriggerRecord>(this.opts.path);
        await this.rewrite([...stored.filter(isRecord), record].slice(-KEPT_ON_REWRITE));
        this.count = KEPT_ON_REWRITE;
      })
      .catch((err: unknown) => this.opts.onWarning?.(`Recorded triggers could not be saved: ${err instanceof Error ? err.message : String(err)}`));
    this.opts.onRecord?.(record);
    this.opts.onChange?.();
  }

  private rewrite(records: TriggerRecord[]): Promise<void> {
    return writeFileAtomic(this.opts.path, records.map((record) => `${JSON.stringify(record)}\n`).join(""), 0o600);
  }
}
