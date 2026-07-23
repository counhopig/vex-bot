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
