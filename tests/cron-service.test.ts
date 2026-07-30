/**
 * CronService tests — scheduling loop, add/update/remove/run, ownerId-aware.
 *
 * The service is class-based (not a singleton). We inject `nowMs` for
 * deterministic testing, and `executeJob` is a mock callback so no
 * real agent dispatch happens.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { CronJob, CronEvent } from "../src/cron/types.js";

describe("CronService", () => {
  let CronService: typeof import("../src/cron/service.js").CronService;
  let tmpDir: string;
  let storePath: string;

  beforeAll(async () => {
    ({ CronService } = await import("../src/cron/service.js"));
  });

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "vex-cron-svc-"));
    storePath = join(tmpDir, "jobs.json");
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeSvc(opts?: {
    nowMs?: number;
    executeJob?: any;
    onEvent?: (e: CronEvent) => void;
  }) {
    return new CronService({
      storePath,
      nowMs: opts?.nowMs ?? (() => Date.now()),
      executeJob:
        opts?.executeJob ?? (async () => ({ status: "ok" as const })),
      onEvent: opts?.onEvent ?? (() => {}),
    });
  }

  describe("addJob", () => {
    it("creates a job with computed nextRunAtMs and persists", () => {
      const svc = makeSvc({ nowMs: () => 1000 });
      const job = svc.add({
        name: "nightly",
        schedule: { kind: "every", everyMs: 86_400_000 },
        payload: { kind: "systemEvent", message: "tick" },
      });

      expect(job.id).toBeDefined();
      expect(job.state.nextRunAtMs).toBeGreaterThan(1000);
      // Re-instantiate and verify persisted state survives.
      const svc2 = makeSvc({ nowMs: () => 5000 });
      const loaded = svc2.get(job.id);
      expect(loaded?.name).toBe("nightly");
    });

    it("rejects duplicate names", () => {
      const svc = makeSvc({ nowMs: () => 1000 });
      svc.add({
        name: "dup",
        schedule: { kind: "every", everyMs: 60_000 },
        payload: { kind: "systemEvent", message: "x" },
      });
      expect(() =>
        svc.add({
          name: "dup",
          schedule: { kind: "every", everyMs: 60_000 },
          payload: { kind: "systemEvent", message: "y" },
        }),
      ).toThrow(/already exists/);
    });
  });

  describe("updateJob / removeJob", () => {
    it("update applies patch and recomputes nextRunAtMs", () => {
      const svc = makeSvc({ nowMs: () => 1000 });
      const job = svc.add({
        name: "x",
        schedule: { kind: "every", everyMs: 60_000 },
        payload: { kind: "systemEvent", message: "x" },
      });
      const originalNext = job.state.nextRunAtMs;
      const updated = svc.update(job.id, {
        description: "new",
        schedule: { kind: "every", everyMs: 30_000 },
      });
      expect(updated?.description).toBe("new");
      // nextRunAtMs must change because everyMs changed from 60s to 30s.
      expect(updated?.state.nextRunAtMs).not.toBe(originalNext);
    });

    it("update returns undefined for unknown id", () => {
      const svc = makeSvc();
      expect(svc.update("nope", { description: "x" })).toBeUndefined();
    });

    it("remove deletes the job and returns true", () => {
      const svc = makeSvc();
      const job = svc.add({
        name: "x",
        schedule: { kind: "every", everyMs: 60_000 },
        payload: { kind: "systemEvent", message: "x" },
      });
      expect(svc.remove(job.id)).toBe(true);
      expect(svc.get(job.id)).toBeUndefined();
    });

    it("remove returns false for unknown id", () => {
      const svc = makeSvc();
      expect(svc.remove("nope")).toBe(false);
    });
  });

  describe("ownerId", () => {
    it("persists ownerId when provided in create input", () => {
      const svc = makeSvc();
      const job = svc.add({
        name: "per-user",
        ownerId: "user-42",
        schedule: { kind: "every", everyMs: 60_000 },
        payload: { kind: "systemEvent", message: "x" },
      });
      expect(job.ownerId).toBe("user-42");
    });
  });

  describe("list", () => {
    it("returns enabled jobs sorted by nextRunAtMs", () => {
      const svc = makeSvc({ nowMs: () => 1000 });
      svc.add({
        name: "later",
        schedule: { kind: "every", everyMs: 60_000 },
        payload: { kind: "systemEvent", message: "l" },
      });
      svc.add({
        name: "sooner",
        schedule: { kind: "every", everyMs: 30_000 },
        payload: { kind: "systemEvent", message: "s" },
      });
      const names = svc.list().map((j: CronJob) => j.name);
      expect(names[0]).toBe("sooner");
      expect(names[1]).toBe("later");
    });
  });

  describe("run (manual)", () => {
    it("executes the job synchronously and returns ok", async () => {
      const svc = makeSvc({
        executeJob: async () => ({ status: "ok" as const, summary: "done" }),
      });
      const job = svc.add({
        name: "x",
        schedule: { kind: "every", everyMs: 60_000 },
        payload: { kind: "systemEvent", message: "x" },
      });
      const r = await svc.run(job.id);
      expect(r.status).toBe("ok");
      expect(r.summary).toBe("done");
    });

    it("returns not_found for unknown id", async () => {
      const svc = makeSvc();
      const r = await svc.run("nope");
      expect(r.status).toBe("not_found");
    });

    it("skips if already running", async () => {
      const svc = makeSvc({
        executeJob: () => new Promise(() => {}), // never resolves
      });
      const job = svc.add({
        name: "x",
        schedule: { kind: "every", everyMs: 60_000 },
        payload: { kind: "systemEvent", message: "x" },
      });
      const first = svc.run(job.id);
      const second = await svc.run(job.id);
      expect(second.status).toBe("skipped");
      // Resolve the hanging first so afterEach cleanup doesn't leak.
      void first;
    });
  });

  describe("execute timeout", () => {
    it("returns error when executeJob exceeds defaultJobTimeoutMs", async () => {
      vi.useRealTimers();
      const svc = new CronService({
        storePath,
        nowMs: () => Date.now(),
        executeJob: () => new Promise(() => {}), // hangs forever
        defaultJobTimeoutMs: 50,
      });
      const job = svc.add({
        name: "hangs",
        schedule: { kind: "every", everyMs: 60_000 },
        payload: { kind: "systemEvent", message: "x" },
      });
      const r = await svc.run(job.id);
      expect(r.status).toBe("error");
      expect(r.error).toContain("timed out");
    });
  });

  describe("one-time at-jobs", () => {
    it("disable on first successful run (without deleteAfterRun)", async () => {
      const svc = makeSvc({
        nowMs: () => 1000,
        executeJob: async () => ({ status: "ok" as const }),
      });
      const job = svc.add({
        name: "one-shot",
        schedule: { kind: "at", atMs: 2000 },
        payload: { kind: "systemEvent", message: "x" },
      });
      await svc.run(job.id);
      const after = svc.get(job.id);
      expect(after?.enabled).toBe(false);
    });

    it("delete on first successful run when deleteAfterRun", async () => {
      const svc = makeSvc({
        nowMs: () => 1000,
        executeJob: async () => ({ status: "ok" as const }),
      });
      const job = svc.add({
        name: "one-shot-del",
        deleteAfterRun: true,
        schedule: { kind: "at", atMs: 2000 },
        payload: { kind: "systemEvent", message: "x" },
      });
      await svc.run(job.id);
      expect(svc.get(job.id)).toBeUndefined();
    });

    it("does NOT disable on error (re-armed for next run)", async () => {
      const svc = makeSvc({
        nowMs: () => 1000,
        executeJob: async () => ({ status: "error" as const, error: "boom" }),
      });
      const job = svc.add({
        name: "one-shot-err",
        schedule: { kind: "at", atMs: 2000 },
        payload: { kind: "systemEvent", message: "x" },
      });
      await svc.run(job.id);
      const after = svc.get(job.id);
      expect(after?.enabled).toBe(true);
    });
  });

  describe("missed at-jobs on start", () => {
    it("disables one-time jobs whose atMs has passed during downtime", () => {
      const svc = makeSvc({ nowMs: () => 5000 });
      svc.store.addJob({
        id: "missed",
        name: "missed",
        enabled: true,
        schedule: { kind: "at", atMs: 1000 },
        payload: { kind: "systemEvent", message: "x" },
        createdAtMs: 500,
        updatedAtMs: 500,
        state: {},
      });
      svc.start();
      const after = svc.get("missed");
      expect(after?.enabled).toBe(false);
    });
  });

  describe("independent instances", () => {
    it("two CronService instances do not share jobs", () => {
      const a = makeSvc();
      const b = makeSvc();
      a.add({
        name: "only-a",
        schedule: { kind: "every", everyMs: 60_000 },
        payload: { kind: "systemEvent", message: "x" },
      });
      expect(a.getAll()).toHaveLength(1);
      expect(b.getAll()).toHaveLength(0);
    });
  });
});