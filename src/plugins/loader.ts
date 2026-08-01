/**
 * Plugin loader — module import, enable-state resolution, dependency sort,
 * and the register/activate pipeline.
 *
 * Class-free by design. The orchestrator (`service.ts`) owns the
 * `registry` Map and the `deps` (ToolRegistry, EventBus, etc.) and passes
 * them in. This module never reads or writes module-level state, so
 * the same loader can serve two different (user, channel) plugin
 * runtimes in one process.
 *
 * Safety contract (preserved from archive):
 *  - resolveEnableState runs through (in order) global `enabled`,
 *    `deny`, `allow`, per-entry `enabled`, exclusive-slot check, then
 *    origin-default. The per-entry `enabled: true` is checked BEFORE
 *    the slot check so an operator can force a specific plugin on
 *    without touching slot assignment.
 *  - sortByDependencies does a recursive topological pass; cycles are
 *    guarded by the visited Set.
 *  - loadPluginModule never throws — invalid modules become `null` so
 *    a single bad plugin doesn't break the whole boot.
 */

import { pathToFileURL } from "url";
import { getChildLogger } from "../utils/logger.js";
import type {
  LoadedPlugin,
  PluginApi,
  PluginCandidate,
  PluginDefinition,
  PluginEnableConfig,
  PluginModule,
  PluginRuntimeDeps,
  PluginServiceTask,
} from "./types.js";

const logger = getChildLogger("plugins:loader");

/** Result of loadPlugins: per-plugin outcomes. */
export interface LoadResult {
  loaded: string[];
  skipped: Array<{ id: string; reason: string }>;
  failed: Array<{ id: string; error: string }>;
}

/** Result of activateAllPlugins. */
export interface ActivateResult {
  activated: string[];
  failed: Array<{ id: string; error: string }>;
}

// ---------------------------------------------------------------------------
// Enable-state resolution (pure function)
// ---------------------------------------------------------------------------

/**
 * Decide whether a candidate is enabled. The decision is deterministic
 * and explainable: each rule produces a reason string so the loader can
 * report why a plugin was skipped.
 *
 * Order (deliberate — do not reorder without re-reading the test set):
 *   1. global `enabled: false` → globally disabled
 *   2. `deny` hit → in deny list
 *   3. `allow` set + non-empty + no match → not in allow list
 *   4. per-entry `enabled: false` → explicitly disabled
 *   5. per-entry `enabled: true` → explicitly enabled  (wins over slot)
 *   6. slot mismatch (kind is set, slot assigns another id) → slot taken
 *   7. bundled origin → bundled default
 *   8. otherwise → default
 */
export function resolveEnableState(
  candidate: PluginCandidate,
  enableConfig: PluginEnableConfig | undefined,
): { enabled: boolean; reason: string } {
  if (!enableConfig) return { enabled: true, reason: "default" };
  if (enableConfig.enabled === false) {
    return { enabled: false, reason: "globally disabled" };
  }
  if (enableConfig.deny?.includes(candidate.id)) {
    return { enabled: false, reason: "in deny list" };
  }
  if (enableConfig.allow && enableConfig.allow.length > 0) {
    if (!enableConfig.allow.includes(candidate.id)) {
      return { enabled: false, reason: "not in allow list" };
    }
  }
  const entry = enableConfig.entries?.[candidate.id];
  if (entry?.enabled === false) {
    return { enabled: false, reason: "explicitly disabled" };
  }
  if (entry?.enabled === true) {
    return { enabled: true, reason: "explicitly enabled" };
  }
  if (candidate.manifest?.kind && enableConfig.slots) {
    const slotValue = enableConfig.slots[candidate.manifest.kind];
    if (slotValue && slotValue !== candidate.id) {
      return {
        enabled: false,
        reason: `slot "${candidate.manifest.kind}" assigned to "${slotValue}"`,
      };
    }
  }
  if (candidate.origin === "bundled") {
    return { enabled: true, reason: "bundled default" };
  }
  return { enabled: true, reason: "default" };
}

// ---------------------------------------------------------------------------
// Dependency sort
// ---------------------------------------------------------------------------

/**
 * Topological pass: dependencies first, then dependents. The visited Set
 * guards against cycles.
 */
