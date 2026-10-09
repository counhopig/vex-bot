import { mkdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Vault } from "../src/vault/notes.js";
import { commit, makeRemote } from "./helpers/gitRemote.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

let dir: string;
let notes: string;
beforeEach(async () => {
  dir = await makeTmpDir();
  notes = join(dir, "notes");
  await mkdir(notes);
});
afterEach(async () => { await removeTmpDir(dir); });

const day = (month: number, date: number): Date => new Date(2026, month - 1, date, 12);

async function put(rel: string, text: string, when?: Date): Promise<void> {
  const abs = join(notes, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, text);
  if (when) await utimes(abs, when, when);
}

async function sample(): Promise<void> {
  await put("Projects/Vex.md", "---\ntags: [project/vex, ai]\naliases: [Vex Bot]\n---\n# Vex\nA personal assistant. See [[Ideas]] and [[Reading list]].\n", day(9, 20));
  await put("Ideas.md", "# Ideas\nTry a #weekly review. Link to [[Vex]].\n机器学习笔记：先看线性代数。\n", day(10, 1));
  await put("Reading list.md", "# Reading\nTags: #books\nDeep work notes\n", day(9, 25));
  await put("Daily/2026-10-05.md", "Met Alice about the vex roadmap.\n", day(10, 5));
  await put(".obsidian/workspace.md", "hidden vex", day(10, 5));
  await put("Attachments/photo.png", "vex image", day(10, 5));
}

const vault = (extra: Partial<ConstructorParameters<typeof Vault>[0]> = {}): Vault => new Vault({ home: join(dir, "home"), config: { path: notes }, ...extra });
const paths = (out: { results: { path: string }[] }): string[] => out.results.map((r) => r.path);

describe("Vault.search", () => {
  it("ranks notes by how many keywords they contain, then by where they match", async () => {
    await sample();
    const out = await vault().search({ query: "vex" });
    expect(paths(out)).toEqual(["Projects/Vex.md", "Daily/2026-10-05.md", "Ideas.md"]);
    expect(out.total).toBe(3);
    expect(out.source).toBe(`folder ${notes}`);
    expect(paths(await vault().search({ query: "vex roadmap" }))[0]).toBe("Daily/2026-10-05.md");
    expect((await vault().search({ query: "hidden" })).total).toBe(0);
    expect((await vault().search({ query: "image" })).total).toBe(0);
  });

  it("returns only the best match's snippet when the limit is reached", async () => {
    await sample();
    const out = await vault().search({ query: "vex", limit: 1 });
    expect(out.total).toBe(3);
    expect(paths(out)).toEqual(["Projects/Vex.md"]);
    expect(out.results[0]!.snippet).toContain("A personal assistant");
  });

  it("matches Chinese by substring and shows the matching text", async () => {
    await sample();
    const out = await vault().search({ query: "线性代数" });
    expect(paths(out)).toEqual(["Ideas.md"]);
    expect(out.results[0]!.snippet).toContain("线性代数");
  });

  it("filters by tag, folder and date, and lists newest first without a query", async () => {
    await sample();
    const v = vault();
    expect(paths(await v.search({ tag: "project" }))).toEqual(["Projects/Vex.md"]);
    expect(paths(await v.search({ tag: "#AI" }))).toEqual(["Projects/Vex.md"]);
    expect(paths(await v.search({ tag: "weekly" }))).toEqual(["Ideas.md"]);
    expect(paths(await v.search({ tag: "books" }))).toEqual(["Reading list.md"]);
    expect(paths(await v.search({ folder: "projects/" }))).toEqual(["Projects/Vex.md"]);
    expect(paths(await v.search({}))).toEqual(["Daily/2026-10-05.md", "Ideas.md", "Reading list.md", "Projects/Vex.md"]);
    expect(paths(await v.search({ since: "2026-10-01" }))).toEqual(["Daily/2026-10-05.md", "Ideas.md"]);
    expect(paths(await v.search({ before: "2026-09-26" }))).toEqual(["Reading list.md", "Projects/Vex.md"]);
    const limited = await v.search({ limit: 1 });
    expect(limited.results).toHaveLength(1);
    expect(limited.total).toBe(4);
    expect(limited.results[0]).toMatchObject({ title: "2026-10-05", changed: day(10, 5).toISOString(), snippet: "Met Alice about the vex roadmap." });
    await expect(v.search({ since: "last week" })).rejects.toThrow(/Invalid date/);
  });

  it("notices edits and deletions between calls", async () => {
    await sample();
    const v = vault();
    expect((await v.search({ query: "zebra" })).total).toBe(0);
    await put("Ideas.md", "# Ideas\nzebra crossing\n", day(10, 6));
    expect(paths(await v.search({ query: "zebra" }))).toEqual(["Ideas.md"]);
    await rm(join(notes, "Ideas.md"));
    expect((await v.search({ query: "zebra" })).total).toBe(0);
  });

  it("skips oversized notes and honours the note limit", async () => {
    await sample();
    await put("big.md", "needle ".repeat(200_000));
    expect((await vault().search({ query: "needle" })).total).toBe(0);
    const capped = await vault({ maxNotes: 2 }).search({});
    expect(capped.total).toBe(2);
    expect(capped.source).toContain("only the first 2");
  });

  it("explains a missing folder", async () => {
    await expect(vault({ config: { path: join(dir, "nope") } }).search({})).rejects.toThrow(/does not exist or cannot be read/);
  });
});

