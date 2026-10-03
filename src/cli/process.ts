import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { writeFileAtomic } from "../store/atomic.js";

const execFileAsync = promisify(execFile);

interface ProcessIdentity {
  startTime: string;
  command: string;
}

interface PidRecord {
  pid: number;
  identity: ProcessIdentity;
}

export async function readPid(file: string): Promise<number | undefined> {
  try {
    const record: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!isPidRecord(record)) return undefined;
    const current = await processIdentity(record.pid);
    return current?.startTime === record.identity.startTime && current.command === record.identity.command
      ? record.pid
      : undefined;
  } catch {
    return undefined;
  }
}

export async function writePid(file: string, pid: number): Promise<void> {
  const identity = await processIdentity(pid);
  if (!identity) throw new Error(`无法验证进程身份（pid ${pid}）`);
  await writeFileAtomic(file, `${JSON.stringify({ pid, identity })}\n`);
}

async function processIdentity(pid: number): Promise<ProcessIdentity | undefined> {
  try {
    if (process.platform === "linux") {
      const [stat, command] = await Promise.all([
        readFile(`/proc/${pid}/stat`, "utf8"),
        readFile(`/proc/${pid}/cmdline`, "utf8"),
      ]);
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const startTime = fields[19];
      if (!startTime || !command || fields[0] === "Z") return undefined;
      return { startTime, command };
    }
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart=", "-o", "args="]);
    const match = stdout.trim().match(/^(.{24})\s+(.+)$/);
    return match?.[1] && match[2] ? { startTime: match[1], command: match[2] } : undefined;
  } catch {
    return undefined;
  }
}

function isPidRecord(value: unknown): value is PidRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<PidRecord>;
  return Number.isInteger(record.pid) && (record.pid ?? 0) > 0 &&
    typeof record.identity?.startTime === "string" && typeof record.identity.command === "string";
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
