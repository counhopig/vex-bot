/**
 * Cron job storage — atomic JSON file.
 *
 * Ported from _archive/src/cron/store.ts but class-only (no singleton).
 * Uses plain JSON (not json5) since the file is internal and not
 * hand-edited.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  copyFileSync,
} from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import type { CronJob, CronStoreFile } from "./types.js";

/** Default Cron data directory: ~/.vex/cron/jobs.json. */
export const DEFAULT_CRON_STORE_PATH = join(homedir(), ".vex", "cron", "jobs.json");

/** Read store file from disk, returning empty on missing/corrupt file. */
export function loadCronStore(storePath: string = DEFAULT_CRON_STORE_PATH): CronStoreFile {
  if (!existsSync(storePath)) {
    return { version: 1, jobs: [] };
  }
  try {
    const content = readFileSync(storePath, "utf-8");
    const data = JSON.parse(content) as CronStoreFile;
    if (!data.version || !Array.isArray(data.jobs)) {
      return { version: 1, jobs: [] };
    }
    return data;
  } catch {
    return { version: 1, jobs: [] };
  }
}

/** Atomic write: temp file + rename + best-effort backup. */
export function saveCronStore(
  store: CronStoreFile,
  storePath: string = DEFAULT_CRON_STORE_PATH,
): void {
  mkdirSync(dirname(storePath), { recursive: true });

  const content = JSON.stringify(store, null, 2);
  const tmpPath = `${storePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, storePath);

  try {
    copyFileSync(storePath, `${storePath}.bak`);
  } catch {
    // Backup failures are best-effort.
  }
}

/** Cron store manager — owns the in-memory job list and dirty tracking. */
export class CronStore {
  private readonly storePath: string;
  private store: CronStoreFile;
  private dirty: boolean = false;

  constructor(storePath: string = DEFAULT_CRON_STORE_PATH) {
    this.storePath = storePath;
    this.store = loadCronStore(storePath);
  }

  getJobs(): CronJob[] {
    return this.store.jobs;
  }

  getJob(id: string): CronJob | undefined {
    return this.store.jobs.find((j) => j.id === id);
  }

  getJobByName(name: string): CronJob | undefined {
    return this.store.jobs.find((j) => j.name === name);
  }

  getEnabledJobs(): CronJob[] {
    return this.store.jobs.filter((j) => j.enabled);
  }

  addJob(job: CronJob): void {
    const existing = this.store.jobs.findIndex((j) => j.id === job.id);
    if (existing >= 0) {
      this.store.jobs[existing] = job;
    } else {
      this.store.jobs.push(job);
    }
    this.dirty = true;
  }

  updateJob(id: string, updates: Partial<CronJob>): CronJob | undefined {
    const index = this.store.jobs.findIndex((j) => j.id === id);
    if (index < 0) return undefined;
    const job = this.store.jobs[index]!;
    Object.assign(job, updates, { updatedAtMs: Date.now() });
    this.dirty = true;
    return job;
  }

  removeJob(id: string): boolean {
    const index = this.store.jobs.findIndex((j) => j.id === id);
    if (index < 0) return false;
    this.store.jobs.splice(index, 1);
    this.dirty = true;
    return true;
  }

  /** Persist if dirty. Skips silently when no writes happened. */
  persist(): void {
    if (this.dirty) {
      saveCronStore(this.store, this.storePath);
      this.dirty = false;
    }
  }

  forcePersist(): void {
    saveCronStore(this.store, this.storePath);
    this.dirty = false;
  }

  reload(): void {
    this.store = loadCronStore(this.storePath);
    this.dirty = false;
  }

  /** Clear all jobs and persist immediately (destructive intent). */
  clear(): void {
    this.store.jobs = [];
    saveCronStore(this.store, this.storePath);
    this.dirty = false;
  }
}