import { randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../store/atomic.js";

export interface WebSessionMeta {
  id: string;
  title: string;
  titled: boolean;
  createdAt: number;
  updatedAt: number;
}

export const DEFAULT_TITLE = "New chat";
const RECOVERED_TITLE = "Untitled chat";

export class WebSessionIndex {
  private metas = new Map<string, WebSessionMeta>();
  private saving: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly dir: string,
  ) {}

  async load(): Promise<void> {
    let text: string | undefined;
    try {
      text = await readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (text !== undefined) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (Array.isArray(parsed)) {
          this.metas = new Map(parsed.filter(isMeta).map((m) => [m.id, m]));
          return;
        }
      } catch {
        // Fall through and rebuild from the transcripts on disk.
      }
    }
    await this.rebuild();
  }

  list(): WebSessionMeta[] {
    return [...this.metas.values()].sort((a, b) => b.updatedAt - a.updatedAt).map((m) => ({ ...m }));
  }

  get(id: string): WebSessionMeta | undefined {
    const meta = this.metas.get(id);
    return meta ? { ...meta } : undefined;
  }

  create(now: number): Promise<WebSessionMeta> {
    const meta: WebSessionMeta = { id: randomUUID(), title: DEFAULT_TITLE, titled: false, createdAt: now, updatedAt: now };
    return this.transact((metas) => {
      metas.set(meta.id, meta);
      return { ...meta };
    });
  }

  update(
    id: string,
    patch: Partial<Pick<WebSessionMeta, "title" | "titled" | "updatedAt">>,
  ): Promise<WebSessionMeta | undefined> {
    return this.transact((metas) => {
      const meta = metas.get(id);
      if (!meta) return undefined;
      const next = { ...meta, ...patch };
      metas.set(id, next);
      return { ...next };
    });
  }

  remove(id: string): Promise<void> {
    return this.transact((metas) => { metas.delete(id); });
  }

  private async rebuild(): Promise<void> {
    this.metas.clear();
    let names: string[] = [];
    try {
      names = await readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const info = await stat(join(this.dir, name));
      const id = name.slice(0, -".jsonl".length);
      this.metas.set(id, {
        id,
        title: RECOVERED_TITLE,
        titled: true,
        createdAt: Math.floor(info.birthtimeMs || info.mtimeMs),
        updatedAt: Math.floor(info.mtimeMs),
      });
    }
    if (this.metas.size > 0) await this.save();
  }

  /**
   * Applies a change to a copy of the index, saves it, and only then makes it the
   * current state, so a failed save leaves the index as it was. Changes run one at
   * a time, so each starts from the result of the previous one.
   */
  private transact<T>(change: (metas: Map<string, WebSessionMeta>) => T): Promise<T> {
    const run = this.saving.then(async () => {
      const next = new Map(this.metas);
      const result = change(next);
      await writeFileAtomic(this.file, JSON.stringify([...next.values()], null, 2));
      this.metas = next;
      return result;
    });
    this.saving = run.then(() => {}, () => {});
    return run;
  }

  private save(): Promise<void> {
    return this.transact(() => {});
  }
}

function isMeta(value: unknown): value is WebSessionMeta {
  if (!value || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.id === "string" &&
    typeof m.title === "string" &&
    typeof m.titled === "boolean" &&
    typeof m.createdAt === "number" &&
    typeof m.updatedAt === "number"
  );
}
