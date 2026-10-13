import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function appendJsonl(path: string, record: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "a+");
  try {
    const { size } = await handle.stat();
    const last = Buffer.alloc(1);
    if (size > 0) await handle.read(last, 0, 1, size - 1);
    const boundary = size > 0 && last[0] !== 10 ? "\n" : "";
    await handle.writeFile(`${boundary}${JSON.stringify(record)}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

export async function readJsonl<T = unknown>(path: string): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const records: T[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as T);
    } catch {
      // A crash mid-append can leave one torn line; everything before it is intact.
    }
  }
  return records;
}

/** Streams a fixed file snapshot without retaining the complete log in memory. */
export async function* scanJsonl<T = unknown>(path: string): AsyncGenerator<T> {
  for await (const { record } of scanJsonlLines<T>(path)) {
    if (record !== undefined) yield record;
  }
}

export interface JsonlLine<T> { record: T | undefined; start: number; end: number; complete: boolean }

/**
 * Streams the lines of a fixed file snapshot from a byte offset, with each line's byte range.
 * A final line without a newline is reported as incomplete; blank and torn lines carry no record.
 */
export async function* scanJsonlLines<T = unknown>(path: string, from = 0): AsyncGenerator<JsonlLine<T>> {
  let handle;
  try { handle = await open(path, "r"); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  try {
    const { size } = await handle.stat();
    const chunk = Buffer.alloc(65_536);
    let parts: Buffer[] = [];
    let position = from;
    let lineStart = from;
    while (position < size) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, size - position), position);
      if (!bytesRead) break;
      const data = chunk.subarray(0, bytesRead);
      let start = 0;
      for (let newline = data.indexOf(10); newline !== -1; newline = data.indexOf(10, start)) {
        parts.push(data.subarray(start, newline));
        const end = position + newline + 1;
        const line = Buffer.concat(parts).toString("utf8");
        parts = [];
        start = newline + 1;
        yield { record: parseLine<T>(line), start: lineStart, end, complete: true };
        lineStart = end;
      }
      if (start < bytesRead) parts.push(Buffer.from(data.subarray(start)));
      position += bytesRead;
    }
    if (parts.length) yield { record: parseLine<T>(Buffer.concat(parts).toString("utf8")), start: lineStart, end: position, complete: false };
  } finally { await handle.close(); }
}

function parseLine<T>(line: string): T | undefined {
  if (!line.trim()) return undefined;
  try { return JSON.parse(line) as T; } catch { return undefined; }
}
