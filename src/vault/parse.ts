import { posix } from "node:path";
import { parse as parseYaml } from "yaml";

export interface NoteLink { kind: "wiki" | "markdown"; target: string }
export interface NoteMeta { title: string; aliases: string[]; tags: string[]; links: NoteLink[] }
export type LinkResolver = (link: NoteLink) => string | null;

const ATTACHMENT = /\.(png|jpe?g|gif|svg|webp|bmp|avif|pdf|mp3|m4a|wav|ogg|webm|mp4|mov|mkv|zip|csv|xlsx|docx|pptx|canvas|base)$/i;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const FENCE = /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^\1[^\n]*$|(?![\s\S]))/gm;
const INLINE_CODE = /`[^`\n]*`/g;
const INLINE_TAG = /(?<=^|\s)#([\p{L}\p{N}_/-]+)/gmu;
const WIKI_LINK = /!?\[\[([^\]\n]+?)\]\]/g;
const MARKDOWN_LINK = /!?\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function splitFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const match = FRONTMATTER.exec(text);
  if (!match) return { data: {}, body: text };
  const body = text.slice(match[0].length);
  try {
    const data: unknown = parseYaml(match[1] ?? "");
    return { data: data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {}, body };
  } catch {
    return { data: {}, body };
  }
}

export function bodyOf(text: string): string {
  return splitFrontmatter(text).body;
}

function stripCode(text: string): string {
  return text.replace(FENCE, "").replace(INLINE_CODE, "");
}

function stringList(value: unknown, separator: RegExp): string[] {
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(separator) : [];
  return items.map((item) => String(item).trim().replace(/^#/, "")).filter(Boolean);
}

const unique = (items: string[]): string[] => [...new Set(items)];

function titleOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
}

function localMarkdownTarget(from: string, raw: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("#")) return null;
  let target = (raw.split("#")[0] ?? "").split("?")[0] ?? "";
  try { target = decodeURIComponent(target); } catch { /* keep the text as written */ }
  if (!/\.md$/i.test(target)) return null;
  const resolved = posix.normalize(target.startsWith("/") ? target.slice(1) : posix.join(posix.dirname(from), target));
  return resolved.startsWith("..") ? null : resolved;
}

function linksOf(path: string, prose: string): NoteLink[] {
  const links: NoteLink[] = [];
  const seen = new Set<string>();
  const add = (kind: NoteLink["kind"], target: string): void => {
    const key = `${kind}:${target}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ kind, target });
  };
  for (const match of prose.matchAll(WIKI_LINK)) {
    const target = (((match[1] ?? "").split("|")[0] ?? "").split("#")[0] ?? "").replace(/\\$/, "").trim();
    if (target && !ATTACHMENT.test(target)) add("wiki", target);
  }
  for (const match of prose.matchAll(MARKDOWN_LINK)) {
    const target = localMarkdownTarget(path, match[1] ?? "");
    if (target) add("markdown", target);
  }
  return links;
}

export function parseNote(path: string, text: string): NoteMeta {
  const { data, body } = splitFrontmatter(text);
  const prose = stripCode(body);
  const inline = [...prose.matchAll(INLINE_TAG)].map((match) => match[1] ?? "").filter((tag) => /\D/.test(tag));
  return {
    title: titleOf(path),
    aliases: stringList(data.aliases, /,/),
    tags: unique([...stringList(data.tags, /[,\s]+/), ...inline]),
    links: linksOf(path, prose),
  };
}

const shortest = (paths: string[]): string | null =>
  [...paths].sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))[0] ?? null;

export function buildResolver(notes: Map<string, NoteMeta>): LinkResolver {
  const byName = new Map<string, string[]>();
  const byPath = new Map<string, string>();
  const addName = (name: string, path: string): void => {
    const key = name.toLowerCase();
    const list = byName.get(key);
    if (!list) byName.set(key, [path]);
    else if (!list.includes(path)) list.push(path);
  };
  for (const [path, meta] of notes) {
    byPath.set(path.toLowerCase(), path);
    addName(meta.title, path);
    for (const alias of meta.aliases) addName(alias, path);
  }
  const paths = [...notes.keys()];
  return (link) => {
    if (link.kind === "markdown") return byPath.get(link.target.toLowerCase()) ?? null;
    const name = link.target.replace(/\.md$/i, "").toLowerCase();
    if (name.includes("/")) {
      return shortest(paths.filter((path) => {
        const bare = path.replace(/\.md$/i, "").toLowerCase();
        return bare === name || bare.endsWith(`/${name}`);
      }));
    }
    return shortest(byName.get(name) ?? []);
  };
}

export function buildBacklinks(notes: Map<string, NoteMeta>, resolve: LinkResolver): Map<string, string[]> {
  const back = new Map<string, Set<string>>();
  for (const [path, meta] of notes) {
    for (const link of meta.links) {
      const target = resolve(link);
      if (!target || target === path) continue;
      const sources = back.get(target) ?? new Set<string>();
      sources.add(path);
      back.set(target, sources);
    }
  }
  return new Map([...back].map(([target, sources]) => [target, [...sources].sort()]));
}
