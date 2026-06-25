/**
 * Cron job storage
 *
 * Based on moltbot store.ts implementation
 * JSON file storage with atomic writes and backups
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import json5 from "json5";
import type { CronStoreFile, CronJob } from "./types.js";

/** Default Cron data directory */
const CRON_DATA_DIR = join(homedir(), ".vex", "cron");

/** Default store file path */
export const DEFAULT_CRON_STORE_PATH = join(CRON_DATA_DIR, "jobs.json");

/**
 * Load store file
 */
export function loadCronStore(storePath: string = DEFAULT_CRON_STORE_PATH): CronStoreFile {
  if (!existsSync(storePath)) {
    return { version: 1, jobs: [] };
  }

  try {
    const content = readFileSync(storePath, "utf-8");
    const data = json5.parse(content) as CronStoreFile;

    // Validate format
    if (!data.version || !Array.isArray(data.jobs)) {
      return { version: 1, jobs: [] };
    }

    return data;
  } catch {
    return { version: 1, jobs: [] };
  }
}

/**
 * Save store file (atomic write)
 */
export function saveCronStore(store: CronStoreFile, storePath: string = DEFAULT_CRON_STORE_PATH): void {
  const dir = dirname(storePath);
  mkdirSync(dir, { recursive: true });

  const content = JSON.stringify(store, null, 2);
  const tmpPath = `${storePath}.${process.pid}.${Date.now()}.tmp`;

  // Write to temp file
  writeFileSync(tmpPath, content, "utf-8");

  // Atomic rename
  renameSync(tmpPath, storePath);

  // Create backup (best-effort)
  try {
    copyFileSync(storePath, `${storePath}.bak`);
  } catch {
    // Ignore backup failures
  }
}

/**
 * Cron store manager
 */
export class CronStore {
  private storePath: string;
  private store: CronStoreFile;
  private dirty: boolean = false;

  constructor(storePath: string = DEFAULT_CRON_STORE_PATH) {
    this.storePath = storePath;
    this.store = loadCronStore(storePath);
  }

  /** Get all jobs */
  getJobs(): CronJob[] {
    return this.store.jobs;
  }

  /** Get single job */
  getJob(id: string): CronJob | undefined {
    return this.store.jobs.find(j => j.id === id);
  }

  /** Get job by name */
  getJobByName(name: string): CronJob | undefined {
    return this.store.jobs.find(j => j.name === name);
  }

  /** Get enabled jobs */
  getEnabledJobs(): CronJob[] {
    return this.store.jobs.filter(j => j.enabled);
  }

  /** Add job */
  addJob(job: CronJob): void {
    // Check for duplicate ID
    const existing = this.store.jobs.findIndex(j => j.id === job.id);
    if (existing >= 0) {
      this.store.jobs[existing] = job;
    } else {
      this.store.jobs.push(job);
    }
    this.dirty = true;
  }

  /** Update job */
  updateJob(id: string, updates: Partial<CronJob>): CronJob | undefined {
    const index = this.store.jobs.findIndex(j => j.id === id);
    if (index < 0) return undefined;

    const job = this.store.jobs[index]!;
    Object.assign(job, updates, { updatedAtMs: Date.now() });
    this.dirty = true;
    return job;
  }

  /** Delete job */
  removeJob(id: string): boolean {
    const index = this.store.jobs.findIndex(j => j.id === id);
    if (index < 0) return false;

    this.store.jobs.splice(index, 1);
    this.dirty = true;
    return true;
  }

  /** Persist (if dirty) */
  persist(): void {
    if (this.dirty) {
      saveCronStore(this.store, this.storePath);
      this.dirty = false;
    }
  }

  /** Force persist */
  forcePersist(): void {
    saveCronStore(this.store, this.storePath);
    this.dirty = false;
  }

  /** Reload */
  reload(): void {
    this.store = loadCronStore(this.storePath);
    this.dirty = false;
  }

  /** Clear all jobs */
  clear(): void {
    this.store.jobs = [];
    this.dirty = true;
    // Unlike addJob/updateJob/removeJob, clear indicates destructive intent, flush immediately to prevent data loss
    saveCronStore(this.store, this.storePath);
    this.dirty = false;
  }
}
