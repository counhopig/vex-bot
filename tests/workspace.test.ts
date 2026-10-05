import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WORKSPACE_TEMPLATES } from "../src/workspace/templates.js";
import { ensureWorkspace, listDailyNotes, readWorkspaceFile, residentLimitWarning } from "../src/workspace/workspace.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

let dir: string;
beforeEach(async () => { dir = await makeTmpDir(); });
afterEach(async () => { await removeTmpDir(dir); });

describe("ensureWorkspace", () => {
  it("creates directories and template files", async () => {
    const ws = join(dir, "ws");
    await ensureWorkspace(ws);
    expect((await stat(join(ws, "memory"))).isDirectory()).toBe(true);
    expect((await stat(join(ws, "skills"))).isDirectory()).toBe(true);
    for (const [name, content] of Object.entries(WORKSPACE_TEMPLATES)) {
      expect(await readFile(join(ws, name), "utf8")).toBe(content);
    }
    expect(await readFile(join(ws, "HEARTBEAT.md"), "utf8")).toBe("");
  });

  it("never overwrites existing files", async () => {
    await ensureWorkspace(dir);
    await writeFile(join(dir, "SOUL.md"), "my soul", "utf8");
    await ensureWorkspace(dir);
    expect(await readFile(join(dir, "SOUL.md"), "utf8")).toBe("my soul");
  });
});

describe("readWorkspaceFile", () => {
  it("returns an empty string for a missing file", async () => {
    expect(await readWorkspaceFile(dir, "nope.md")).toBe("");
  });
});

describe("listDailyNotes", () => {
  it("lists only dated notes, newest first", async () => {
    expect(await listDailyNotes(dir)).toEqual([]);
    await mkdir(join(dir, "memory", "2026-10-06.md"), { recursive: true });
    for (const name of ["2026-10-04.md", "2026-10-05.md", "draft.md", "2026-10-05.txt"]) await writeFile(join(dir, "memory", name), "x");
    expect(await listDailyNotes(dir)).toEqual(["memory/2026-10-06.md", "memory/2026-10-05.md", "memory/2026-10-04.md"]);
  });
});

describe("residentLimitWarning", () => {
  const lines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index}`).join("\n");

  it("warns when an always-loaded file is longer than the part the model sees", () => {
    expect(residentLimitWarning("SOUL.md", lines(201))).toBe("SOUL.md has 201 lines; only the first 200 reach the model. Shorten it to keep everything.");
    expect(residentLimitWarning("MEMORY.md", lines(101))).toContain("only the first 100");
  });

  it("stays quiet within the limit, for trailing blank lines and for other files", () => {
    expect(residentLimitWarning("SOUL.md", `${lines(200)}\n\n\n`)).toBeUndefined();
    expect(residentLimitWarning("USER.md", "")).toBeUndefined();
    expect(residentLimitWarning("HEARTBEAT.md", lines(500))).toBeUndefined();
  });
});
