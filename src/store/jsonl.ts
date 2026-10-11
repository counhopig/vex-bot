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
  let handle;
  try { handle = await open(path, "r"); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  try {
    const { size } = await handle.stat();
    if (!size) return;
    const input = handle.createReadStream({ end: size - 1, encoding: "utf8" });
    let fragments: string[] = [];
    try {
      // Reading chunks directly preserves backpressure while a consumer awaits an LLM or disk write.
      for await (const chunk of input) {
        const text = chunk as string;
        let start = 0;
        for (let end = text.indexOf("\n"); end >= 0; end = text.indexOf("\n", start)) {
          const line = fragments.join("") + text.slice(start, end);
          fragments = [];
          start = end + 1;
          const record = parseLine<T>(line);
          if (record !== undefined) yield record;
        }
        if (start < text.length) fragments.push(text.slice(start));
      }
      const record = parseLine<T>(fragments.join(""));
      if (record !== undefined) yield record;
    } finally { input.destroy(); }
  } finally { await handle.close(); }
}

function parseLine<T>(line: string): T | undefined {
  if (!line.trim()) return undefined;
  try { return JSON.parse(line) as T; } catch { return undefined; }
}
