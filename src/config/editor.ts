import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { Logger } from "../logger.js";
import type { VexPaths } from "../paths.js";
import { createModelRegistry, type ModelRegistry } from "../providers/models.js";
import { withFileLock } from "../store/fileLock.js";
import { ConfigError, parseConfig, saveConfigText } from "./load.js";
import { clearReloadError, writePendingReload } from "./reload.js";
import type { VexConfig } from "./schema.js";
import { applyLiveSettings, applySettings, readSettings, type SettingsPatch } from "./settings.js";

export interface ConfigEditorOptions {
  paths: VexPaths;
  /** The running configuration; live settings are applied to it in place. */
  config: VexConfig;
  log: Logger;
  /** Overrides the registry built from a candidate configuration, for tests. */
  models?: ModelRegistry;
  /** Restarts the process in place so saved settings take effect; absent where that is unsupported. */
  restart?: () => Promise<void>;
  /** Whether a run is in progress; a restart waits up to 30 seconds for runs to finish. */
  busy: () => boolean;
}

let cachedCatalog: { providers: string[]; models: Record<string, string[]> } | undefined;
/** The built-in providers and their models, for the settings forms. */
function catalog() {
  const providers: string[] = getBuiltinProviders();
  cachedCatalog ??= { providers, models: Object.fromEntries(providers.map((name) => [name, getBuiltinModels(name as never).map((entry) => entry.id)])) };
  return cachedCatalog;
}

/**
 * Edits config.yaml from WebChat: the raw YAML editor and the settings forms. A save is refused unless
 * its models resolve; it applies live settings at once, or records the previous file and restarts.
 */
export function createConfigEditor(opts: ConfigEditorOptions) {
  const { paths, config, log } = opts;
  let restarting = false;
  const scheduleRestart = (): boolean => {
    const restart = opts.restart;
    if (!restart) return false;
    if (restarting) return true;
    restarting = true;
    void (async () => {
      await delay(400);
      if (opts.busy()) log.info("waiting for running turns to finish before restarting");
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && opts.busy()) await delay(500);
      await restart();
    })().catch((err: unknown) => { restarting = false; log.error({ err }, "applying settings by restart failed"); });
    return true;
  };
  const ensureStartable = (text: string) => {
    const next = parseConfig(text, paths);
    const registry = opts.models ?? createModelRegistry(next.providers);
    try { registry.resolve(next.model); registry.resolve(next.backgroundModel); }
    catch (err) { throw new ConfigError(`The model cannot be used: ${err instanceof Error ? err.message : String(err)}`); }
  };
  const commit = async (before: string, text: string, restartRequired: boolean, keys?: string[]): Promise<boolean> => {
    ensureStartable(text);
    if (restartRequired && opts.restart) await writePendingReload(paths, before);
    await saveConfigText(paths, text);
    await clearReloadError(paths);
    if (!restartRequired) applyLiveSettings(config, parseConfig(text, paths));
    const restartingNow = restartRequired && scheduleRestart();
    log.info({ keys, restartRequired, restarting: restartingNow }, "configuration saved");
    return restartingNow;
  };
  return {
    config: {
      read: () => readFile(paths.config, "utf8"),
      save: (text: string, base?: string) => withFileLock(paths.config, async () => {
        const before = await readFile(paths.config, "utf8");
        if (base !== undefined && base !== before) throw new ConfigError("Configuration changed after it was opened; reload it before saving");
        return { restarting: await commit(before, text, text !== before) };
      }),
    },
    settings: {
      read: async () => ({ ...readSettings(await readFile(paths.config, "utf8")), catalog: catalog() }),
      save: (patch: SettingsPatch) => withFileLock(paths.config, async () => {
        const before = await readFile(paths.config, "utf8");
        const next = applySettings(before, patch, paths);
        const restarting = await commit(before, next.text, next.restartRequired, [...Object.keys(patch.set ?? {}), ...(patch.unset ?? [])]);
        return { restartRequired: next.restartRequired, restarting };
      }),
    },
  };
}
