/**
 * Shared per-user JSON store helper
 *
 * Mirrors the Python PersonaStorage / SkillStorage pattern:
 * - One JSON file per key (e.g. userId → <feature>/users/<userId>.json)
 * - LRU cache for hot keys
 * - Atomic write (write to temp file, then rename)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync, rmSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { getChildLogger } from "../../utils/logger.js";

const logger = getChildLogger("json-store");

/** A generic JSON store with LRU caching */
export class JsonStore<T extends Record<string, unknown>> {
  private baseDir: string;
  private cache = new Map<string, T>();
  private maxCacheSize: number;

  constructor(options: { baseDir: string; maxCacheSize?: number }) {
    this.baseDir = options.baseDir;
    this.maxCacheSize = options.maxCacheSize ?? 128;

    if (!existsSync(this.baseDir)) {
      mkdirSync(this.baseDir, { recursive: true });
    }
  }

  /** Build file path for a key */
  private filePath(key: string): string {
    const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(this.baseDir, `${safeKey}.json`);
  }

  /** Read from disk (or return null if missing) */
  private readFile(key: string): T | null {
    const path = this.filePath(key);
    if (!existsSync(path)) return null;
    try {
      const raw = readFileSync(path, "utf-8");
      return JSON.parse(raw) as T;
    } catch (error) {
      logger.error({ error, key, path }, "Failed to read JSON store file");
      return null;
    }
  }

  /** Write to disk atomically */
  private writeFile(key: string, value: T): void {
    const path = this.filePath(key);
    const tmpPath = `${path}.tmp`;
    try {
      writeFileSync(tmpPath, JSON.stringify(value, null, 2), "utf-8");
      renameSync(tmpPath, path);
    } catch (error) {
      logger.error({ error, key, path }, "Failed to write JSON store file");
      throw error;
    }
  }

  /** Get value by key (from cache or disk) */
  get(key: string): T | null {
    const cached = this.cache.get(key);
    if (cached) return cached;

    const value = this.readFile(key);
    if (value) {
      this.setCache(key, value);
    }
    return value;
  }

  /** Set value by key (writes to disk + cache) */
  set(key: string, value: T): void {
    this.writeFile(key, value);
    this.setCache(key, value);
  }

  /** Delete key (removes from disk + cache) */
  delete(key: string): void {
    const path = this.filePath(key);
    if (existsSync(path)) {
      try {
        rmSync(path);
      } catch {
        // Fallback to unlinkSync
        try {
          unlinkSync(path);
        } catch {
          // Ignore deletion errors
        }
      }
    }
    this.cache.delete(key);
  }

  /** Check if key exists */
  has(key: string): boolean {
    if (this.cache.has(key)) return true;
    return existsSync(this.filePath(key));
  }

  /** List all keys */
  keys(): string[] {
    // This is a simplified implementation; in production you'd scan the directory
    return Array.from(this.cache.keys());
  }

  /** Set cache entry with LRU eviction */
  private setCache(key: string, value: T): void {
    if (this.cache.size >= this.maxCacheSize && !this.cache.has(key)) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, value);
  }

  /** Clear memory cache (does not delete files) */
  clearCache(): void {
    this.cache.clear();
  }
}

/** Create a JsonStore under ~/.vex/extensions/<feature>/ */
export function createExtensionStore<T extends Record<string, unknown>>(featureName: string): JsonStore<T> {
  const baseDir = join(homedir(), ".vex", "extensions", featureName);
  return new JsonStore<T>({ baseDir });
}
