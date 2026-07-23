import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, symlinkSync, mkdirSync, readFileSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createApplyPatchTool } from "../src/tools/builtin/apply-patch.js";

describe("tools/builtin/apply-patch", () => {
  const dirs: string[] = [];
  function sandbox(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "vex-patch-")));
    dirs.push(dir);
    return dir;
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("resolves a relative new-file patch against the sandbox, not process.cwd()", async () => {
    const dir = sandbox();
    const tool = createApplyPatchTool([dir]);
    const patch = ["--- /dev/null", "+++ b/note.txt", "@@ -0,0 +1,1 @@", "+hello"].join("\n");

    const result = await tool.execute("p", { patch }, undefined);

    expect(result.isError).toBeFalsy();
    expect(existsSync(join(dir, "note.txt"))).toBe(true);
    expect(existsSync(join(process.cwd(), "note.txt"))).toBe(false);
    expect(readFileSync(join(dir, "note.txt"), "utf-8")).toBe("hello");
  });

  it("applies a relative edit patch to a file inside the sandbox", async () => {
    const dir = sandbox();
    writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n");
    const tool = createApplyPatchTool([dir]);
    const patch = ["--- a/a.txt", "+++ b/a.txt", "@@ -1,3 +1,3 @@", " one", "-two", "+TWO", " three"].join("\n");

    const result = await tool.execute("p", { patch }, undefined);

    expect(result.isError).toBeFalsy();
    expect(readFileSync(join(dir, "a.txt"), "utf-8")).toBe("one\nTWO\nthree\n");
  });

  it("rejects a patch whose real path escapes the sandbox via a symlink", async () => {
    const dir = sandbox();
    const outside = sandbox();
    writeFileSync(join(outside, "secret.txt"), "original\n");
    // A symlink inside the sandbox pointing at a file outside it.
    symlinkSync(join(outside, "secret.txt"), join(dir, "link.txt"));
    const tool = createApplyPatchTool([dir]);
    const patch = ["--- a/link.txt", "+++ b/link.txt", "@@ -1,1 +1,1 @@", "-original", "+pwned"].join("\n");

    const result = await tool.execute("p", { patch }, undefined);

    expect(result.isError).toBeTruthy();
    expect(readFileSync(join(outside, "secret.txt"), "utf-8")).toBe("original\n");
  });
});
