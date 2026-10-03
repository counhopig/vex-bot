import { randomBytes } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function writeFileAtomic(path: string, data: string, mode?: number, dirMode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: dirMode });
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, data, { encoding: "utf8", mode });
  await rename(tmp, path);
}
