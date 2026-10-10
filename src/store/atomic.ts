import { randomBytes } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Writes through a temporary file and a rename, so readers see the old or the
 * new content and never a partial file. Without an explicit mode, an existing
 * file keeps its permissions.
 */
export async function writeFileAtomic(path: string, data: string, mode?: number, dirMode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: dirMode });
  if (mode === undefined) {
    try {
      mode = (await stat(path)).mode & 0o7777;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, data, { encoding: "utf8", mode });
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}
