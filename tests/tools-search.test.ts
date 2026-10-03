import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCoreTools } from "../src/tools/registry.js";
import { createFindTool, createGrepTool } from "../src/tools/search.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

let ws: string;
beforeEach(async () => {
  ws = await makeTmpDir();
  await mkdir(join(ws, "memory"), { recursive: true });
  await mkdir(join(ws, "node_modules", "x"), { recursive: true });
  await writeFile(join(ws, "MEMORY.md"), "主人喜欢咖啡\n不喝茶\n", "utf8");
  await writeFile(join(ws, "memory", "2026-10-01.md"), "今天喝了 Coffee\n", "utf8");
  await writeFile(join(ws, "memory", "notes.txt"), "coffee beans\n", "utf8");
  await writeFile(join(ws, "node_modules", "x", "a.md"), "coffee\n", "utf8");
  await writeFile(join(ws, "bin.dat"), Buffer.from([0x63, 0x00, 0x6f]));
});
afterEach(async () => { await removeTmpDir(ws); });

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((c) => c.text ?? "").join("");
}

describe("grep", () => {
  it("finds matches with path and line number, skipping vendored and binary files", async () => {
    const out = textOf(await createGrepTool(ws).execute("1", { pattern: "coffee", ignoreCase: true }));
    expect(out.split("\n").sort()).toEqual(["memory/2026-10-01.md:1:今天喝了 Coffee", "memory/notes.txt:1:coffee beans"]);
  });

  it("filters by glob and handles CJK patterns", async () => {
    expect(textOf(await createGrepTool(ws).execute("1", { pattern: "coffee", ignoreCase: true, glob: "**/*.md" }))).toBe(
      "memory/2026-10-01.md:1:今天喝了 Coffee",
    );
    expect(textOf(await createGrepTool(ws).execute("1", { pattern: "咖啡" }))).toBe("MEMORY.md:1:主人喜欢咖啡");
  });

  it("searches a single file", async () => {
    expect(textOf(await createGrepTool(ws).execute("1", { pattern: "茶", path: "MEMORY.md" }))).toBe("MEMORY.md:2:不喝茶");
  });

  it("says so when nothing matches and rejects bad regexes", async () => {
    expect(textOf(await createGrepTool(ws).execute("1", { pattern: "zzz" }))).toBe("没有匹配");
    await expect(createGrepTool(ws).execute("1", { pattern: "(" })).rejects.toThrow();
  });

  it("caps the number of matches", async () => {
    await writeFile(join(ws, "many.txt"), "hit\n".repeat(300), "utf8");
    const out = textOf(await createGrepTool(ws).execute("1", { pattern: "hit", path: "many.txt" }));
    expect(out.split("\n")).toHaveLength(201);
    expect(out.endsWith("…（结果超过 200 条，已截断）")).toBe(true);
  });
});

describe("grep file limits", () => {
  it("skips files over 1 MB", async () => {
    await writeFile(join(ws, "huge.txt"), `coffee\n${"x".repeat(1_100_000)}`, "utf8");
    const out = textOf(await createGrepTool(ws).execute("1", { pattern: "coffee", ignoreCase: true }));
    expect(out).not.toContain("huge.txt");
    expect(out).toContain("notes.txt");
  });

  it("skips unreadable files instead of aborting", async () => {
    await writeFile(join(ws, "locked.txt"), "coffee\n", "utf8");
    await chmod(join(ws, "locked.txt"), 0o000);
    const out = textOf(await createGrepTool(ws).execute("1", { pattern: "coffee", ignoreCase: true }));
    expect(out).not.toContain("locked.txt");
    expect(out).toContain("notes.txt");
  });
});

describe("find", () => {
  it("lists matching files relative to the search directory", async () => {
    expect(textOf(await createFindTool(ws).execute("1", { pattern: "**/*.md" }))).toBe("MEMORY.md\nmemory/2026-10-01.md");
    expect(textOf(await createFindTool(ws).execute("1", { pattern: "*.txt", path: "memory" }))).toBe("notes.txt");
    expect(textOf(await createFindTool(ws).execute("1", { pattern: "*.zip" }))).toBe("没有找到匹配的文件");
  });
});

describe("createCoreTools", () => {
  it("returns the core tools in a stable order", () => {
    expect(createCoreTools({ workspace: ws, bashEnvPassthrough: [] }).map((t) => t.name)).toEqual([
      "read", "write", "edit", "bash", "grep", "find",
    ]);
  });
});
