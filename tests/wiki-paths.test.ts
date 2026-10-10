import { existsSync } from "node:fs";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveInSubtree, validateSubtreeRoots } from "../src/vault/wiki/paths.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

let dir: string;
beforeEach(async () => {
  dir = await makeTmpDir();
});
afterEach(async () => {
  await removeTmpDir(dir);
});

describe("validateSubtreeRoots", () => {
  it("creates the wiki and raw subtrees and returns their absolute paths", async () => {
    const vault = join(dir, "vault");
    const roots = await validateSubtreeRoots(vault);
    expect(roots).toEqual({ wiki: join(vault, "wiki"), raw: join(vault, "raw") });
    const { wiki, raw } = await validateSubtreeRoots(vault);
    expect(wiki).toBe(join(vault, "wiki"));
    expect(raw).toBe(join(vault, "raw"));
  });

  it("rejects a symlinked wiki root", async () => {
    const vault = join(dir, "vault");
    await mkdir(vault, { recursive: true });
    await mkdir(join(dir, "owner-notes"), { recursive: true });
    await symlink("../owner-notes", join(vault, "wiki"));
    await expect(validateSubtreeRoots(vault)).rejects.toThrow("wiki root is not a real directory");
  });

  it("rejects a root redirected after initialization before resolving a write", async () => {
    const vault = join(dir, "vault");
    const roots = await validateSubtreeRoots(vault);
    await mkdir(join(dir, "owner-notes"), { recursive: true });
    await rm(roots.wiki, { recursive: true });
    await symlink(join(dir, "owner-notes"), roots.wiki);
    await expect(resolveInSubtree(roots.wiki, "new.md")).rejects.toThrow();
    expect(existsSync(join(dir, "owner-notes", "new.md"))).toBe(false);
  });
});

describe("resolveInSubtree", () => {
  it("resolves a normal markdown path under the root", async () => {
    const { wiki } = await validateSubtreeRoots(join(dir, "vault"));
    await writeFile(join(wiki, "a.md"), "# a");
    await expect(resolveInSubtree(wiki, "a.md")).resolves.toBe(join(wiki, "a.md"));
  });

  it("resolves a new nested markdown path under the root", async () => {
    const { wiki } = await validateSubtreeRoots(join(dir, "vault"));
    await expect(resolveInSubtree(wiki, "sub/new.md")).resolves.toBe(join(wiki, "sub", "new.md"));
  });

  it("rejects a file symlink escaping the subtree", async () => {
    const vault = join(dir, "vault");
    const { wiki } = await validateSubtreeRoots(vault);
    await writeFile(join(vault, "owner.md"), "# owner");
    await symlink("../owner.md", join(wiki, "alias.md"));
    await expect(resolveInSubtree(wiki, "alias.md")).rejects.toThrow("wiki path escapes its subtree");
  });

  it("rejects a dangling symlink", async () => {
    const { wiki } = await validateSubtreeRoots(join(dir, "vault"));
    await symlink("../missing.md", join(wiki, "x.md"));
    await expect(resolveInSubtree(wiki, "x.md")).rejects.toThrow();
  });

  it("rejects .. and absolute paths", async () => {
    const { wiki } = await validateSubtreeRoots(join(dir, "vault"));
    await expect(resolveInSubtree(wiki, "../oops.md")).rejects.toThrow("wiki path must not contain '..'");
    await expect(resolveInSubtree(wiki, join(dir, "oops.md"))).rejects.toThrow("wiki path must be relative");
  });

  it("rejects hidden components and non-markdown paths", async () => {
    const { wiki } = await validateSubtreeRoots(join(dir, "vault"));
    await expect(resolveInSubtree(wiki, ".secret.md")).rejects.toThrow("hidden");
    await expect(resolveInSubtree(wiki, "sub/.secret.md")).rejects.toThrow("hidden");
    await expect(resolveInSubtree(wiki, "notes.txt")).rejects.toThrow(".md");
  });
});
