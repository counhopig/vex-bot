/**
 * Plugin Discovery
 *
 * Scans the filesystem for plugin candidates
 */

import { existsSync, readdirSync, statSync, readFileSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";
import json5 from "json5";
import type { PluginCandidate, PluginOrigin, PluginManifest } from "./index.js";
import { getChildLogger } from "../utils/logger.js";

const logger = getChildLogger("plugins:discovery");

/** Plugin manifest filename */
const MANIFEST_FILENAME = "vex.plugin.json";

/** Default plugin search directories */
const DEFAULT_SEARCH_DIRS = {
  bundled: join(process.cwd(), "plugins"),
  global: join(homedir(), ".vex", "plugins"),
  workspace: join(process.cwd(), ".vex", "plugins"),
};

/**
 * Discover plugin candidates
 */
export async function discoverPlugins(options?: {
  paths?: string[];
  includeBuiltin?: boolean;
  includeGlobal?: boolean;
  includeWorkspace?: boolean;
}): Promise<PluginCandidate[]> {
  const {
    paths = [],
    includeBuiltin = true,
    includeGlobal = true,
    includeWorkspace = true,
  } = options || {};

  const candidates: PluginCandidate[] = [];
  const seenIds = new Set<string>();

  // Search in priority order (later entries override earlier ones)
  const searchDirs: Array<{ dir: string; origin: PluginOrigin }> = [];

  if (includeBuiltin && existsSync(DEFAULT_SEARCH_DIRS.bundled)) {
    searchDirs.push({ dir: DEFAULT_SEARCH_DIRS.bundled, origin: "bundled" });
  }
  if (includeGlobal && existsSync(DEFAULT_SEARCH_DIRS.global)) {
    searchDirs.push({ dir: DEFAULT_SEARCH_DIRS.global, origin: "global" });
  }
  if (includeWorkspace && existsSync(DEFAULT_SEARCH_DIRS.workspace)) {
    searchDirs.push({ dir: DEFAULT_SEARCH_DIRS.workspace, origin: "workspace" });
  }

  // Additional paths
  for (const p of paths) {
    if (existsSync(p)) {
      searchDirs.push({ dir: p, origin: "config" });
    }
  }

  for (const { dir, origin } of searchDirs) {
    const found = await scanDirectory(dir, origin);
    for (const candidate of found) {
      // For plugins with the same ID, later entries override earlier ones
      if (seenIds.has(candidate.id)) {
        const existing = candidates.find(c => c.id === candidate.id);
        if (existing) {
          candidates.splice(candidates.indexOf(existing), 1);
        }
      }
      candidates.push(candidate);
      seenIds.add(candidate.id);
    }
  }

  logger.info({ count: candidates.length }, "Plugin discovery completed");
  return candidates;
}

/**
 * Scan a directory for plugins
 */
async function scanDirectory(dir: string, origin: PluginOrigin): Promise<PluginCandidate[]> {
  const candidates: PluginCandidate[] = [];

  try {
    const entries = readdirSync(dir);

    for (const entry of entries) {
      const entryPath = join(dir, entry);
      const stat = statSync(entryPath);

      if (stat.isDirectory()) {
        const candidate = await scanPluginDirectory(entryPath, origin);
        if (candidate) {
          candidates.push(candidate);
        }
      } else if (entry.endsWith(".js") || entry.endsWith(".ts")) {
        // Single-file plugin
        const id = basename(entry, entry.endsWith(".ts") ? ".ts" : ".js");
        candidates.push({
          id,
          origin,
          entryPath,
          directory: dir,
        });
      }
    }
  } catch (error) {
    logger.warn({ dir, error }, "Failed to scan plugin directory");
  }

  return candidates;
}

/**
 * Scan a single plugin directory
 */
async function scanPluginDirectory(dir: string, origin: PluginOrigin): Promise<PluginCandidate | null> {
  const manifestPath = join(dir, MANIFEST_FILENAME);
  const packageJsonPath = join(dir, "package.json");

  let manifest: PluginManifest | undefined;
  let entryPath: string | undefined;
  let id = basename(dir);

  // 1. Try to read vex.plugin.json
  if (existsSync(manifestPath)) {
    try {
      const content = readFileSync(manifestPath, "utf-8");
      manifest = json5.parse(content) as PluginManifest;
      id = manifest.id || id;
      if (manifest.main) {
        entryPath = join(dir, manifest.main);
      }
    } catch (error) {
      logger.warn({ manifestPath, error }, "Failed to parse plugin manifest");
    }
  }

  // 2. Try to read package.json
  if (!entryPath && existsSync(packageJsonPath)) {
    try {
      const content = readFileSync(packageJsonPath, "utf-8");
      const pkg = JSON.parse(content);

      // Check for vex.plugin field
      if (pkg["vex.plugin"]) {
        entryPath = join(dir, pkg["vex.plugin"]);
      } else if (pkg.main) {
        entryPath = join(dir, pkg.main);
      }

      // Fill in manifest info from package.json
      if (!manifest) {
        manifest = {
          id: pkg.name || id,
          name: pkg.name,
          version: pkg.version,
          description: pkg.description,
          author: pkg.author,
        };
        id = manifest.id;
      }
    } catch (error) {
      logger.warn({ packageJsonPath, error }, "Failed to parse package.json");
    }
  }

  // 3. Look for default entry file
  if (!entryPath) {
    const defaultEntries = ["index.ts", "index.js", "plugin.ts", "plugin.js"];
    for (const entry of defaultEntries) {
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

  return {
    id,
    origin,
    manifestPath: existsSync(manifestPath) ? manifestPath : undefined,
    entryPath,
    directory: dir,
    manifest,
  };
}

/**
 * Get default search directories
 */
export function getDefaultSearchDirs(): Record<string, string> {
  return { ...DEFAULT_SEARCH_DIRS };
}
