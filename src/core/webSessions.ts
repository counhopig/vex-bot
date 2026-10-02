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

export const DEFAULT_TITLE = "新对话";
const RECOVERED_TITLE = "未命名对话";

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

  async create(now: number): Promise<WebSessionMeta> {
    const meta: WebSessionMeta = { id: randomUUID(), title: DEFAULT_TITLE, titled: false, createdAt: now, updatedAt: now };
    this.metas.set(meta.id, meta);
    await this.save();
    return { ...meta };
  }

  async update(
    id: string,
    patch: Partial<Pick<WebSessionMeta, "title" | "titled" | "updatedAt">>,
  ): Promise<WebSessionMeta | undefined> {
    const meta = this.metas.get(id);
    if (!meta) return undefined;
    Object.assign(meta, patch);
    await this.save();
    return { ...meta };
  }

  async remove(id: string): Promise<void> {
    if (this.metas.delete(id)) await this.save();
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

  private save(): Promise<void> {
    // Serialize writes so an older snapshot can never land after a newer one.
    const run = this.saving.then(() => writeFileAtomic(this.file, JSON.stringify([...this.metas.values()], null, 2)));
    this.saving = run.catch(() => {});
    return run;
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