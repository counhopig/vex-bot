import { realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const tails = new Map<string, Promise<void>>();

/** The real path a write lands on: symlinks resolve, and a missing file resolves through its nearest existing parent. */
export async function realTarget(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    const parent = dirname(path);
    if (parent === path) return path;
    return join(await realTarget(parent), basename(path));
  }
}

/**
 * Runs fn while holding an in-process lock on the file's real path, so every
 * read-modify-write in the daemon (tools in any session, delegates, background
 * runs and WebChat saves) is serialized per file. fn receives the real path.
 */
export async function withFileLock<T>(path: string, fn: (target: string) => Promise<T>): Promise<T> {
  const target = await realTarget(path);
  const previous = tails.get(target) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => held);
  tails.set(target, tail);
  await previous;
  try {
    return await fn(target);
  } finally {
    release();
    if (tails.get(target) === tail) tails.delete(target);
  }
}
