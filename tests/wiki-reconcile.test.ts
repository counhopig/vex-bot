import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WikiRepo } from "../src/vault/wiki/git.js";
import type { InFlightMarker } from "../src/vault/wiki/marker.js";
import { reconcile } from "../src/vault/wiki/reconcile.js";
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
  mkdirSync(dirname(join(root, file)), { recursive: true });
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
  return { batchId, kind: "scheduled", scanBase: null, baseHead: "deadbeef", touched: [] };
}

async function publish(repo: WikiRepo): Promise<void> {
  await repo.push();
  await repo.fetch();
}

describe("wiki history reconciliation", () => {
  describe("in-flight marker staleness", () => {
    it("treats a marker whose batch is committed as stale", async () => {
      const { repo, root, base } = await seed();
      await writeAndCommit(repo, root, batch("b1", "scheduled", base));
      const result = await reconcile({ repo, marker: marker("b1"), bootstrapRef: null });
      expect(result.staleMarker).toBe(true);
    });

    it("treats a marker with no matching commit as not stale", async () => {
      const { repo } = await seed();
      const result = await reconcile({ repo, marker: marker("gone"), bootstrapRef: null });
      expect(result.staleMarker).toBe(false);
    });

    it("reports no staleness when no marker is in flight", async () => {
      const { repo } = await seed();
      const result = await reconcile({ repo, marker: null, bootstrapRef: null });
      expect(result.staleMarker).toBe(false);
    });
  });

  it("never returns a rollback commit as lastBatchId", async () => {
    const { repo, root, base } = await seed();
    await writeAndCommit(repo, root, batch("b1", "scheduled", base));
    await writeAndCommit(repo, root, revert("rb1", "b1"), "wiki/a.md", "v1");
    const result = await reconcile({ repo, marker: null, bootstrapRef: null });
    expect(result.lastBatchId).toBeNull();
    expect(result.rollback).toEqual({ targetBatchId: "b1", revertId: "rb1" });
  });

  it("alerts on an orphan rollback relationship", async () => {
    const { repo, root } = await seed();
    await writeAndCommit(repo, root, revert("rb-orphan", "missing-batch"), "wiki/a.md", "v0");
    const result = await reconcile({ repo, marker: null, bootstrapRef: null });
    expect(result.rollback).toBeNull();
    expect(result.alerts.join(" ")).toMatch(/invalid rollback relationship/i);
  });

  it("keeps bootstrap done for an empty/no-output run with the ref", async () => {
    const { repo, base } = await seed();
    const result = await reconcile({ repo, marker: null, bootstrapRef: base });
    expect(result.bootstrap).toBe("done");
  });

  it("marks bootstrap done from a published bootstrap batch without a ref", async () => {
    const { repo, root, base } = await seed();
    await writeAndCommit(repo, root, batch("boot", "bootstrap", base));
    await publish(repo);
    const result = await reconcile({ repo, marker: null, bootstrapRef: null });
    expect(result.bootstrap).toBe("done");
  });

  it("keeps bootstrap pending behind the newest reset without post-reset evidence", async () => {
    const { repo, root, base } = await seed();
    await writeAndCommit(repo, root, batch("boot", "bootstrap", base));
    const { commit: resetSha } = await repo.commitWikiRemoval("wiki: rebuild\n\nVex-Wiki-Reset: r1");
    await publish(repo);
    const result = await reconcile({ repo, marker: null, bootstrapRef: null });
    expect(result.bootstrap).toBe("pending");
    expect(result.reset).toEqual({ id: "r1", sha: resetSha });
  });

  it("keeps a reverted batch out of scan regeneration", async () => {
    const { repo, root, base } = await seed();
    const s1 = await writeAndCommit(repo, root, "wiki: notes", "wiki/b.md", "n1");
    await publish(repo);
    await writeAndCommit(repo, root, batch("b1", "scheduled", s1));
    await publish(repo);
    await writeAndCommit(repo, root, revert("rb1", "b1"), "wiki/a.md", "v1");
    const result = await reconcile({ repo, marker: null, bootstrapRef: null });
    expect(result.lastScanCommit).toBe(s1);
    expect(result.lastBatchId).toBeNull();
  });

  it("ignores a published batch whose scan base does not resolve", async () => {
    const { repo, root } = await seed();
    const s1 = await writeAndCommit(repo, root, "wiki: notes", "wiki/b.md", "n1");
    await publish(repo);
    await writeAndCommit(repo, root, batch("b1", "scheduled", s1));
    await writeAndCommit(repo, root, batch("b2", "scheduled", "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"), "wiki/c.md", "c");
    await publish(repo);
    const result = await reconcile({ repo, marker: null, bootstrapRef: null });
    expect(result.lastScanCommit).toBe(s1);
  });

  it("falls back to a full scan when no published batch carries a scan base", async () => {
    const { repo } = await seed();
    const result = await reconcile({ repo, marker: null, bootstrapRef: null });
    expect(result.lastScanCommit).toBeNull();
  });

  it("recovers a revert committed without any durable record", async () => {
    const { repo, root, base } = await seed();
    await writeAndCommit(repo, root, batch("b1", "scheduled", base));
    await publish(repo);
    await writeAndCommit(repo, root, revert("rb1", "b1"), "wiki/a.md", "v1");
    const result = await reconcile({ repo, marker: null, bootstrapRef: null });
    expect(result.rollback).toEqual({ targetBatchId: "b1", revertId: "rb1" });
  });

  describe("rebuild epochs", () => {
    it("ignores batches and the published bootstrap behind the newest reset", async () => {
      const { repo, root, base } = await seed();
      const bootstrapSha = await writeAndCommit(repo, root, batch("boot", "bootstrap", base));
      await writeAndCommit(repo, root, batch("s1", "scheduled", bootstrapSha), "wiki/b.md", "b");
      await publish(repo);
      const before = await reconcile({ repo, marker: null, bootstrapRef: bootstrapSha });
      expect(before).toMatchObject({ bootstrap: "done", lastBatchId: "s1", reset: null });

      const { commit: resetSha } = await repo.commitWikiRemoval("wiki: rebuild\n\nVex-Wiki-Reset: r1");
      await publish(repo);
      expect(await reconcile({ repo, marker: null, bootstrapRef: bootstrapSha })).toMatchObject({
        bootstrap: "pending", lastBatchId: null, lastScanCommit: null, preview: false, reset: { id: "r1", sha: resetSha },
      });

      const preview = await writeAndCommit(repo, root, batch("boot2", "bootstrap", resetSha, "wiki: bootstrap preview"), "wiki/c.md", "c");
      expect(await reconcile({ repo, marker: null, bootstrapRef: null })).toMatchObject({ bootstrap: "pending", lastBatchId: "boot2", preview: true });
      await publish(repo);
      expect(await reconcile({ repo, marker: null, bootstrapRef: null })).toMatchObject({ bootstrap: "done", lastBatchId: "boot2", lastScanCommit: resetSha });
      expect(await repo.isAncestor(resetSha, preview)).toBe(true);
    });

    it("keeps a bootstrap ref written after the reset", async () => {
      const { repo, root, base } = await seed();
      await writeAndCommit(repo, root, batch("boot", "bootstrap", base));
      const { commit: resetSha } = await repo.commitWikiRemoval("wiki: rebuild\n\nVex-Wiki-Reset: r1");
      await publish(repo);
      expect((await reconcile({ repo, marker: null, bootstrapRef: base })).bootstrap).toBe("pending");
      expect((await reconcile({ repo, marker: null, bootstrapRef: resetSha })).bootstrap).toBe("done");
    });
  });
});
