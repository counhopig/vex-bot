/**
 * Filesystem tool tests — path traversal protection.
 */

import { describe, it, expect, vi } from "vitest";
import { resolve } from "path";
import { mkdtempSync, writeFileSync, readFileSync, unlinkSync, rmdirSync } from "fs";
import { tmpdir } from "os";

describe("resolveUserPath", () => {
  let resolveUserPath: (allowed: string[], p: string) => string;

  beforeAll(async () => {
    ({ resolveUserPath } = await import("../src/tools/builtin/filesystem.js"));
  });

  it("resolves relative paths against first allowed path", () => {
    expect(resolveUserPath(["/sandbox"], "file.txt")).toBe("/sandbox/file.txt");
  });

  it("leaves absolute paths intact", () => {
    expect(resolveUserPath(["/sandbox"], "/etc/passwd")).toBe("/etc/passwd");
  });
});

describe("isRealPathAllowed", () => {
  let isRealPathAllowed: (p: string, allowed: string[]) => Promise<boolean>;

  beforeAll(async () => {
    ({ isRealPathAllowed } = await import("../src/tools/builtin/filesystem.js"));
  });

  it("allows path inside allowed directory", async () => {
    const dir = mkdtempSync(`${tmpdir()}/vex-fs-test-`);
    try {
      const f = resolve(dir, "test.txt");
      writeFileSync(f, "hello");
      expect(await isRealPathAllowed(f, [dir])).toBe(true);
    } finally {
      rmdirSync(dir, { recursive: true });
    }
  });

  it("rejects path outside allowed directory", async () => {
    const dir = mkdtempSync(`${tmpdir()}/vex-fs-test-`);
    try {
      const outside = resolve(dir, "../../etc/passwd");
      expect(await isRealPathAllowed(outside, [dir])).toBe(false);
    } finally {
      rmdirSync(dir, { recursive: true });
    }
  });
});

describe("filesystem tools metadata", () => {
  it("creates read_file tool", async () => {
    const { createReadFileTool } = await import(
      "../src/tools/builtin/filesystem.js"
    );
    const t = createReadFileTool();
    expect(t.name).toBe("read_file");
  });

  it("creates write_file tool", async () => {
    const { createWriteFileTool } = await import(
      "../src/tools/builtin/filesystem.js"
    );
    const t = createWriteFileTool();
    expect(t.name).toBe("write_file");
  });

  it("creates edit_file tool", async () => {
    const { createEditFileTool } = await import(
      "../src/tools/builtin/filesystem.js"
    );
    const t = createEditFileTool();
    expect(t.name).toBe("edit_file");
  });

  it("createFilesystemTools returns 6 tools", async () => {
    const { createFilesystemTools } = await import(
      "../src/tools/builtin/filesystem.js"
    );
    const tools = createFilesystemTools();
    expect(tools).toHaveLength(6);
    const names = tools.map((t: any) => t.name);
    expect(names).toContain("read_file");
    expect(names).toContain("write_file");
    expect(names).toContain("edit_file");
    expect(names).toContain("list_directory");
    expect(names).toContain("glob");
    expect(names).toContain("grep");
  });
});
