import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { WikiRepo } from "./git.js";

export interface Change {
  path: string;
  status: "A" | "M" | "D";
  previous?: string;
}

/** Splits items into consecutive groups of at most `size`; a size below one means one item per group. */
export function chunk<T>(items: T[], size: number): T[][] {
  const width = Math.max(1, Math.floor(size) || 1);
  const groups: T[][] = [];
  for (let index = 0; index < items.length; index += width) groups.push(items.slice(index, index + width));
  return groups;
}

/** The wiki/ and raw/ subtrees are generated, and dot-prefixed segments are tool or editor state. */
function excluded(path: string): boolean {
  return path.startsWith("wiki/") || path.startsWith("raw/") || path.split("/").some((segment) => segment.startsWith("."));
}

async function walk(root: string, prefix: string, out: string[]): Promise<void> {
  const entries = await readdir(prefix === "" ? root : join(root, prefix), { withFileTypes: true });
  for (const entry of entries) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.name.startsWith(".") || excluded(path)) continue;
    if (entry.isDirectory()) await walk(root, path, out);
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(path);
  }
}

/**
 * Markdown files a vault consumer has not seen yet.
 * `from === null` means first run, so every markdown file is new; otherwise the diff between `from` and HEAD is used.
 */
export async function detectChanges(repo: WikiRepo, from: string | null): Promise<Change[]> {
  if (from === null) {
    const paths: string[] = [];
    await walk(repo.root, "", paths);
    paths.sort();
    return paths.map((path) => ({ path, status: "A" as const }));
  }

  const changes: Change[] = [];
  for (const entry of await repo.diffNames(from, "HEAD", "*.md")) {
    if (excluded(entry.path)) continue;
    if (entry.status === "D") {
      const change: Change = { path: entry.path, status: "D" };
      try {
        change.previous = await repo.show(from, entry.path);
      } catch {
        // The path is absent at `from`, so only the deletion is reportable.
      }
      changes.push(change);
    } else {
      changes.push({ path: entry.path, status: entry.status });
    }
  }
  return changes;
}
