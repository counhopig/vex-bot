/**
 * Plugin System - Enhanced Edition
 *
 * Modeled after moltbot's plugins module implementation
 * Supports plugin discovery, loading, registration, lifecycle management, and config validation
 */

import type { Tool } from "../tools/types.js";
import type { VexConfig, ProviderId } from "../types/index.js";
import { registerTool, registerTools } from "../tools/registry.js";
import { registerHook, type HookEventType, type HookHandler } from "../hooks/index.js";
import { getChildLogger } from "../utils/logger.js";

const logger = getChildLogger("plugins");

// ============== Plugin Types ==============

/** Plugin metadata */
export interface PluginMeta {
  /** Plugin ID */
  id: string;
  /** Plugin name */
  name: string;
  /** Plugin version */
  version: string;
  /** Plugin description */
  description?: string;
  /** Author */
  author?: string;
  /** Plugin kind (for exclusive slot use) */
  kind?: string;
  /** Dependent plugins */
  dependencies?: string[];
}

/** Plugin config schema (JSON Schema format) */
export interface PluginConfigSchema {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

/** Plugin manifest (vex.plugin.json) */
export interface PluginManifest {
  id: string;
  name?: string;
  version?: string;
  description?: string;
  author?: string;
  kind?: string;
  main?: string;
  configSchema?: PluginConfigSchema;
  dependencies?: string[];
  /** List of provided tool names */
  tools?: string[];
  /** List of provided channel IDs */
  channels?: string[];
}

/** Plugin API */
export interface PluginApi {
  /** Plugin ID */
  id: string;
  /** Plugin metadata */
  meta: PluginMeta;
  /** Global config */
  config: VexConfig;
  /** Plugin-specific config */
  pluginConfig?: Record<string, unknown>;
  /** Register a tool */
  registerTool: (tool: Tool) => void;
  /** Register tools in bulk */
  registerTools: (tools: Tool[]) => void;
  /** Register a Hook */
  registerHook: <T extends HookEventType>(eventType: T, handler: HookHandler) => () => void;
  /** Register an HTTP route (for extension) */
  registerHttpRoute?: (route: HttpRoute) => void;
  /** Register a service (background task) */
  registerService?: (service: PluginService) => void;
  /** Get a logger */
  getLogger: (name?: string) => ReturnType<typeof getChildLogger>;
  /** Get state directory */
  getStateDir: () => string;
}

/** HTTP route */
export interface HttpRoute {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  handler: (req: unknown, res: unknown) => void | Promise<void>;
}

/** Plugin service (background task) */
export interface PluginService {
  id: string;
  start: () => void | Promise<void>;
  stop: () => void | Promise<void>;
}

/** Plugin definition */
export interface PluginDefinition {
  /** Plugin metadata */
  meta: PluginMeta;
  /** Config schema */
  configSchema?: PluginConfigSchema;
  /** Registration phase (sync) */
  register?: (api: PluginApi) => void | Promise<void>;
  /** Activation phase (async) */
  activate?: (api: PluginApi) => void | Promise<void>;
  /** Cleanup function */
  cleanup?: () => void | Promise<void>;
}

/** Plugin module (can be an object or function) */
export type PluginModule =
  | PluginDefinition
  | ((api: PluginApi) => void | Promise<void>);

/** Plugin origin */
export type PluginOrigin = "bundled" | "global" | "workspace" | "config";

/** Discovered plugin candidate */
export interface PluginCandidate {
  /** Plugin ID (from manifest or directory name) */
  id: string;
  /** Origin */
  origin: PluginOrigin;
  /** Manifest file path */
  manifestPath?: string;
  /** Entry file path */
  entryPath: string;
  /** Directory path */
  directory: string;
  /** Manifest content */
  manifest?: PluginManifest;
}

/** Loaded plugin */
export interface LoadedPlugin {
  /** Plugin ID */
  id: string;
  /** Origin */
  origin: PluginOrigin;
  /** Definition */
  definition: PluginDefinition;
  /** Configuration */
  pluginConfig?: Record<string, unknown>;
  /** Registered Hook unsubscribe functions */
  hookUnsubscribers: Array<() => void>;
  /** Registered services */
  services: PluginService[];
  /** Whether activated */
  activated: boolean;
  /** Load timestamp */
  loadedAt: number;
}

/** Plugin enable state configuration */
export interface PluginEnableConfig {
  /** Whether to globally enable plugins */
  enabled?: boolean;
  /** Allow list (if set, only load these) */
  allow?: string[];
  /** Deny list (these are never loaded) */
  deny?: string[];
  /** Additional load paths */
  paths?: string[];
  /** Exclusive slot configuration */
  slots?: Record<string, string>;
  /** Per-plugin configuration */
  entries?: Record<string, {
    enabled?: boolean;
    config?: Record<string, unknown>;
  }>;
}

/** Plugin lifecycle event */
export type PluginLifecycleEvent =
  | { type: "discovered"; candidate: PluginCandidate }
  | { type: "loaded"; plugin: LoadedPlugin }
  | { type: "activated"; pluginId: string }
  | { type: "unloaded"; pluginId: string }
  | { type: "error"; pluginId: string; error: Error };

// ============== Plugin Management ==============

/** Plugin registry */
const pluginRegistry = new Map<string, LoadedPlugin>();

/** Register a plugin */
export async function registerPlugin(
  definition: PluginDefinition,
  config: VexConfig,
  options?: {
    origin?: PluginOrigin;
    pluginConfig?: Record<string, unknown>;
  }
): Promise<void> {
  const { meta } = definition;
  const origin = options?.origin ?? "config";

  // Check if already registered
  if (pluginRegistry.has(meta.id)) {
    logger.warn({ pluginId: meta.id }, "Plugin already registered, skipping");
    return;
  }

  logger.info({ pluginId: meta.id, name: meta.name, version: meta.version }, "Registering plugin");

  const hookUnsubscribers: Array<() => void> = [];
  const services: PluginService[] = [];

  // Create plugin API
  const api: PluginApi = {
    id: meta.id,
    meta,
    config,
    pluginConfig: options?.pluginConfig,
    registerTool: (tool) => {
      registerTool(tool);
      logger.debug({ pluginId: meta.id, toolName: tool.name }, "Plugin registered tool");
    },
    registerTools: (tools) => {
      registerTools(tools);
      logger.debug({ pluginId: meta.id, count: tools.length }, "Plugin registered tools");
    },
    registerHook: (eventType, handler) => {
      const unsubscribe = registerHook(eventType, handler);
      hookUnsubscribers.push(unsubscribe);
      logger.debug({ pluginId: meta.id, eventType }, "Plugin registered hook");
      return unsubscribe;
    },
    registerService: (service) => {
      services.push(service);
      logger.debug({ pluginId: meta.id, serviceId: service.id }, "Plugin registered service");
    },
    getLogger: (name) => getChildLogger(name ?? `plugin:${meta.id}`),
    getStateDir: () => {
      const { homedir } = require("os");
      const { join } = require("path");
      return join(homedir(), ".vex", "plugins", meta.id);
    },
  };

  // Execute register phase
  try {
    if (definition.register) {
      await definition.register(api);
    }

    const loaded: LoadedPlugin = {
      id: meta.id,
      origin,
      definition,
      pluginConfig: options?.pluginConfig,
      hookUnsubscribers,
      services,
      activated: false,
      loadedAt: Date.now(),
    };

    pluginRegistry.set(meta.id, loaded);
    logger.info({ pluginId: meta.id }, "Plugin registered successfully");
  } catch (error) {
    logger.error({ pluginId: meta.id, error }, "Failed to register plugin");
    throw error;
  }
}

/** Activate a plugin */
export async function activatePlugin(pluginId: string): Promise<void> {
  const plugin = pluginRegistry.get(pluginId);
  if (!plugin) {
    throw new Error(`Plugin "${pluginId}" not found`);
  }

  if (plugin.activated) {
    logger.debug({ pluginId }, "Plugin already activated");
    return;
  }

  logger.info({ pluginId }, "Activating plugin");

  // Create API (simplified version)
  const api: PluginApi = {
    id: plugin.id,
    meta: plugin.definition.meta,
    config: {} as VexConfig,  // Needs to be passed in externally
    pluginConfig: plugin.pluginConfig,
    registerTool: (tool) => registerTool(tool),
    registerTools: (tools) => registerTools(tools),
    registerHook: (eventType, handler) => {
      const unsubscribe = registerHook(eventType, handler);
      plugin.hookUnsubscribers.push(unsubscribe);
      return unsubscribe;
    },
    getLogger: (name) => getChildLogger(name ?? `plugin:${plugin.id}`),
    getStateDir: () => {
      const { homedir } = require("os");
      const { join } = require("path");
      return join(homedir(), ".vex", "plugins", plugin.id);
    },
  };

  // Execute activate phase
  try {
    if (plugin.definition.activate) {
      await plugin.definition.activate(api);
    }

    // Start services
    for (const service of plugin.services) {
      await service.start();
    }

    plugin.activated = true;
    logger.info({ pluginId }, "Plugin activated successfully");
  } catch (error) {
    logger.error({ pluginId, error }, "Failed to activate plugin");
    throw error;
  }
}

/** Unregister a plugin */
export async function unregisterPlugin(pluginId: string): Promise<void> {
  const plugin = pluginRegistry.get(pluginId);
  if (!plugin) {
    logger.warn({ pluginId }, "Plugin not found");
    return;
  }

  logger.info({ pluginId }, "Unregistering plugin");

  // Stop services (reverse order)
  for (const service of plugin.services.reverse()) {
    try {
      await service.stop();
    } catch (error) {
      logger.error({ pluginId, serviceId: service.id, error }, "Service stop error");
    }
  }

  // Invoke cleanup function
  if (plugin.definition.cleanup) {
    try {
      await plugin.definition.cleanup();
    } catch (error) {
      logger.error({ pluginId, error }, "Plugin cleanup error");
    }
  }

  // Unsubscribe all Hooks
  for (const unsubscribe of plugin.hookUnsubscribers) {
    unsubscribe();
  }

  pluginRegistry.delete(pluginId);
  logger.info({ pluginId }, "Plugin unregistered");
}

/** Get loaded plugins */
export function getLoadedPlugins(): PluginMeta[] {
  return Array.from(pluginRegistry.values()).map((p) => p.definition.meta);
}

/** Get plugin details */
export function getPluginDetails(pluginId: string): LoadedPlugin | undefined {
  return pluginRegistry.get(pluginId);
}

/** Check if a plugin is loaded */
export function isPluginLoaded(pluginId: string): boolean {
  return pluginRegistry.has(pluginId);
}

/** Check if a plugin is activated */
export function isPluginActivated(pluginId: string): boolean {
  return pluginRegistry.get(pluginId)?.activated ?? false;
}

/** Unregister all plugins */
export async function unregisterAllPlugins(): Promise<void> {
  const pluginIds = Array.from(pluginRegistry.keys());
  for (const pluginId of pluginIds) {
    await unregisterPlugin(pluginId);
  }
}

// ============== Convenience Create Functions ==============

/** Create a plugin */
export function definePlugin(
  meta: PluginMeta,
  initialize: (api: PluginApi) => void | Promise<void>,
  cleanup?: () => void | Promise<void>
): PluginDefinition {
  return {
    meta,
    register: initialize,
    cleanup,
  };
}

/** Create a simple plugin (tools only) */
export function defineToolPlugin(
  meta: PluginMeta,
  tools: Tool[]
): PluginDefinition {
  return {
    meta,
    register: (api) => {
      api.registerTools(tools);
    },
  };
}
