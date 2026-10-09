import type { Dirent, Stats } from "node:fs";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import type { VaultConfig } from "../config/schema.js";
import { isInside } from "../tools/paths.js";
import { CommitTimes, GitMirror, type GitRunner } from "./git.js";
import { bodyOf, buildBacklinks, buildResolver, parseNote, type NoteMeta } from "./parse.js";

export interface VaultOptions {
  home: string;
  config: VaultConfig;
  now?: () => number;
  run?: GitRunner;
  protocols?: string;
  maxNotes?: number;
  onWarning?: (message: string) => void;
}
export interface SearchParams { query?: string; tag?: string; folder?: string; since?: string; before?: string; limit?: number }
export interface SearchHit { path: string; title: string; changed: string; tags: string[]; snippet: string }
export interface SearchOutput { results: SearchHit[]; total: number; source: string }
export interface ReadOutput {
  path: string;
  title: string;
  changed: string;
  tags: string[];
  text: string;
  outLinks: { target: string; path: string | null }[];
  backlinks: string[];
  source: string;
}

const MAX_NOTE_BYTES = 1_000_000;
const MAX_NOTES = 20_000;
const MAX_READ_CHARS = 30_000;
const SNIPPET_CHARS = 200;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 30;

interface CacheEntry { root: string; size: number; mtimeMs: number; meta: NoteMeta }

const iso = (ms: number): string => new Date(ms).toISOString();
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

function parseWhen(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const text = value.trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T00:00:00`) : new Date(text);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${value}; use YYYY-MM-DD or an ISO 8601 date and time`);
  return date.getTime();
}

function normalizeNotePath(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter((part) => part !== "" && part !== ".");
  const invalid = path.trim() === "" || /^([a-zA-Z]:)?[\\/]/.test(path) || parts.some((part) => part.startsWith(".")) || !/\.md$/i.test(parts.at(-1) ?? "");
  if (invalid) throw new Error("Note paths are relative to the vault, end in .md and contain no .. or hidden folders; use a path returned by vault_search");
  return parts.join("/");
}

async function listNotes(root: string, max: number): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  let truncated = false;
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let entries: Dirent[];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (truncated) return;
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(dir, entry.name), rel);
      else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        if (files.length >= max) { truncated = true; return; }
        files.push(rel);
      }
    }
  };
  await walk(root, "");
  return { files, truncated };
}

