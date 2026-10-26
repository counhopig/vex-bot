import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { expandHome } from "../paths.js";

export function resolveToolPath(workspace: string, p: string): string {
  return resolve(workspace, expandHome(p));
}

export function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function displayPath(workspace: string, abs: string): string {
  return isInside(workspace, abs) ? relative(workspace, abs) || "." : abs;
}

/** Realpath of the nearest existing ancestor with the missing tail reattached; a dangling symlink is an error, not a new path. */
export function resolveRealPath(path: string): string {
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
