import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { VexPaths } from "../paths.js";
import { writeFileAtomic } from "../store/atomic.js";

/** Saving settings restarts vexd in place; this records what to restore if the new configuration cannot start. */
const pendingFile = (paths: VexPaths) => join(paths.home, "state", "pending-reload.json");
const errorFile = (paths: VexPaths) => join(paths.home, "state", "reload-error.json");

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

export async function writePendingReload(paths: VexPaths, previous: string): Promise<void> {
  await mkdir(join(paths.home, "state"), { recursive: true, mode: 0o700 });
  await writeFileAtomic(pendingFile(paths), JSON.stringify({ previous, at: Date.now() }), 0o600);
}

export async function readPendingReload(paths: VexPaths): Promise<{ previous: string } | undefined> {
  const value = await readJson(pendingFile(paths));
  return typeof value?.previous === "string" ? { previous: value.previous } : undefined;
}

export async function clearPendingReload(paths: VexPaths): Promise<void> {
  await rm(pendingFile(paths), { force: true });
}

/** Puts the previous configuration back after a failed start and remembers why. */
export async function rollbackReload(paths: VexPaths, pending: { previous: string }, error: unknown): Promise<void> {
  await writeFileAtomic(paths.config, pending.previous, 0o600, 0o700);
  await clearPendingReload(paths);
  await writeFileAtomic(errorFile(paths), JSON.stringify({ message: error instanceof Error ? error.message : String(error), at: Date.now() }), 0o600);
}

export async function readReloadError(paths: VexPaths): Promise<string | undefined> {
  const value = await readJson(errorFile(paths));
  return typeof value?.message === "string" ? value.message : undefined;
}

export async function clearReloadError(paths: VexPaths): Promise<void> {
  await rm(errorFile(paths), { force: true });
}
