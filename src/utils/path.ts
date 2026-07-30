/**
 * Path utilities — expandHomePath + isPathInside.
 *
 * Ported from _archive/src/utils/path.ts (17 LOC, no dependencies beyond
 * node:os and node:path). Other upcoming modules (channels/wechat/qr,
 * sessions/) will need these too, so porting now unblocks more than
 * just the skills module.
 */

import * as os from "os";
import * as path from "path";

/** Expand a leading ~/ or bare ~ to the current user's home directory. */
export function expandHomePath(inputPath: string): string {
  if (inputPath === "~") return os.homedir();
  if (inputPath.startsWith("~/") || inputPath.startsWith("~" + path.sep)) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

/** Return true when childPath resolves inside parentPath. */
export function isPathInside(parentPath: string, childPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}