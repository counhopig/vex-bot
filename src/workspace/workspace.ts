import { mkdir, readFile, writeFile } from "node:fs/promises";
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
