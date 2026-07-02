/**
 * Plugin Loader
 *
 * Dynamically loads plugin modules and initializes them
 */

import { pathToFileURL } from "url";
import type {
  PluginCandidate,
  PluginModule,
  PluginDefinition,
  PluginEnableConfig,
  LoadedPlugin,
} from "./index.js";
import { registerPlugin, activatePlugin, getLoadedPlugins } from "./index.js";
import { discoverPlugins } from "./discovery.js";
import type { VexConfig } from "../types/index.js";
import type { MemoryManager } from "../memory/index.js";
import { getChildLogger } from "../utils/logger.js";

const logger = getChildLogger("plugins:loader");

/**
 * Resolve plugin enable state
 */
function resolveEnableState(
  candidate: PluginCandidate,
  enableConfig?: PluginEnableConfig
): { enabled: boolean; reason: string } {
  if (!enableConfig) {
    return { enabled: true, reason: "default" };
  }

  // Globally disabled
  if (enableConfig.enabled === false) {
    return { enabled: false, reason: "globally disabled" };
  }

  // Deny list
  if (enableConfig.deny?.includes(candidate.id)) {
    return { enabled: false, reason: "in deny list" };
  }

  // Allow list
  if (enableConfig.allow && enableConfig.allow.length > 0) {
    if (!enableConfig.allow.includes(candidate.id)) {
      return { enabled: false, reason: "not in allow list" };
    }
  }

  // Individual configuration
  const entry = enableConfig.entries?.[candidate.id];
  if (entry?.enabled === false) {
    return { enabled: false, reason: "explicitly disabled" };
  }
  if (entry?.enabled === true) {
    return { enabled: true, reason: "explicitly enabled" };
  }

  // Exclusive slot check
  if (candidate.manifest?.kind && enableConfig.slots) {
    const slotValue = enableConfig.slots[candidate.manifest.kind];
    if (slotValue && slotValue !== candidate.id) {
      return { enabled: false, reason: `slot "${candidate.manifest.kind}" assigned to "${slotValue}"` };
    }
  }

  // By default, enable non-bundled plugins; bundled plugins follow default rules
  if (candidate.origin === "bundled") {
    // Can add default enable list for bundled plugins
    return { enabled: true, reason: "bundled default" };
  }

  return { enabled: true, reason: "default" };
}

/**
 * Load a single plugin module
 */
async function loadPluginModule(candidate: PluginCandidate): Promise<PluginModule | null> {
  try {
    // Convert to file:// URL
    const fileUrl = pathToFileURL(candidate.entryPath).href;

    // Dynamic import
    const mod = await import(fileUrl);

    // Get default export
    const defaultExport = mod.default ?? mod;

    // Validate it is a valid plugin module
    if (typeof defaultExport === "function") {
      return defaultExport as PluginModule;
    }

    if (typeof defaultExport === "object" && defaultExport.meta) {
      return defaultExport as PluginDefinition;
    }

    logger.warn({ entryPath: candidate.entryPath }, "Invalid plugin module format");
    return null;
  } catch (error) {
    logger.error({ entryPath: candidate.entryPath, error }, "Failed to load plugin module");
    return null;
  }
}

/**
 * Convert module to definition
 */
function moduleToDefinition(
  mod: PluginModule,
  candidate: PluginCandidate
): PluginDefinition {
  if (typeof mod === "function") {
    return {
      meta: {
        id: candidate.id,
        name: candidate.manifest?.name || candidate.id,
        version: candidate.manifest?.version || "0.0.0",
        description: candidate.manifest?.description,
        author: candidate.manifest?.author,
        kind: candidate.manifest?.kind,
      },
      register: mod,
    };
  }

  return mod;
}

/**
 * Load all plugins
 */
export async function loadPlugins(
  config: VexConfig,
  enableConfig?: PluginEnableConfig,
  options?: { memoryManager?: MemoryManager },
): Promise<{
  loaded: string[];
  skipped: Array<{ id: string; reason: string }>;
  failed: Array<{ id: string; error: string }>;
}> {
  const result = {
    loaded: [] as string[],
    skipped: [] as Array<{ id: string; reason: string }>,
    failed: [] as Array<{ id: string; error: string }>,
  };

  // Discover plugins
  const candidates = await discoverPlugins({
    paths: enableConfig?.paths,
    includeBuiltin: true,
    includeGlobal: true,
    includeWorkspace: true,
  });

  logger.info({ count: candidates.length }, "Discovered plugins");

  // Sort by dependency order (simple implementation, supports only one level of dependencies)
  const sorted = sortByDependencies(candidates);

  for (const candidate of sorted) {
    // Check enable state
    const { enabled, reason } = resolveEnableState(candidate, enableConfig);
    if (!enabled) {
      result.skipped.push({ id: candidate.id, reason });
      logger.debug({ pluginId: candidate.id, reason }, "Plugin skipped");
      continue;
    }

    // Load module
    const mod = await loadPluginModule(candidate);
    if (!mod) {
      result.failed.push({ id: candidate.id, error: "Failed to load module" });
      continue;
    }

    // Convert to definition
    const definition = moduleToDefinition(mod, candidate);

    // Get plugin config
    const pluginConfig = enableConfig?.entries?.[candidate.id]?.config;

    // Register plugin
    try {
      await registerPlugin(definition, config, {
        origin: candidate.origin,
        pluginConfig,
        memoryManager: options?.memoryManager,
      });
      result.loaded.push(candidate.id);
    } catch (error) {
      result.failed.push({
        id: candidate.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logger.info({
    loaded: result.loaded.length,
    skipped: result.skipped.length,
    failed: result.failed.length,
  }, "Plugin loading completed");

  return result;
}

/**
 * Activate all loaded plugins
 */
export async function activateAllPlugins(): Promise<{
  activated: string[];
  failed: Array<{ id: string; error: string }>;
}> {
  const result = {
    activated: [] as string[],
    failed: [] as Array<{ id: string; error: string }>,
  };

  for (const meta of getLoadedPlugins()) {
    try {
      await activatePlugin(meta.id);
      result.activated.push(meta.id);
    } catch (error) {
      result.failed.push({
        id: meta.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

/**
 * Sort by dependency order
 */
function sortByDependencies(candidates: PluginCandidate[]): PluginCandidate[] {
  const sorted: PluginCandidate[] = [];
  const visited = new Set<string>();
  const idMap = new Map(candidates.map(c => [c.id, c]));

  function visit(candidate: PluginCandidate) {
    if (visited.has(candidate.id)) return;
    visited.add(candidate.id);

    // Process dependencies first
    const deps = candidate.manifest?.dependencies || [];
    for (const depId of deps) {
      const dep = idMap.get(depId);
      if (dep) {
        visit(dep);
      }
    }

    sorted.push(candidate);
  }

  for (const candidate of candidates) {
    visit(candidate);
  }

  return sorted;
}
