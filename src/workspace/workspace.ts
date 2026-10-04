import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dirname } from "node:path";
import { DEFAULT_PROMPTS } from "./prompts.js";
import { WORKSPACE_TEMPLATES } from "./templates.js";

export async function ensureWorkspace(dir: string): Promise<void> {
  await mkdir(join(dir, "memory"), { recursive: true });
  await mkdir(join(dir, "skills"), { recursive: true });
  for (const [name, content] of Object.entries({ ...WORKSPACE_TEMPLATES, ...DEFAULT_PROMPTS })) {
    try {
      await mkdir(dirname(join(dir, name)), { recursive: true });
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

/** Lines of each always-loaded file that reach the model; the rest is cut off. */
export const RESIDENT_LINE_LIMITS: Record<string, number> = { "SOUL.md": 200, "USER.md": 200, "MEMORY.md": 100 };

export function residentLimitWarning(name: string, text: string): string | undefined {
  const limit = RESIDENT_LINE_LIMITS[name];
  const content = text.trim();
  if (!limit || !content) return undefined;
  const lines = content.split("\n").length;
  return lines > limit ? `${name} has ${lines} lines; only the first ${limit} reach the model. Shorten it to keep everything.` : undefined;
}
