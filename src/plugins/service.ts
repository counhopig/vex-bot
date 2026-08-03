/**
 * Plugin service — orchestrator.
 *
 * One `PluginService` instance owns one plugin runtime for one
 * (user, channel) pair. Multiple instances coexist without sharing
 * state — the same plugin registered in two services lives in two
 * registries. This is the multi-owner contract: a plugin registered
 * in one Web user's bot is invisible to another's.
 *
 * Lifecycle:
 *   - `registerPlugin(def, origin, opts?)` — calls the plugin's
 *     `register` callback against a built PluginApi handle.
 *   - `activateAll()` — calls each plugin's `activate` callback, then
 *     starts every queued service in registration order.
 *   - `unregisterPlugin(id)` — stops services in REVERSE order, fires
 *     hook unsubscribers, invokes the plugin's `cleanup`. Idempotent.
 *   - `shutdown()` — unregister every plugin.
 *
 * The archive's `getPluginService()` module-level default and
 * `let defaultService: PluginService | null = null` singleton are
 * NOT preserved. The multi-owner rule forbids process-global plugin
 * state.
 */

import { getChildLogger } from "../utils/logger.js";
import { loadPlugins, type LoadResult } from "./loader.js";
import type { Tool } from "../tools/types.js";
import type { HookEventType, HookHandler } from "../hooks/types.js";
import type {
  LoadedPlugin,
  PluginApi,
  PluginCandidate,
  PluginDefinition,
  PluginMeta,
  PluginOrigin,
  PluginRuntimeDeps,
  PluginServiceTask,
} from "./types.js";

const logger = getChildLogger("plugins:service");

/** Result of `activateAll`. */
export interface ActivateAllResult {
  activated: string[];
  failed: Array<{ id: string; error: string }>;
}

/** Options forwarded to register-time. */
export interface RegisterOptions {
  /** Per-plugin config (PluginEnableConfig.entries[id].config). */
  pluginConfig?: Record<string, unknown>;
  /** Override the default config for the per-plugin handle. */
  config?: PluginRuntimeDeps["config"];
}

/**
 * Per-runtime plugin orchestrator. See module docstring for lifecycle.
 */
export class PluginService {
  readonly #deps: PluginRuntimeDeps;
  readonly #registry: Map<string, LoadedPlugin> = new Map();

  constructor(deps: PluginRuntimeDeps) {
    this.#deps = deps;
  }

  /** Read-only view of the loaded plugin entries. */
  get registry(): ReadonlyMap<string, LoadedPlugin> {
    return this.#registry;
  }

