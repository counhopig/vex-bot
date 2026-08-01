/**
 * Plugins module — barrel.
 *
 * Public surface:
 *  - Types (`PluginMeta`, `PluginDefinition`, `PluginApi`, ...)
 *  - `PluginService` class — per-runtime orchestrator (class-based,
 *    NOT a module-level singleton; see service.ts for the multi-owner
 *    contract).
 *  - `definePlugin` / `defineToolPlugin` — pure factory helpers that
 *    build a `PluginDefinition`. They do not register against any
 *    service; the caller decides which `PluginService` (i.e. which
 *    user / channel) to register into.
 *  - `discoverPlugins` from `./discovery.js` for callers that want to
 *    scan the filesystem themselves before handing candidates to
 *    `loadPlugins` (which is exported from `./loader.js`).
 *
 * Deliberately NOT re-exported (multi-owner rule):
 *  - The archive's `getPluginService` / `initPluginService` /
 *    `registerPlugin` / `activatePlugin` / `getLoadedPlugins` /
 *    `unregisterAllPlugins` module-level helpers. Every consumer
 *    instantiates its own `PluginService` and calls its methods.
 */

import type { Tool } from "../tools/types.js";
import type { PluginApi, PluginDefinition } from "./types.js";

export * from "./types.js";
export { PluginService } from "./service.js";
export type { ActivateAllResult, RegisterOptions } from "./service.js";
export {
  discoverPlugins,
  getDefaultSearchDirs,
  MANIFEST_FILENAME,
} from "./discovery.js";
export {
  resolveEnableState,
  sortByDependencies,
  loadPluginModule,
  moduleToDefinition,
  loadPlugins,
  activateAllPlugins,
  type LoadResult,
  type ActivateResult,
} from "./loader.js";

/**
 * Create a plugin definition. The `initialize` callback is the
 * plugin's register-phase entry point. `cleanup` runs on
 * `unregisterPlugin`.
 */
export function definePlugin(
  meta: PluginDefinition["meta"],
  initialize: (api: PluginApi) => void | Promise<void>,
  cleanup?: () => void | Promise<void>,
): PluginDefinition {
  return { meta, register: initialize, cleanup };
}

/**
 * Create a simple tools-only plugin. Equivalent to
 * `definePlugin(meta, (api) => api.registerTools(tools))`.
 */
export function defineToolPlugin(
  meta: PluginDefinition["meta"],
  tools: Tool[],
): PluginDefinition {
  return {
    meta,
    register: (api) => {
      api.registerTools(tools);
    },
  };
}
