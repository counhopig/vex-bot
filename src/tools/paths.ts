import { isAbsolute, relative, resolve, sep } from "node:path";
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