  /**
   * Register a plugin definition. Calls the plugin's `register`
   * callback against a built `PluginApi` that wires into the injected
   * `deps`. Duplicate ids keep the first registration; second call is
   * a no-op (matches archive semantics).
   */
  registerPlugin(
    definition: PluginDefinition,
    origin: PluginOrigin = "config",
    options: RegisterOptions = {},
  ): void {
    if (this.#registry.has(definition.meta.id)) {
      logger.debug(
        { pluginId: definition.meta.id },
        "Plugin already registered, skipping",
      );
      return;
    }

    const hookUnsubscribers: Array<() => void> = [];
    const services: PluginServiceTask[] = [];
    const api = this.#buildApi({
      meta: definition.meta,
      pluginConfig: options.pluginConfig,
      configOverride: options.config,
      hookUnsubscribers,
      services,
    });

    try {
      const result = definition.register?.(api);
      if (result && typeof (result as Promise<unknown>).then === "function") {
        logger.warn(
          { pluginId: definition.meta.id },
          "register() returned a promise; use activate() for async init",
        );
      }
    } catch (error) {
      logger.error(
        { pluginId: definition.meta.id, error },
        "Plugin register failed",
      );
      return;
    }

    const loaded: LoadedPlugin = {
      id: definition.meta.id,
      origin,
      definition,
      config: options.config ?? this.#deps.config,
      pluginConfig: options.pluginConfig,
      hookUnsubscribers,
      services,
      activated: false,
      memoryManager: this.#deps.memoryManager,
      loadedAt: Date.now(),
    };
    this.#registry.set(definition.meta.id, loaded);
    logger.info(
      { pluginId: definition.meta.id, name: definition.meta.name },
      "Plugin registered",
    );
  }

  /**
   * Load candidate plugins (e.g. from a discovery scan) into this
   * service's registry. Thin bridge over the class-free `loadPlugins`:
   * the registry is private, so bootstrap code hands candidates here
   * instead of populating the map directly. Returns a per-id outcome
   * report; never throws for a broken plugin.
   */
  async loadFromCandidates(candidates: PluginCandidate[]): Promise<LoadResult> {
    return loadPlugins(candidates, this.#deps, this.#registry);
  }

  /**
   * Activate every registered plugin. Runs each plugin's `activate`
   * callback (if any), then starts every queued service. Already
   * activated plugins are skipped.
   */
  async activateAll(): Promise<ActivateAllResult> {
    const result: ActivateAllResult = { activated: [], failed: [] };
    for (const plugin of this.#registry.values()) {
      if (plugin.activated) {
        logger.debug({ pluginId: plugin.id }, "Plugin already activated");
        continue;
      }
      try {
        const api = this.#buildApi({
          meta: plugin.definition.meta,
          pluginConfig: plugin.pluginConfig,
          configOverride: plugin.config,
          hookUnsubscribers: plugin.hookUnsubscribers,
          services: plugin.services,
        });
        const value = plugin.definition.activate?.(api);
        if (value && typeof (value as Promise<unknown>).then === "function") {
          await value;
        }
        for (const service of plugin.services) {
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

  /**
   * Unregister a single plugin. Stops services in reverse order (using
   * a copy so the caller's view of the list is not mutated), fires
   * hook unsubscribers, then runs the plugin's `cleanup` callback.
   * No-op for an unknown id.
   */
  async unregisterPlugin(pluginId: string): Promise<void> {
    const plugin = this.#registry.get(pluginId);
    if (!plugin) {
      logger.warn({ pluginId }, "Plugin not found");
      return;
    }

    logger.info({ pluginId }, "Unregistering plugin");

    for (const service of [...plugin.services].reverse()) {
      try {
        await service.stop();
      } catch (error) {
        logger.error(
          { pluginId, serviceId: service.id, error },
          "Service stop error",
        );
      }
    }

    if (plugin.definition.cleanup) {
      try {
        const value = plugin.definition.cleanup();
        if (value && typeof (value as Promise<unknown>).then === "function") {
          await value;
        }
      } catch (error) {
        logger.error(
          { pluginId, error },
          "Plugin cleanup error",
        );
      }
    }

    for (const unsubscribe of plugin.hookUnsubscribers) {
      unsubscribe();
    }

    this.#registry.delete(pluginId);
    logger.info({ pluginId }, "Plugin unregistered");
  }

  /** Unregister every plugin. Safe to call multiple times. */
  async shutdown(): Promise<void> {
    const ids = Array.from(this.#registry.keys());
    for (const id of ids) {
      await this.unregisterPlugin(id);
    }
  }

  /** All loaded plugin metadata in registration order. */
  list(): PluginMeta[] {
    return Array.from(this.#registry.values()).map(
      (p) => p.definition.meta,
    );
  }

  /** Get a specific loaded plugin. */
  get(pluginId: string): LoadedPlugin | undefined {
    return this.#registry.get(pluginId);
  }

  /** Whether a plugin is currently loaded. */
  isLoaded(pluginId: string): boolean {
    return this.#registry.has(pluginId);
  }

  /** Whether a plugin is loaded AND has been activated. */
  isActivated(pluginId: string): boolean {
    return this.#registry.get(pluginId)?.activated ?? false;
  }

  /**
   * Build the PluginApi handle. The hookUnsubscribers and services
   * arrays are caller-owned so cleanup drains exactly the handles
   * register/activate pushed onto them.
   *
   * The return is cast to PluginApi because TypeScript can't unify the
   * concrete handler signature (HookHandler = single union) with the
   * generic API surface (TypedHookHandler<T> = Extract). The runtime
   * contract is identical — EventBus.subscribe is type-safe end to
   * end through the public API.
   */
  #buildApi(params: {
    meta: PluginDefinition["meta"];
    pluginConfig?: Record<string, unknown>;
    configOverride?: PluginRuntimeDeps["config"];
    hookUnsubscribers: Array<() => void>;
    services: PluginServiceTask[];
  }): PluginApi {
    const { meta, pluginConfig, configOverride, hookUnsubscribers, services } = params;
    const log = getChildLogger(`plugin:${meta.id}`);
    const config = configOverride ?? this.#deps.config;
    const memoryManager = this.#deps.memoryManager;
    const api: PluginApi = {
      id: meta.id,
      meta,
      config,
      pluginConfig,
      memoryManager,
      remember: memoryManager ? (memoryManager.remember as never) : undefined,
      recall: memoryManager ? (memoryManager.recall as never) : undefined,
      registerTool: (tool: Tool) => {
        this.#deps.toolRegistry.register(tool);
        log.debug({ toolName: tool.name }, "Plugin registered tool");
      },
      registerTools: (tools: Tool[]) => {
        this.#deps.toolRegistry.registerTools(tools);
        log.debug({ count: tools.length }, "Plugin registered tools");
      },
      registerHook: ((eventType: HookEventType, handler: HookHandler) => {
        const unsubscribe = this.#deps.eventBus.subscribe(eventType, handler);
        hookUnsubscribers.push(unsubscribe);
        log.debug({ eventType }, "Plugin registered hook");
        return unsubscribe;
      }) as PluginApi["registerHook"],
      registerService: (service: PluginServiceTask) => {
        services.push(service);
        log.debug({ serviceId: service.id }, "Plugin registered service");
      },
      getLogger: (name?: string) => getChildLogger(name ?? `plugin:${meta.id}`),
      getStateDir: () => this.#deps.getStateDir(meta.id),
    };
    return api;
  }
}
