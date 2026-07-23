import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createReadFileTool, createWriteFileTool } from "../src/tools/builtin/filesystem.js";

describe("tools/builtin/filesystem", () => {
  const dirs: string[] = [];
  function sandbox(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "vex-fs-")));
    dirs.push(dir);
    return dir;
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("resolves a relative path against the sandbox, not process.cwd()", async () => {
    const dir = sandbox();
    const write = createWriteFileTool({ allowedPaths: [dir] });

    // A relative path must land inside the allowed sandbox — previously it
    // resolved against process.cwd() and was denied for a scoped per-user dir.
    const result = await write.execute("w", { path: "note.txt", content: "hi" }, undefined);

    expect(result.isError).toBeFalsy();
    expect(existsSync(join(dir, "note.txt"))).toBe(true);
    expect(existsSync(join(process.cwd(), "note.txt"))).toBe(false);
  });

  it("reads back a relative path from the sandbox", async () => {
    const dir = sandbox();
    const write = createWriteFileTool({ allowedPaths: [dir] });
    const read = createReadFileTool({ allowedPaths: [dir] });

    await write.execute("w", { path: "data.txt", content: "content-here" }, undefined);
    const result = await read.execute("r", { path: "data.txt" }, undefined);

    expect(result.isError).toBeFalsy();
    expect(result.content.map((c) => c.text ?? "").join("")).toContain("content-here");
  });
});
