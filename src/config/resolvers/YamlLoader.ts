/**
 * YamlLoader — reads and parses a YAML config file.
 *
 * Ported from the archive's loadConfigFromFile + mergeConfigs. This is
 * Tier 2 of the config resolution chain (after built-in defaults).
 */

import { readFileSync, existsSync } from "fs";
import yaml from "yaml";
import { getChildLogger } from "../../utils/logger.js";
import { VexConfigSchema } from "../schema.js";

const logger = getChildLogger("yaml-loader");

export type YamlConfig = Record<string, unknown>;

export class YamlLoader {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  /** Load, parse, and validate the YAML file. Returns an empty object when
   *  the file does not exist or is empty (not an error — the file is optional). */
  load(): YamlConfig {
    if (!existsSync(this.path)) {
      logger.debug({ path: this.path }, "Config file not found, skipping");
      return {};
    }

    const content = readFileSync(this.path, "utf-8");
    if (!content.trim()) {
      logger.debug({ path: this.path }, "Config file is empty, skipping");
      return {};
    }

    const parsed = yaml.parse(content) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      logger.warn({ path: this.path }, "Config file has no valid top-level object, skipping");
      return {};
    }

    // Validate through Zod to get defaults applied, then return the raw
    // validated data so ConfigStore can merge it with defaults properly.
    const result = VexConfigSchema.safeParse(parsed);
    if (!result.success) {
      logger.error({ path: this.path, issues: result.error.issues }, "Config validation failed");
      throw new Error(`Invalid config at ${this.path}: ${result.error.message}`);
    }

    logger.debug({ path: this.path, keys: Object.keys(result.data) }, "Config file loaded");
    return result.data as unknown as YamlConfig;
  }
}
