import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileAtomic } from "../src/store/atomic.js";
import { appendJsonl, readJsonl } from "../src/store/jsonl.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

let dir: string;
beforeEach(async () => { dir = await makeTmpDir(); });
afterEach(async () => { await removeTmpDir(dir); });

describe("writeFileAtomic", () => {
  it("creates parent directories and writes content without leaving temp files", async () => {
    const file = join(dir, "a", "b", "c.txt");
    await writeFileAtomic(file, "hello");
    expect(await readFile(file, "utf8")).toBe("hello");
    expect(await readdir(join(dir, "a", "b"))).toEqual(["c.txt"]);
  });

  it("replaces existing content", async () => {
    const file = join(dir, "c.txt");
    await writeFileAtomic(file, "one");
    await writeFileAtomic(file, "two");
    expect(await readFile(file, "utf8")).toBe("two");
  });
});

describe("jsonl", () => {
  it("returns an empty list for a missing file", async () => {
    expect(await readJsonl(join(dir, "missing.jsonl"))).toEqual([]);
  });

  it("appends records in order", async () => {
    const file = join(dir, "s", "log.jsonl");
    await appendJsonl(file, { n: 1 });
    await appendJsonl(file, { n: 2 });
    expect(await readJsonl(file)).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("skips a torn trailing line", async () => {
    const file = join(dir, "log.jsonl");
    await writeFile(file, '{"n":1}\n{"n":2}\n{"n":', "utf8");
    expect(await readJsonl(file)).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("preserves the first appended record after recovering a torn trailing line", async () => {
    const file = join(dir, "log.jsonl");
    await writeFile(file, '{"n":1}\n{"n":', "utf8");
    expect(await readJsonl(file)).toEqual([{ n: 1 }]);
    await appendJsonl(file, { n: 2 });
    await appendJsonl(file, { n: 3 });
    expect(await readJsonl(file)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it("preserves a valid trailing record without a newline before appending", async () => {
    const file = join(dir, "log.jsonl");
    await writeFile(file, '{"n":1}', "utf8");
    expect(await readJsonl(file)).toEqual([{ n: 1 }]);
    await appendJsonl(file, { n: 2 });
    expect(await readJsonl(file)).toEqual([{ n: 1 }, { n: 2 }]);
  });
});
