/**
 * Plugin discovery — 3-tier filesystem scan.
 *
 * Sources (in priority order, later wins on collision):
 *   1. bundled — `<cwd>/plugins/`
 *   2. global — `~/.vex/plugins/`
 *   3. workspace — `<cwd>/.vex/plugins/`
 *   4. extra `paths` from PluginEnableConfig.paths
 *
 * For each candidate the loader needs:
 *   - an id (manifest.id, or package.json name, or directory name)
 *   - an absolute entry path (manifest.main, package.json main / vex.plugin,
 *     or a default `index.ts` / `index.js` / `plugin.ts` / `plugin.js`)
 *   - the parsed manifest (when present)
 *
 * `.ts` entries are only picked up when the runtime can import TypeScript
 * (tsx / vitest); in the compiled dist runtime, a `.ts` entry is logged
 * and skipped — see archive test "skips .ts entries when the runtime
 * cannot import TypeScript" for the contract.
 *
 * This module is class-free by design. It's a pure function pipeline
 * over the filesystem. The orchestrator (`service.ts`) owns the loaded
 * plugin map, so per-instance / per-owner isolation is the orchestrator's
 * concern, not the discoverer's.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { basename, join } from "path";
import { homedir } from "os";
import { getChildLogger } from "../utils/logger.js";
import type { PluginCandidate, PluginManifest, PluginOrigin } from "./types.js";

const logger = getChildLogger("plugins:discovery");

/** Standard manifest filename. */
export const MANIFEST_FILENAME = "vex.plugin.json";

/** Default 3-tier search directories. */
export function getDefaultSearchDirs(): Record<"bundled" | "global" | "workspace", string> {
  return {
    bundled: join(process.cwd(), "plugins"),
    global: join(homedir(), ".vex", "plugins"),
    workspace: join(process.cwd(), ".vex", "plugins"),
  };
}

/** Whether the current runtime can dynamically import .ts files. */
function runtimeCanImportTs(): boolean {
  return import.meta.url.endsWith(".ts");
}

/** Discover plugin candidates across all requested tiers. */
export async function discoverPlugins(options?: {
  paths?: string[];
  includeBuiltin?: boolean;
  includeGlobal?: boolean;
  includeWorkspace?: boolean;
  /** Override .ts entry support (defaults to runtime detection). */
  allowTsEntries?: boolean;
}): Promise<PluginCandidate[]> {
  const {
    paths = [],
    includeBuiltin = true,
    includeGlobal = true,
    includeWorkspace = true,
    allowTsEntries = runtimeCanImportTs(),
  } = options ?? {};

  const defaults = getDefaultSearchDirs();
  const searchDirs: Array<{ dir: string; origin: PluginOrigin }> = [];
  if (includeBuiltin && existsSync(defaults.bundled)) {
    searchDirs.push({ dir: defaults.bundled, origin: "bundled" });
  }
  if (includeGlobal && existsSync(defaults.global)) {
    searchDirs.push({ dir: defaults.global, origin: "global" });
  }
  if (includeWorkspace && existsSync(defaults.workspace)) {
    searchDirs.push({ dir: defaults.workspace, origin: "workspace" });
  }
  for (const p of paths) {
    if (existsSync(p)) searchDirs.push({ dir: p, origin: "config" });
  }

  const candidates: PluginCandidate[] = [];
  for (const { dir, origin } of searchDirs) {
    const found = await scanDirectory(dir, origin, allowTsEntries);
    for (const candidate of found) {
      // Later tiers override earlier ones for the same id. Linear scan
      // is fine here — discovery is O(N) over a small N.
      const existingIdx = candidates.findIndex((c) => c.id === candidate.id);
      if (existingIdx >= 0) candidates.splice(existingIdx, 1);
      candidates.push(candidate);
    }
  }

  logger.info({ count: candidates.length }, "Plugin discovery completed");
  return candidates;
}

/** Scan a single top-level directory. */
async function scanDirectory(
  dir: string,
  origin: PluginOrigin,
  allowTsEntries: boolean,
): Promise<PluginCandidate[]> {
  const out: PluginCandidate[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    logger.warn({ dir, error }, "Failed to scan plugin directory");
    return out;
  }
  for (const entry of entries) {
    const entryPath = join(dir, entry);
    let stat;
    try {
      stat = statSync(entryPath);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      const candidate = await scanPluginDirectory(entryPath, origin, allowTsEntries);
      if (candidate) out.push(candidate);
      continue;
    }
    if (entry.endsWith(".js") || (allowTsEntries && entry.endsWith(".ts"))) {
      const id = basename(entry, entry.endsWith(".ts") ? ".ts" : ".js");
      out.push({ id, origin, entryPath, directory: dir });
      continue;
    }
    if (entry.endsWith(".ts")) {
      logger.warn({ entryPath }, "Skipping .ts plugin: this runtime cannot import TypeScript");
    }
  }
  return out;
}

/** Inspect a plugin directory and return a candidate if one is recognizable. */
async function scanPluginDirectory(
  dir: string,
  origin: PluginOrigin,
  allowTsEntries: boolean,
): Promise<PluginCandidate | null> {
  const manifestPath = join(dir, MANIFEST_FILENAME);
  const packageJsonPath = join(dir, "package.json");
  let manifest: PluginManifest | undefined;
  let entryPath: string | undefined;
  let id = basename(dir);

  if (existsSync(manifestPath)) {
    try {
      const content = readFileSync(manifestPath, "utf-8");
      manifest = JSON.parse(content) as PluginManifest;
      id = manifest.id || id;
      if (manifest.main) entryPath = join(dir, manifest.main);
    } catch (error) {
      logger.warn({ manifestPath, error }, "Failed to parse plugin manifest");
    }
  }

  if (!entryPath && existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as Record<
        string,
        unknown
      >;
      if (typeof pkg["vex.plugin"] === "string") {
        entryPath = join(dir, pkg["vex.plugin"]);
      } else if (typeof pkg.main === "string") {
        entryPath = join(dir, pkg.main);
      }
      if (!manifest) {
        manifest = {
          id: typeof pkg.name === "string" ? pkg.name : id,
          name: typeof pkg.name === "string" ? pkg.name : undefined,
          version: typeof pkg.version === "string" ? pkg.version : undefined,
          description: typeof pkg.description === "string" ? pkg.description : undefined,
          author: typeof pkg.author === "string" ? pkg.author : undefined,
        };
        id = manifest.id;
      }
    } catch (error) {
      logger.warn({ packageJsonPath, error }, "Failed to parse package.json");
    }
  }

  if (!entryPath) {
    const candidates = allowTsEntries
      ? ["index.ts", "index.js", "plugin.ts", "plugin.js"]
      : ["index.js", "plugin.js"];
    for (const entry of candidates) {
      const candidate = join(dir, entry);
      if (existsSync(candidate)) {
        entryPath = candidate;
        break;
      }
    }
  }

  if (!entryPath) {
    logger.debug({ dir }, "No plugin entry found");
    return null;
  }

  if (entryPath.endsWith(".ts") && !allowTsEntries) {
    logger.warn(
      { dir, entryPath },
      "Skipping .ts plugin entry: this runtime cannot import TypeScript",
    );
    return null;
  }

  return {
    id,
    origin,
    manifestPath: existsSync(manifestPath) ? manifestPath : undefined,
    entryPath,
    directory: dir,
    manifest,
  };
}
