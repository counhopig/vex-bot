import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WORKSPACE_TEMPLATES } from "./templates.js";

export async function ensureWorkspace(dir: string): Promise<void> {
  await mkdir(join(dir, "memory"), { recursive: true });
  await mkdir(join(dir, "skills"), { recursive: true });
  for (const [name, content] of Object.entries(WORKSPACE_TEMPLATES)) {
    try {
      await writeFile(join(dir, name), content, { encoding: "utf8", flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
}

export async function readWorkspaceFile(dir: string, name: string): Promise<string> {
  try {
    return await readFile(join(dir, name), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

export const DAILY_NOTE = /^memory\/\d{4}-\d{2}-\d{2}\.md$/;

/** Daily notes as workspace paths, newest first. */
export async function listDailyNotes(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(join(dir, "memory"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return names.map((name) => `memory/${name}`).filter((name) => DAILY_NOTE.test(name)).sort().reverse();
}

/** Lines of each always-loaded file that reach the model; the rest is cut off. */
export const RESIDENT_LINE_LIMITS: Record<string, number> = { "SOUL.md": 200, "USER.md": 200, "MEMORY.md": 100 };

export function residentLimitWarning(name: string, text: string): string | undefined {
  const limit = RESIDENT_LINE_LIMITS[name];
  const content = text.trim();
  if (!limit || !content) return undefined;
  const lines = content.split("\n").length;
  return lines > limit ? `${name} has ${lines} lines; only the first ${limit} reach the model. Shorten it to keep everything.` : undefined;
}
