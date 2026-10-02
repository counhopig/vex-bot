import { readFile, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { writeFileAtomic } from "../store/atomic.js";

export async function readPid(file: string): Promise<number | undefined> {
  try {
    const pid = Number((await readFile(file, "utf8")).trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

export async function writePid(file: string, pid: number): Promise<void> {
  await writeFileAtomic(file, `${pid}\n`);
}

export async function removePid(file: string): Promise<void> {
  await rm(file, { force: true });
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function waitUntil(
  check: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 200,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await delay(intervalMs);
  }
  return check();
}

export async function tailLines(file: string, count: number): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return [];
  }
  return text.split("\n").filter((line) => line.length > 0).slice(-count);
}