describe("Vault.read", () => {
  it("returns the note with its tags, links and backlinks", async () => {
    await sample();
    const note = await vault().read("Projects/Vex.md");
    expect(note).toMatchObject({ path: "Projects/Vex.md", title: "Vex", tags: ["project/vex", "ai"], backlinks: ["Ideas.md"], changed: day(9, 20).toISOString() });
    expect(note.outLinks).toEqual([{ target: "Ideas", path: "Ideas.md" }, { target: "Reading list", path: "Reading list.md" }]);
    expect(note.text).toContain("A personal assistant");
    const other = await vault().read("ideas.md");
    expect(other).toMatchObject({ path: "Ideas.md", backlinks: ["Projects/Vex.md"] });
  });

  it("truncates very long notes", async () => {
    await put("Long.md", "x".repeat(40_000));
    const note = await vault().read("Long.md");
    expect(note.text.length).toBeLessThan(30_200);
    expect(note.text).toContain("truncated; 40000 characters in total");
  });

  it("refuses paths outside the vault and anything that is not a visible note", async () => {
    await sample();
    const outside = join(dir, "outside.md");
    await writeFile(outside, "secret");
    await symlink(outside, join(notes, "link.md"));
    const outsideDir = join(dir, "outside-dir");
    await mkdir(outsideDir);
    await writeFile(join(outsideDir, "x.md"), "secret");
    await symlink(outsideDir, join(notes, "linked"));
    const v = vault();
    for (const path of ["../outside.md", "/etc/passwd", ".obsidian/workspace.md", "Attachments/photo.png", "missing.md", "link.md", "linked/x.md", "", "Daily/../../outside.md"]) {
      await expect(v.read(path)).rejects.toThrow(/Note paths are relative|Note not found/);
    }
    expect((await v.search({ query: "secret" })).total).toBe(0);
  });
});

describe("Vault with a git repository", () => {
  it("searches the mirrored copy and dates notes by commit time", async () => {
    const src = join(dir, "src");
    await mkdir(src);
    const { remote, work } = makeRemote(src);
    commit(work, { "Old.md": "alpha topic" }, "2026-09-01T10:00:00+0000");
    commit(work, { "New.md": "alpha topic again" }, "2026-10-01T10:00:00+0000");
    const v = new Vault({ home: join(dir, "home"), config: { url: remote }, protocols: "file" });
    const out = await v.search({ query: "alpha" });
    expect(out.source).toMatch(/^git copy synced /);
    expect(out.results.map((r) => [r.path, r.changed])).toEqual([["New.md", "2026-10-01T10:00:00.000Z"], ["Old.md", "2026-09-01T10:00:00.000Z"]]);
    expect((await v.read("New.md")).changed).toBe("2026-10-01T10:00:00.000Z");
  });

  it("fails clearly when the repository cannot be fetched", async () => {
    const v = new Vault({ home: join(dir, "home"), config: { url: join(dir, "missing.git") }, protocols: "file" });
    await expect(v.search({ query: "x" })).rejects.toThrow(/The notes vault could not be fetched: .*fatal/);
  });
});
