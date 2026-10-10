import { chmod, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEditTool, createReadTool, createWriteTool } from "../src/tools/fs.js";
import { displayPath, isInside, resolveToolPath } from "../src/tools/paths.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

let ws: string;
beforeEach(async () => { ws = await makeTmpDir(); });
afterEach(async () => { await removeTmpDir(ws); });

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((c) => c.text ?? "").join("");
}

describe("tool paths", () => {
  it("resolves relative paths against the workspace", () => {
    expect(resolveToolPath("/ws", "notes/a.md")).toBe("/ws/notes/a.md");
    expect(resolveToolPath("/ws", "/etc/hosts")).toBe("/etc/hosts");
    expect(resolveToolPath("/ws", "~/x")).toBe(join(homedir(), "x"));
  });

  it("detects containment without being fooled by look-alike names", () => {
    expect(isInside("/ws", "/ws")).toBe(true);
    expect(isInside("/ws", "/ws/a/b")).toBe(true);
    expect(isInside("/ws", "/ws/../etc")).toBe(false);
    expect(isInside("/ws", "/ws2/a")).toBe(false);
    expect(isInside("/ws", "/ws/..hidden")).toBe(true);
  });

  it("shows workspace paths relatively", () => {
    expect(displayPath("/ws", "/ws/a/b.md")).toBe("a/b.md");
    expect(displayPath("/ws", "/etc/hosts")).toBe("/etc/hosts");
  });
});

describe("read", () => {
  it("returns numbered lines", async () => {
    await writeFile(join(ws, "a.txt"), "one\ntwo\nthree", "utf8");
    const result = await createReadTool(ws).execute("1", { path: "a.txt" });
    expect(textOf(result)).toBe("1\tone\n2\ttwo\n3\tthree");
  });

  it("supports offset and limit and says how to continue", async () => {
    await writeFile(join(ws, "a.txt"), "1\n2\n3\n4\n5", "utf8");
    const result = await createReadTool(ws).execute("1", { path: "a.txt", offset: 2, limit: 2 });
    expect(textOf(result)).toBe("2\t2\n3\t3\n… (5 lines in total; use offset to continue reading)");
  });

  it("throws for a missing file", async () => {
    await expect(createReadTool(ws).execute("1", { path: "nope.txt" })).rejects.toThrow();
  });
});

describe("write", () => {
  it("creates parent directories", async () => {
    const result = await createWriteTool(ws).execute("1", { path: "memory/2026-10-02.md", content: "note" });
    expect(await readFile(join(ws, "memory/2026-10-02.md"), "utf8")).toBe("note");
    expect(textOf(result)).toBe("Wrote memory/2026-10-02.md (4 bytes)");
  });

  it("replaces the file atomically, keeping its permissions and writing through a symlink", async () => {
    await writeFile(join(ws, "real.md"), "old", "utf8");
    await chmod(join(ws, "real.md"), 0o600);
    await symlink(join(ws, "real.md"), join(ws, "link.md"));
    await createWriteTool(ws).execute("1", { path: "link.md", content: "new" });
    expect(await readFile(join(ws, "real.md"), "utf8")).toBe("new");
    expect((await stat(join(ws, "real.md"))).mode & 0o777).toBe(0o600);
    expect(await readdir(ws)).toEqual(expect.not.arrayContaining([expect.stringMatching(/\.tmp$/)]));
  });
});

describe("edit", () => {
  beforeEach(async () => { await writeFile(join(ws, "f.md"), "a b a $1", "utf8"); });

  it("replaces a unique occurrence literally", async () => {
    const result = await createEditTool(ws).execute("1", { path: "f.md", oldText: "b", newText: "$&c" });
    expect(await readFile(join(ws, "f.md"), "utf8")).toBe("a $&c a $1");
    expect(textOf(result)).toBe("Edited f.md (1 replacement(s))");
  });

  it("refuses an ambiguous match unless replaceAll is set", async () => {
    await expect(createEditTool(ws).execute("1", { path: "f.md", oldText: "a", newText: "x" })).rejects.toThrow(/occurs 2 times/);
    await createEditTool(ws).execute("1", { path: "f.md", oldText: "a", newText: "x", replaceAll: true });
    expect(await readFile(join(ws, "f.md"), "utf8")).toBe("x b x $1");
  });

  it("keeps every change when edits to one file run concurrently", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `<line ${i}>`);
    await writeFile(join(ws, "f.md"), lines.join("\n"), "utf8");
    const edit = createEditTool(ws);
    await Promise.all(lines.map((line) => edit.execute("1", { path: "f.md", oldText: line, newText: `${line} done` })));
    // Concurrent edits through a symlink share the same lock as the real path.
    await symlink(join(ws, "f.md"), join(ws, "alias.md"));
    await Promise.all([
      edit.execute("2", { path: "alias.md", oldText: "<line 0> done", newText: "first" }),
      edit.execute("3", { path: "f.md", oldText: "<line 19> done", newText: "last" }),
    ]);
    const text = await readFile(join(ws, "f.md"), "utf8");
    expect(text.split("\n")).toEqual(["first", ...lines.slice(1, 19).map((line) => `${line} done`), "last"]);
  });

  it("fails when the text is absent or empty", async () => {
    await expect(createEditTool(ws).execute("1", { path: "f.md", oldText: "zzz", newText: "x" })).rejects.toThrow(/was not found/);
    await expect(createEditTool(ws).execute("1", { path: "f.md", oldText: "", newText: "x" })).rejects.toThrow(/must not be empty/);
  });
});