export function sortByDependencies(candidates: PluginCandidate[]): PluginCandidate[] {
  const sorted: PluginCandidate[] = [];
  const visited = new Set<string>();
  const byId = new Map(candidates.map((c) => [c.id, c]));

  function visit(candidate: PluginCandidate): void {
    if (visited.has(candidate.id)) return;
    visited.add(candidate.id);
    for (const depId of candidate.manifest?.dependencies ?? []) {
      const dep = byId.get(depId);
      if (dep) visit(dep);
    }
    sorted.push(candidate);
  }

  for (const candidate of candidates) visit(candidate);
  return sorted;
}

// ---------------------------------------------------------------------------
// Module import + definition normalization
// ---------------------------------------------------------------------------

/**
 * Drill into a module to find the plugin definition or function. Returns
 * the first hit at `mod`, `mod.default`, or `mod.default.default` (Node
 * CJS-interop double-wrap for `module.exports = { default: ... }`).
 */
function findPluginBody(mod: unknown): unknown {
  if (typeof mod === "function") return mod;
  if (!mod || typeof mod !== "object") return undefined;
  const m = mod as { default?: unknown };
  if (typeof m.default === "function") return m.default;
  if (m.default && typeof m.default === "object" && "meta" in m.default) {
    return m.default;
  }
  if (
    m.default &&
    typeof m.default === "object" &&
    "default" in m.default
  ) {
    const inner = (m.default as { default?: unknown }).default;
    if (typeof inner === "function") return inner;
    if (inner && typeof inner === "object" && "meta" in inner) return inner;
  }
  if ("meta" in mod) return mod;
  return undefined;
}

/**
 * Dynamically import a plugin module. Returns the plugin body (default
 * export or function) if it looks like a plugin; null otherwise. Never
 * throws — a single broken plugin is reported as `failed`, not a hard
 * boot error.
 *
 * Dynamic import is intentional: the plugin entry path is determined
 * at runtime by the discovery scan, not known at author time. This is
 * the "plugin loading from a runtime registry" exception in the
 * project's no-dynamic-import rule.
 */
export async function loadPluginModule(
  candidate: PluginCandidate,
): Promise<PluginModule | null> {
  try {
    const fileUrl = pathToFileURL(candidate.entryPath).href;
    const mod = await import(fileUrl);
    const body = findPluginBody(mod);
    if (typeof body === "function") return body as PluginModule;
    if (body && typeof body === "object") return body as PluginDefinition;
    logger.warn(
      { entryPath: candidate.entryPath },
      "Invalid plugin module format",
    );
    return null;
  } catch (error) {
    logger.error(
      { entryPath: candidate.entryPath, error },
      "Failed to load plugin module",
    );
    return null;
  }
}

/**
 * Normalize a module (function or definition) to a PluginDefinition.
 * Function modules get a meta block synthesized from the candidate id
 * and manifest.
 */
export function moduleToDefinition(
  mod: PluginModule,
  candidate: PluginCandidate,
): PluginDefinition {
  if (typeof mod === "function") {
    return {
      meta: {
        id: candidate.id,
        name: candidate.manifest?.name ?? candidate.id,
        version: candidate.manifest?.version ?? "0.0.0",
        description: candidate.manifest?.description,
        author: candidate.manifest?.author,
        kind: candidate.manifest?.kind,
        dependencies: candidate.manifest?.dependencies,
      },
      register: mod,
    };
  }
  return mod;
}

// ---------------------------------------------------------------------------
// PluginApi builder
// ---------------------------------------------------------------------------

/**
 * Build the PluginApi handle handed to plugin authors. Both the
 * register-phase and the activate-phase use the same
 * `hookUnsubscribers` and `services` arrays so cleanup covers
 * everything.
 */
function buildPluginApi(params: {
  meta: PluginDefinition["meta"];
  deps: PluginRuntimeDeps;
  pluginConfig?: Record<string, unknown>;
  hookUnsubscribers: Array<() => void>;
  services: PluginServiceTask[];
}): PluginApi {
  const { meta, deps, pluginConfig, hookUnsubscribers, services } = params;
  const log = getChildLogger(`plugin:${meta.id}`);
  return {
    id: meta.id,
    meta,
    config: deps.config,
    pluginConfig,
    memoryManager: deps.memoryManager,
    remember: deps.memoryManager
      ? (deps.memoryManager.remember as PluginApi["remember"])
      : undefined,
    recall: deps.memoryManager
      ? (deps.memoryManager.recall as PluginApi["recall"])
      : undefined,
    registerTool: (tool) => {
      deps.toolRegistry.register(tool);
      log.debug({ toolName: tool.name }, "Plugin registered tool");
    },
    registerTools: (tools) => {
      deps.toolRegistry.registerTools(tools);
      log.debug({ count: tools.length }, "Plugin registered tools");
    },
    registerHook: (eventType, handler) => {
      const unsubscribe = deps.eventBus.subscribe(
        eventType,
        handler as Parameters<typeof deps.eventBus.subscribe>[1],
      );
      hookUnsubscribers.push(unsubscribe);
      log.debug({ eventType }, "Plugin registered hook");
      return unsubscribe;
    },
    registerService: (service) => {
      services.push(service);
      log.debug({ serviceId: service.id }, "Plugin registered service");
    },
    getLogger: (name) => getChildLogger(name ?? `plugin:${meta.id}`),
    getStateDir: () => deps.getStateDir(meta.id),
  };
}

