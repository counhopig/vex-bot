/**
 * Plugin Service Management
 *
 * Provides a unified plugin management entry point
 */

import type { VexConfig } from "../types/index.js";
import type { PluginEnableConfig, LoadedPlugin, PluginMeta } from "./index.js";
import {
  getLoadedPlugins,
  getPluginDetails,
  unregisterPlugin,
  unregisterAllPlugins,
  isPluginLoaded,
  isPluginActivated,
} from "./index.js";
import { loadPlugins, activateAllPlugins } from "./loader.js";
import { discoverPlugins } from "./discovery.js";
import { getChildLogger } from "../utils/logger.js";

const logger = getChildLogger("plugins:service");

/**
 * Plugin service
 */
export class PluginService {
  private config: VexConfig;
  private enableConfig: PluginEnableConfig;
  private initialized: boolean = false;

  constructor(config: VexConfig, enableConfig?: PluginEnableConfig) {
    this.config = config;
    this.enableConfig = enableConfig ?? {};
  }

  /**
   * Initialize plugin service
   */
  async initialize(): Promise<{
    loaded: string[];
    activated: string[];
    skipped: Array<{ id: string; reason: string }>;
    failed: Array<{ id: string; error: string }>;
  }> {
    if (this.initialized) {
      logger.warn("Plugin service already initialized");
      return { loaded: [], activated: [], skipped: [], failed: [] };
    }

    logger.info("Initializing plugin service");

    // Load plugins
    const loadResult = await loadPlugins(this.config, this.enableConfig);

    // Activate plugins
    const activateResult = await activateAllPlugins();

    this.initialized = true;

    return {
      loaded: loadResult.loaded,
      activated: activateResult.activated,
      skipped: loadResult.skipped,
      failed: [...loadResult.failed, ...activateResult.failed],
    };
  }

  /**
   * Shut down plugin service
   */
  async shutdown(): Promise<void> {
    if (!this.initialized) return;

    logger.info("Shutting down plugin service");
    await unregisterAllPlugins();
    this.initialized = false;
  }

  /**
   * Discover available plugins (without loading)
   */
  async discover(): Promise<Array<{
    id: string;
    origin: string;
    manifest?: Record<string, unknown>;
    loaded: boolean;
    activated: boolean;
  }>> {
    const candidates = await discoverPlugins({
      paths: this.enableConfig.paths,
    });

    return candidates.map(c => ({
      id: c.id,
      origin: c.origin,
      manifest: c.manifest as Record<string, unknown> | undefined,
      loaded: isPluginLoaded(c.id),
      activated: isPluginActivated(c.id),
    }));
  }

  /**
   * Get list of loaded plugins
   */
  list(): PluginMeta[] {
    return getLoadedPlugins();
  }

  /**
   * Get plugin details
   */
  get(pluginId: string): LoadedPlugin | undefined {
    return getPluginDetails(pluginId);
  }

  /**
   * Unload a plugin
   */
  async unload(pluginId: string): Promise<boolean> {
    if (!isPluginLoaded(pluginId)) {
      return false;
    }
    await unregisterPlugin(pluginId);
    return true;
  }

  /**
   * Check if a plugin is loaded
   */
  isLoaded(pluginId: string): boolean {
    return isPluginLoaded(pluginId);
  }

  /**
   * Check if a plugin is activated
   */
  isActivated(pluginId: string): boolean {
    return isPluginActivated(pluginId);
  }
}

/** Default service instance */
let defaultService: PluginService | null = null;

/**
 * Get the default plugin service
 */
export function getPluginService(config?: VexConfig, enableConfig?: PluginEnableConfig): PluginService {
  if (!defaultService && config) {
    defaultService = new PluginService(config, enableConfig);
  }
  if (!defaultService) {
    throw new Error("Plugin service not initialized. Provide config on first call.");
  }
  return defaultService;
}
