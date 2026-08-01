/**
 * Plugin system — public types.
 *
 * The plugin layer is per-instance (no process-global registry), so the
 * types below are deliberately framework-agnostic: a `PluginApi` is built
 * by the orchestrator and handed to the plugin author with the specific
 * `ToolRegistry` / `EventBus` / state directory the plugin should
 * register against. That keeps the multi-owner model honest — a plugin
 * registered in one Web user's runtime is invisible to another's.
 *
 * Safety contract:
 *  - `PluginDefinition.register` is sync (registers tools, hooks, services).
 *  - `PluginDefinition.activate` is async (starts background services).
 *  - `PluginDefinition.cleanup` runs on teardown, after services stop.
 *  - All three are isolated per orchestrator instance; no module-level
 *    plugin state exists in the new architecture.
 */

import type { Tool } from "../tools/types.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { EventBus } from "../hooks/EventBus.js";
import type { HookEvent, HookEventType } from "../hooks/types.js";
import type { EffectiveConfig } from "../config/EffectiveConfig.js";

/**
 * Structural interface for the long-term memory manager. The concrete
 * `MemoryManager` class is being ported in another module; this shape
 * lets plugins depend on the contract without forcing a hard import
 * order, and keeps the plugin module buildable before memory lands.
 */
export interface MemoryManagerLike {
  remember: (...args: never[]) => unknown;
  recall: (...args: never[]) => unknown;
}

/** Plugin metadata — the part operators see / operators override. */
export interface PluginMeta {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  /** Plugin kind — for exclusive slot use (e.g. one memory backend wins). */
  kind?: string;
  /** Other plugin ids this one depends on. */
  dependencies?: string[];
}

/** On-disk manifest shape (`vex.plugin.json`). */
export interface PluginManifest {
  id: string;
  name?: string;
  version?: string;
  description?: string;
  author?: string;
  kind?: string;
  /** Relative path to the module entry. */
  main?: string;
  dependencies?: string[];
}

/** Plugin origin (which tier discovered it). */
export type PluginOrigin = "bundled" | "global" | "workspace" | "config";

/** A plugin candidate before it's been loaded. */
export interface PluginCandidate {
  id: string;
  origin: PluginOrigin;
  /** Absolute path to the module entry file. */
  entryPath: string;
  /** Absolute path to the plugin's root directory. */
  directory: string;
  /** Parsed manifest, if any. */
  manifest?: PluginManifest;
  /** Path to the manifest file, if any. */
  manifestPath?: string;
}

/** A background service a plugin wants to run while it's active. */
export interface PluginServiceTask {
  id: string;
  start: () => void | Promise<void>;
  stop: () => void | Promise<void>;
}

/** A handler bound to one specific event type. */
export type TypedHookHandler<T extends HookEventType> = (
  event: Extract<HookEvent, { type: T }>,
) => void | Promise<void>;

/** The handle handed to plugin authors during register/activate. */
export interface PluginApi {
  id: string;
  meta: PluginMeta;
  /** Resolved config for the (user, channel) this plugin instance serves. */
  config: EffectiveConfig;
  /** Per-plugin config (entries[id].config from PluginEnableConfig). */
  pluginConfig?: Record<string, unknown>;
  /** Shared long-term memory manager, if one was wired in. */
  memoryManager?: MemoryManagerLike;
  /** Convenience bound to memoryManager?.remember when present. */
  remember?: MemoryManagerLike["remember"];
  /** Convenience bound to memoryManager?.recall when present. */
  recall?: MemoryManagerLike["recall"];
  /** Register a single tool with this instance's tool registry. */
  registerTool: (tool: Tool) => void;
  /** Register several tools in one call. */
  registerTools: (tools: Tool[]) => void;
  /** Subscribe a hook handler. Returns an unsubscribe fn. */
  registerHook: <T extends HookEventType>(
    eventType: T,
    handler: TypedHookHandler<T>,
  ) => () => void;
  /** Queue a background service to be started at activate-time. */
  registerService: (service: PluginServiceTask) => void;
  /** Logger namespaced to this plugin (e.g. `plugin:my-plugin`). */
  getLogger: (name?: string) => {
    debug: (obj: unknown, msg?: string) => void;
    info: (obj: unknown, msg?: string) => void;
    warn: (obj: unknown, msg?: string) => void;
    error: (obj: unknown, msg?: string) => void;
  };
  /** Per-plugin persistent state directory. */
  getStateDir: () => string;
}

/** The shape a plugin author exports. */
export interface PluginDefinition {
  meta: PluginMeta;
  /** Sync: register tools/hooks against the provided api. */
  register?: (api: PluginApi) => void | Promise<void>;
  /** Async: start background services, do I/O-bound init. */
  activate?: (api: PluginApi) => void | Promise<void>;
  /** Optional teardown, called after services stop. */
  cleanup?: () => void | Promise<void>;
}

/** A plugin module can be a definition or a function (which becomes register). */
export type PluginModule = PluginDefinition | ((api: PluginApi) => void | Promise<void>);

/** A registered plugin in memory. */
export interface LoadedPlugin {
  id: string;
  origin: PluginOrigin;
  definition: PluginDefinition;
  /** The config that was passed at register-time. */
  config: EffectiveConfig;
  pluginConfig?: Record<string, unknown>;
  /** Unsubscribers returned by registerHook — fired on teardown. */
  hookUnsubscribers: Array<() => void>;
  /** Services queued at register or activate time — started in registration
   *  order, stopped in reverse order on unregister. */
  services: PluginServiceTask[];
  activated: boolean;
  memoryManager?: MemoryManagerLike;
  loadedAt: number;
}

/** Per-entry override in PluginEnableConfig.entries[id]. */
export interface PluginEnableEntry {
  enabled?: boolean;
  config?: Record<string, unknown>;
}

/** Operator-supplied enable/override configuration. */
export interface PluginEnableConfig {
  /** Global on/off switch (default true). */
  enabled?: boolean;
  /** Whitelist — if set and non-empty, only these ids load. */
  allow?: string[];
  /** Blacklist — these ids never load. */
  deny?: string[];
  /** Additional search paths to scan. */
  paths?: string[];
  /** Exclusive slot assignments by kind. */
  slots?: Record<string, string>;
  /** Per-plugin overrides. */
  entries?: Record<string, PluginEnableEntry>;
}

/** Lifecycle event for hook observers / diagnostics. */
export type PluginLifecycleEvent =
  | { type: "discovered"; candidate: PluginCandidate }
  | { type: "loaded"; pluginId: string }
  | { type: "activated"; pluginId: string }
  | { type: "unloaded"; pluginId: string }
  | { type: "error"; pluginId: string; error: Error };

/** Dependency injection the loader / service needs to operate. */
export interface PluginRuntimeDeps {
  toolRegistry: ToolRegistry;
  eventBus: EventBus;
  config: EffectiveConfig;
  memoryManager?: MemoryManagerLike;
  /** Function returning the state dir for a given plugin id. */
  getStateDir: (pluginId: string) => string;
  /** Effective config from the operator's PluginEnableConfig. */
  enableConfig?: PluginEnableConfig;
}