// ---------------------------------------------------------------------------
// Register / activate pipeline
// ---------------------------------------------------------------------------

/**
 * Register all candidates. Mutates the `registry` map. Returns a
 * per-id result for the caller to surface to operators.
 */
export async function loadPlugins(
  candidates: PluginCandidate[],
  deps: PluginRuntimeDeps,
  registry: Map<string, LoadedPlugin>,
): Promise<LoadResult> {
  const result: LoadResult = { loaded: [], skipped: [], failed: [] };
  const sorted = sortByDependencies(candidates);

  for (const candidate of sorted) {
    const { enabled, reason } = resolveEnableState(
      candidate,
      deps.enableConfig,
    );
    if (!enabled) {
      result.skipped.push({ id: candidate.id, reason });
      logger.debug({ pluginId: candidate.id, reason }, "Plugin skipped");
      continue;
    }

    if (registry.has(candidate.id)) {
      logger.debug({ pluginId: candidate.id }, "Plugin already loaded");
      continue;
    }

    const mod = await loadPluginModule(candidate);
    if (!mod) {
      result.failed.push({ id: candidate.id, error: "Failed to load module" });
      continue;
    }

    const definition = moduleToDefinition(mod, candidate);
    const pluginConfig = deps.enableConfig?.entries?.[candidate.id]?.config;

    const hookUnsubscribers: Array<() => void> = [];
    const services: PluginServiceTask[] = [];
    const api = buildPluginApi({
      meta: definition.meta,
      deps,
      pluginConfig,
      hookUnsubscribers,
      services,
    });

    try {
      if (definition.register) await definition.register(api);
      const loaded: LoadedPlugin = {
        id: candidate.id,
        origin: candidate.origin,
        definition,
        config: deps.config,
        pluginConfig,
        hookUnsubscribers,
        services,
        activated: false,
        memoryManager: deps.memoryManager,
        loadedAt: Date.now(),
      };
      registry.set(candidate.id, loaded);
      result.loaded.push(candidate.id);
      logger.info(
        { pluginId: candidate.id, name: definition.meta.name },
        "Plugin registered",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.failed.push({ id: candidate.id, error: message });
      logger.error(
        { pluginId: candidate.id, error },
        "Plugin register failed",
      );
    }
  }

  logger.info(
    {
      loaded: result.loaded.length,
      skipped: result.skipped.length,
      failed: result.failed.length,
    },
    "Plugin loading completed",
  );
  return result;
}

/**
 * Activate every plugin in `registry`. Runs the activate callback, then
 * starts every queued service. Activated plugins are flagged so a
 * second call is a no-op.
 */
export async function activateAllPlugins(
  registry: Map<string, LoadedPlugin>,
  deps: PluginRuntimeDeps,
): Promise<ActivateResult> {
  const result: ActivateResult = { activated: [], failed: [] };
  for (const [, plugin] of registry) {
    if (plugin.activated) {
      logger.debug({ pluginId: plugin.id }, "Plugin already activated");
      continue;
    }
    try {
      const hookUnsubscribers = plugin.hookUnsubscribers;
      const services = plugin.services;
      const api = buildPluginApi({
        meta: plugin.definition.meta,
        deps,
        pluginConfig: plugin.pluginConfig,
        hookUnsubscribers,
        services,
      });
      if (plugin.definition.activate) await plugin.definition.activate(api);
      for (const service of services) {
        await service.start();
      }
      plugin.activated = true;
      result.activated.push(plugin.id);
      logger.info({ pluginId: plugin.id }, "Plugin activated");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.failed.push({ id: plugin.id, error: message });
      logger.error(
        { pluginId: plugin.id, error },
        "Plugin activate failed",
      );
    }
  }
  return result;
}
