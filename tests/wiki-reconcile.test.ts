import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WikiRepo } from "../src/vault/wiki/git.js";
import type { InFlightMarker } from "../src/vault/wiki/marker.js";
import { reconcile } from "../src/vault/wiki/reconcile.js";
import { emptyState, type WikiState } from "../src/vault/wiki/state.js";
import { commit, git, makeRemote } from "./helpers/gitRemote.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

let dir: string;
beforeEach(async () => {
  dir = await makeTmpDir();
});
afterEach(async () => {
  await removeTmpDir(dir);
});

interface Seeded {
  repo: WikiRepo;
  root: string;
  base: string;
}

async function seed(): Promise<Seeded> {
  const { remote, work } = makeRemote(join(dir, "seed"));
  commit(work, { "wiki/a.md": "v1" }, "2026-10-01T10:00:00+0000");
  const repo = new WikiRepo({ home: join(dir, "home"), url: remote, protocols: "file" });
  const root = await repo.open();
  return { repo, root, base: await repo.head() };
}

async function writeAndCommit(repo: WikiRepo, root: string, message: string, file = "wiki/a.md", text = "v2"): Promise<string> {
  writeFileSync(join(root, file), text);
  return repo.commit([file], message);
}

function batch(id: string, kind = "scheduled", scanBase: string | null = null, subject = "wiki: compile"): string {
  return `${subject}\n\nVex-Batch: ${id}\nVex-Kind: ${kind}\nVex-Scan-Base: ${scanBase ?? "none"}`;
}

function revert(id: string, batchId: string): string {
  return `wiki: rollback\n\nVex-Rollback: ${id}\nVex-Revert-Of: ${batchId}`;
}

function marker(batchId: string): InFlightMarker {
  return { batchId, kind: "scheduled", advancesScan: true, scanBase: null, baseHead: "deadbeef", phase: "writing", commit: null, touched: [] };
}

function state(overrides: Partial<WikiState> = {}): WikiState {
  return { ...emptyState(), ...overrides };
}

async function publish(repo: WikiRepo): Promise<void> {
  await repo.push();
  await repo.fetch();
}

describe("wiki history reconciliation", () => {
  describe("in-flight marker resolution", () => {
    it("treats a marker whose batch is committed as committed [Review Focus 1]", async () => {
      const { repo, root, base } = await seed();
      await writeAndCommit(repo, root, batch("b1", "scheduled", base));
      const result = await reconcile({ repo, state: null, marker: marker("b1"), bootstrapRef: null });
      expect(result.markerResolution).toBe("committed");
    });

    it("treats a marker with no matching commit as writing", async () => {
      const { repo } = await seed();
      const result = await reconcile({ repo, state: null, marker: marker("gone"), bootstrapRef: null });
      expect(result.markerResolution).toBe("writing");
    });

    it("reports no marker resolution when no marker is in flight", async () => {
      const { repo } = await seed();
      const result = await reconcile({ repo, state: null, marker: null, bootstrapRef: null });
      expect(result.markerResolution).toBe("none");
    });
  });

  it("never returns a rollback commit as lastBatchId", async () => {
    const { repo, root, base } = await seed();
    await writeAndCommit(repo, root, batch("b1", "scheduled", base));
    await writeAndCommit(repo, root, revert("rb1", "b1"), "wiki/a.md", "v1");
    const result = await reconcile({ repo, state: null, marker: null, bootstrapRef: null });
    expect(result.lastBatchId).toBeNull();
    expect(result.rollback).toEqual({ targetBatchId: "b1", revertId: "rb1" });
  });

  it("alerts on an orphan rollback relationship", async () => {
    const { repo, root } = await seed();
    await writeAndCommit(repo, root, revert("rb-orphan", "missing-batch"), "wiki/a.md", "v0");
    const result = await reconcile({ repo, state: null, marker: null, bootstrapRef: null });
    expect(result.rollback).toBeNull();
    expect(result.alerts.join(" ")).toMatch(/invalid rollback relationship/i);
  });

  it("keeps bootstrap done for an empty/no-output run with the ref", async () => {
    const { repo, base } = await seed();
    const result = await reconcile({ repo, state: null, marker: null, bootstrapRef: base });
    expect(result.bootstrap).toBe("done");
  });

  it("keeps a reverted batch out of scan regeneration [Review Focus 5]", async () => {
    const { repo, root, base } = await seed();
    const s1 = await writeAndCommit(repo, root, "wiki: notes", "wiki/b.md", "n1");
    await publish(repo);
    await writeAndCommit(repo, root, batch("b1", "scheduled", s1));
    await publish(repo);
    await writeAndCommit(repo, root, revert("rb1", "b1"), "wiki/a.md", "v1");
    const result = await reconcile({ repo, state: state({ lastScanCommit: base }), marker: null, bootstrapRef: null });
    expect(result.lastScanCommit).toBe(s1);
    expect(result.lastBatchId).toBeNull();
  });

  it("keeps state cursor when candidates are incomparable", async () => {
    const { repo, root, base } = await seed();
    const x = await writeAndCommit(repo, root, "wiki: notes x", "wiki/b.md", "x");
    await publish(repo);
    git(root, ["checkout", "-q", "-b", "other", base]);
    writeFileSync(join(root, "wiki/c.md"), "y");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "other"]);
    const y = git(root, ["rev-parse", "HEAD"]).trim();
    git(root, ["checkout", "-q", "main"]);
    await writeAndCommit(repo, root, batch("b1", "scheduled", y));
    await publish(repo);
    const result = await reconcile({ repo, state: state({ lastScanCommit: x }), marker: null, bootstrapRef: null });
    expect(result.lastScanCommit).toBe(x);
    expect(result.alerts.length).toBeGreaterThan(0);
  });

  it("drops an unresolvable state cursor in favour of a published scan base", async () => {
    const { repo, root } = await seed();
    const s1 = await writeAndCommit(repo, root, "wiki: notes", "wiki/b.md", "n1");
    await publish(repo);
    await writeAndCommit(repo, root, batch("b1", "scheduled", s1));
    await publish(repo);
    const result = await reconcile({ repo, state: state({ lastScanCommit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" }), marker: null, bootstrapRef: null });
    expect(result.lastScanCommit).toBe(s1);
  });

  it("falls back to a full scan when an unresolvable state cursor has no published candidate", async () => {
    const { repo } = await seed();
    const result = await reconcile({ repo, state: state({ lastScanCommit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" }), marker: null, bootstrapRef: null });
    expect(result.lastScanCommit).toBeNull();
  });

  it("recovers a revert committed before the state write [Review Focus 5]", async () => {
    const { repo, root, base } = await seed();
    await writeAndCommit(repo, root, batch("b1", "scheduled", base));
    await publish(repo);
    await writeAndCommit(repo, root, revert("rb1", "b1"), "wiki/a.md", "v1");
    const lost = await reconcile({ repo, state: null, marker: null, bootstrapRef: null });
    expect(lost.rollback).toEqual({ targetBatchId: "b1", revertId: "rb1" });
    const partial = await reconcile({ repo, state: state({ lastBatchId: "b1" }), marker: null, bootstrapRef: null });
    expect(partial.rollback).toEqual({ targetBatchId: "b1", revertId: "rb1" });
  });
});
