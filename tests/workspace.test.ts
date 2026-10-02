import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WORKSPACE_TEMPLATES } from "../src/workspace/templates.js";
import { ensureWorkspace, readWorkspaceFile } from "../src/workspace/workspace.js";
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
