import { lstatSync, realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { isInside } from "../tools/paths.js";

export async function validateSubtreeRoots(vaultRoot: string): Promise<{ wiki: string; raw: string }> {
  try {
    if (lstatSync(vaultRoot).isSymbolicLink()) throw new Error("vault root is not a real directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(vaultRoot, { recursive: true });
  assertRealRoot(vaultRoot, "vault");
  const wiki = resolve(vaultRoot, "wiki");
  const raw = resolve(vaultRoot, "raw");
  validateSubtreeRoot(wiki);
  validateSubtreeRoot(raw);
  await mkdir(wiki, { recursive: true });
  await mkdir(raw, { recursive: true });
  assertRealRoot(wiki, "wiki");
  assertRealRoot(raw, "raw");
  return { wiki, raw };
}

/** Recheck a previously initialized operation root before every filesystem mutation. */
export function validateSubtreeRoot(root: string): void {
  let current = root;
  for (;;) {
    try {
      const info = lstatSync(current);
      if (info.isSymbolicLink() || realpathSync(current) !== current) throw new Error(`${basename(root)} root is not a real directory`);
      if (current === root && !info.isDirectory()) throw new Error(`${basename(root)} root is not a real directory`);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

/** A symlinked root (e.g. `wiki -> ../owner-notes`) would let every write leave the vault subtree. */
function assertRealRoot(root: string, name: string): void {
  const info = lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(root) !== root) throw new Error(`${name} root is not a real directory`);
}

export async function resolveInSubtree(root: string, path: string): Promise<string> {
  validateSubtreeRoot(root);
  if (path === "") throw new Error("wiki path must not be empty");
  if (isAbsolute(path)) throw new Error("wiki path must be relative");
  for (const component of path.split("/")) {
    if (component === "") throw new Error("wiki path must not contain empty components");
    if (component === "..") throw new Error("wiki path must not contain '..'");
    if (component.startsWith(".")) throw new Error("wiki path must not contain hidden components");
  }
  if (!path.endsWith(".md")) throw new Error("wiki path must end in .md");
  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, path);
  if (!isInside(resolvedRoot, target)) throw new Error("wiki path escapes its subtree");
  const realTarget = resolveRealPath(target);
  if (!isInside(resolvedRoot, realTarget)) throw new Error("wiki path escapes its subtree");
  return realTarget;
}

/** Realpath of the nearest existing ancestor with the missing tail reattached; a dangling symlink is an error, not a new path. */
function resolveRealPath(path: string): string {
  const remaining: string[] = [];
  let ancestor = path;
  for (;;) {
    try {
      return join(realpathSync(ancestor), ...remaining);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      let exists = false;
      try {
        lstatSync(ancestor);
        exists = true;
      } catch (statErr) {
        if ((statErr as NodeJS.ErrnoException).code !== "ENOENT") throw statErr;
      }
      if (exists) throw err;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw err;
      remaining.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}
