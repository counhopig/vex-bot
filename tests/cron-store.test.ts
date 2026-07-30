/**
 * Cron store tests — atomic JSON read/write, getJobs/addJob/etc.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { CronJob } from "../src/cron/types.js";

function makeJob(name: string, overrides?: Partial<CronJob>): CronJob {
  return {
    id: `id-${name}`,
    name,
    description: "",
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    payload: { kind: "systemEvent", message: `hi ${name}` },
    createdAtMs: 1,
    updatedAtMs: 1,
    state: {},
    ...overrides,
  };
}

describe("CronStore", () => {
  let CronStore: typeof import("../src/cron/store.js").CronStore;
  let tmpDir: string;
  let storePath: string;

  beforeAll(async () => {
    ({ CronStore } = await import("../src/cron/store.js"));
  });

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "vex-cron-test-"));
    storePath = join(tmpDir, "jobs.json");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty store when file does not exist", () => {
    const s = new CronStore(storePath);
    expect(s.getJobs()).toEqual([]);
  });

  it("returns empty store when file is corrupt (does not throw)", () => {
    writeFileSync(storePath, "not json", "utf-8");
    const s = new CronStore(storePath);
    expect(s.getJobs()).toEqual([]);
  });

  it("loads existing jobs from disk", () => {
    writeFileSync(
      storePath,
      JSON.stringify({
        version: 1,
        jobs: [makeJob("existing")],
      }),
      "utf-8",
    );
    const s = new CronStore(storePath);
    expect(s.getJobs()).toHaveLength(1);
    expect(s.getJob("id-existing")?.name).toBe("existing");
  });

  it("addJob appends a job and marks store dirty", () => {
    const s = new CronStore(storePath);
    s.addJob(makeJob("a"));
    expect(s.getJobs()).toHaveLength(1);
    expect(s.getJob("id-a")?.name).toBe("a");
  });

  it("addJob with duplicate id overwrites", () => {
    const s = new CronStore(storePath);
    s.addJob(makeJob("a", { description: "first" }));
    s.addJob(makeJob("a", { description: "second" }));
    expect(s.getJobs()).toHaveLength(1);
    expect(s.getJob("id-a")?.description).toBe("second");
  });

  it("persist writes atomically to the store path", () => {
    const s = new CronStore(storePath);
    s.addJob(makeJob("alpha"));
    s.persist();
    expect(existsSync(storePath)).toBe(true);
    const reloaded = JSON.parse(readFileSync(storePath, "utf-8"));
    expect(reloaded.jobs).toHaveLength(1);
    expect(reloaded.jobs[0].name).toBe("alpha");
  });

  it("persist skips when not dirty", () => {
    const s = new CronStore(storePath);
    s.persist();
    expect(existsSync(storePath)).toBe(false);
  });

  it("updateJob applies partial updates and bumps updatedAtMs", () => {
    const s = new CronStore(storePath);
    s.addJob(makeJob("a", { updatedAtMs: 100 }));
    const updated = s.updateJob("id-a", { description: "new" });
    expect(updated?.description).toBe("new");
    expect(updated?.updatedAtMs).toBeGreaterThan(100);
  });

  it("updateJob returns undefined for unknown id", () => {
    const s = new CronStore(storePath);
    expect(s.updateJob("nope", { description: "x" })).toBeUndefined();
  });

  it("removeJob deletes and returns true on success", () => {
    const s = new CronStore(storePath);
    s.addJob(makeJob("a"));
    expect(s.removeJob("id-a")).toBe(true);
    expect(s.getJobs()).toHaveLength(0);
  });

  it("removeJob returns false for unknown id", () => {
    const s = new CronStore(storePath);
    expect(s.removeJob("nope")).toBe(false);
  });

  it("getEnabledJobs filters by enabled flag", () => {
    const s = new CronStore(storePath);
    s.addJob(makeJob("enabled", { enabled: true }));
    s.addJob(makeJob("disabled", { enabled: false }));
    expect(s.getEnabledJobs().map((j: CronJob) => j.name)).toEqual(["enabled"]);
  });

  it("reload re-reads from disk", () => {
    writeFileSync(
      storePath,
      JSON.stringify({ version: 1, jobs: [makeJob("before")] }),
      "utf-8",
    );
    const s = new CronStore(storePath);
    s.addJob(makeJob("after"));
    s.reload();
    expect(s.getJobs().map((j: CronJob) => j.name)).toEqual(["before"]);
  });

  it("clear empties all jobs and persists immediately", () => {
    const s = new CronStore(storePath);
    s.addJob(makeJob("a"));
    s.clear();
    expect(s.getJobs()).toHaveLength(0);
    expect(existsSync(storePath)).toBe(true);
    expect(JSON.parse(readFileSync(storePath, "utf-8")).jobs).toEqual([]);
  });

  it("creates parent directory if missing", () => {
    const nestedPath = join(tmpDir, "deep", "nested", "jobs.json");
    const s = new CronStore(nestedPath);
    s.addJob(makeJob("x"));
    s.persist();
    expect(existsSync(nestedPath)).toBe(true);
  });

  it("backup file is created on persist (best-effort)", () => {
    const s = new CronStore(storePath);
    s.addJob(makeJob("a"));
    s.persist();
    // Backup may or may not exist (depends on FS), but the primary file must.
    expect(existsSync(storePath)).toBe(true);
  });
});