function excerpt(body: string, patterns: RegExp[]): string {
  const hits = patterns.map((pattern) => body.search(pattern)).filter((index) => index >= 0);
  let start = hits.length ? Math.max(0, Math.min(...hits) - 70) : 0;
  let end = Math.min(body.length, start + SNIPPET_CHARS);
  if (start > 0 && isLowSurrogate(body.charCodeAt(start))) start++;
  if (end < body.length && isLowSurrogate(body.charCodeAt(end))) end--;
  const text = body.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${text}${end < body.length ? "…" : ""}`;
}

const readText = (root: string, path: string): Promise<string> => readFile(join(root, path), "utf8").catch(() => "");
const metaOf = (notes: Map<string, CacheEntry>): Map<string, NoteMeta> => new Map([...notes].map(([path, entry]) => [path, entry.meta]));

export class Vault {
  private readonly mirror?: GitMirror;
  private readonly times: CommitTimes;
  private cache = new Map<string, CacheEntry>();
  private truncated = false;

  constructor(private readonly opts: VaultOptions) {
    const { config } = opts;
    if (config.url) {
      this.mirror = new GitMirror({
        home: opts.home, url: config.url, branch: config.branch, username: config.username, token: config.token,
        now: opts.now, run: opts.run, protocols: opts.protocols, onWarning: opts.onWarning,
      });
    }
    this.times = new CommitTimes(opts.run);
  }

  async search(params: SearchParams): Promise<SearchOutput> {
    const { root, source } = await this.prepare();
    const notes = await this.scan(root);
    const changedAt = await this.changedAt(root, notes);
    const since = parseWhen(params.since);
    const before = parseWhen(params.before);
    const patterns = (params.query ?? "").split(/\s+/).filter(Boolean).map((term) => new RegExp(escapeRegExp(term), "gi"));
    const tag = params.tag?.trim().replace(/^#/, "").toLowerCase();
    const folder = params.folder?.trim().replace(/^\/+|\/+$/g, "").toLowerCase();
    const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

    const candidates: { path: string; entry: CacheEntry; changed: number; matched: number; weight: number }[] = [];
    for (const [path, entry] of notes) {
      const changed = changedAt(path);
      if (since !== undefined && changed < since) continue;
      if (before !== undefined && changed >= before) continue;
      if (folder && !path.toLowerCase().startsWith(`${folder}/`)) continue;
      if (tag && !entry.meta.tags.some((t) => { const lower = t.toLowerCase(); return lower === tag || lower.startsWith(`${tag}/`); })) continue;
      candidates.push({ path, entry, changed, matched: 0, weight: 0 });
    }

    let ranked = candidates;
    if (patterns.length) {
      ranked = [];
      for (const candidate of candidates) {
        const text = await readText(root, candidate.path);
        const body = bodyOf(text);
        const headings = body.split("\n").filter((line) => /^#{1,6}\s/.test(line)).join("\n");
        const tags = candidate.entry.meta.tags.join(" ");
        for (const pattern of patterns) {
          const inTitle = candidate.entry.meta.title.search(pattern) >= 0 || candidate.path.search(pattern) >= 0;
          const inHeadings = headings.search(pattern) >= 0;
          const inTags = tags.search(pattern) >= 0;
          const count = (body.match(pattern) ?? []).length;
          if (!inTitle && !inHeadings && !inTags && count === 0) continue;
          candidate.matched++;
          candidate.weight += (inTitle ? 5 : 0) + (inHeadings ? 3 : 0) + (inTags ? 3 : 0) + Math.min(count, 20);
        }
        if (candidate.matched > 0) ranked.push(candidate);
      }
    }
    ranked.sort((a, b) => b.matched - a.matched || b.weight - a.weight || b.changed - a.changed);

    const results: SearchHit[] = [];
    for (const item of ranked.slice(0, limit)) {
      const text = await readText(root, item.path);
      results.push({ path: item.path, title: item.entry.meta.title, changed: iso(item.changed), tags: item.entry.meta.tags, snippet: excerpt(bodyOf(text), patterns) });
    }
    return { results, total: ranked.length, source: this.describe(source) };
  }

  async read(path: string): Promise<ReadOutput> {
    const wanted = normalizeNotePath(path);
    const { root, source } = await this.prepare();
    const notes = await this.scan(root);
    const key = notes.has(wanted) ? wanted : [...notes.keys()].find((candidate) => candidate.toLowerCase() === wanted.toLowerCase());
    const entry = key ? notes.get(key) : undefined;
    const missing = new Error(`Note not found: ${wanted}. Use vault_search to find the path.`);
    if (!key || !entry) throw missing;
    const abs = join(root, key);
    if (!isInside(await realpath(root), await realpath(abs).catch(() => ""))) throw missing;
    const text = await readFile(abs, "utf8");
    const metas = metaOf(notes);
    const resolve = buildResolver(metas);
    const seen = new Set<string>();
    const outLinks: { target: string; path: string | null }[] = [];
    for (const link of entry.meta.links) {
      if (seen.has(link.target)) continue;
      seen.add(link.target);
      outLinks.push({ target: link.target, path: resolve(link) });
    }
    const changed = (await this.changedAt(root, notes))(key);
    return {
      path: key,
      title: entry.meta.title,
      changed: iso(changed),
      tags: entry.meta.tags,
      text: text.length > MAX_READ_CHARS ? `${text.slice(0, MAX_READ_CHARS)}\n… (truncated; ${text.length} characters in total)` : text,
      outLinks,
      backlinks: buildBacklinks(metas, resolve).get(key) ?? [],
      source: this.describe(source),
    };
  }

  private async prepare(): Promise<{ root: string; source: string }> {
    if (this.mirror) {
      const state = await this.mirror.refresh();
      if (!state.root) throw new Error(`The notes vault could not be fetched: ${state.error ?? "unknown error"}`);
      const when = state.syncedAt === null ? "an earlier sync" : iso(state.syncedAt);
      return { root: state.root, source: state.error ? `git copy from ${when}; the latest sync failed: ${state.error}` : `git copy synced ${when}` };
    }
    const root = this.opts.config.path ?? "";
    const info = await stat(root).catch(() => undefined);
    if (!info?.isDirectory()) {
      throw new Error(`The notes vault folder ${root} does not exist or cannot be read. In Docker, mount the folder into the container and set vault.path to its path inside the container.`);
    }
    return { root, source: `folder ${root}` };
  }

  private describe(source: string): string {
    const max = this.opts.maxNotes ?? MAX_NOTES;
    return this.truncated ? `${source}; the vault has more notes than the limit of ${max}, and only the first ${max} are searched` : source;
  }

  private async scan(root: string): Promise<Map<string, CacheEntry>> {
    const { files, truncated } = await listNotes(root, this.opts.maxNotes ?? MAX_NOTES);
    this.truncated = truncated;
    const next = new Map<string, CacheEntry>();
    for (const rel of files) {
      const abs = join(root, rel);
      let info: Stats;
      try { info = await lstat(abs); } catch { continue; }
      if (!info.isFile() || info.size > MAX_NOTE_BYTES) continue;
      const old = this.cache.get(rel);
      if (old && old.root === root && old.size === info.size && old.mtimeMs === info.mtimeMs) { next.set(rel, old); continue; }
      let text: string;
      try { text = await readFile(abs, "utf8"); } catch { continue; }
      next.set(rel, { root, size: info.size, mtimeMs: info.mtimeMs, meta: parseNote(rel, text) });
    }
    this.cache = next;
    return next;
  }

  /** Commit time when the notes live in a git repository, file time otherwise. */
  private async changedAt(root: string, notes: Map<string, CacheEntry>): Promise<(path: string) => number> {
    const useGit = this.mirror !== undefined || (await stat(join(root, ".git")).then(() => true, () => false));
    const commits = useGit ? await this.times.get(root) : null;
    return (path) => commits?.get(path) ?? notes.get(path)?.mtimeMs ?? 0;
  }
}
