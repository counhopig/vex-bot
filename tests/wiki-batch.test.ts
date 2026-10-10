import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { abortBatch, ingestMessage, ingestPrompt, inspectAndCleanTree } from "../src/wiki/batch.js";
import { WikiRepo } from "../src/wiki/git.js";
import { MarkerStore, type FileFingerprint, type InFlightMarker, type TouchedPath } from "../src/wiki/marker.js";
import { commit, makeRemote } from "./helpers/gitRemote.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

let dir: string;
beforeEach(async () => {
  dir = await makeTmpDir();
});
afterEach(async () => {
  await removeTmpDir(dir);
});

function fileHash(text: string): FileFingerprint {
  return { type: "file", hash: createHash("sha256").update(text).digest("hex") };
}

function write(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

async function setup(files: Record<string, string>): Promise<{ repo: WikiRepo; root: string; marker: MarkerStore }> {
  const { remote, work } = makeRemote(join(dir, "seed"));
  commit(work, files, "2026-10-01T10:00:00+0000");
  const repo = new WikiRepo({ home: join(dir, "home"), url: remote, protocols: "file" });
  const root = await repo.open();
  return { repo, root, marker: new MarkerStore(join(root, ".git")) };
}

function writingMarker(baseHead: string, touched: TouchedPath[]): InFlightMarker {
  return { batchId: "b1", kind: "scheduled", advancesScan: true, scanBase: null, baseHead, phase: "writing", commit: null, touched };
}

describe("ingestMessage", () => {
  it("names the batch, kind and scan base", () => {
    const message = ingestMessage("scheduled", "batch-1", "abc123", 3, new Date("2026-10-09T12:34:56.000Z"));
    expect(message).toContain("Vex-Batch: batch-1");
    expect(message).toContain("Vex-Kind: scheduled");
    expect(message).toContain("Vex-Scan-Base: abc123");
    expect(message).toContain("2026-10-09T12:34:56.000Z");
    expect(message).toContain("(3 notes)");
  });

  it("marks a null scan base as none", () => {
    expect(ingestMessage("bootstrap", "b", null, 1, new Date())).toContain("Vex-Scan-Base: none");
  });
});

describe("ingestPrompt", () => {
  it("names the kind and constrains writes to wiki/ and raw/", () => {
    const prompt = ingestPrompt("on-demand");
    expect(prompt).toContain("on-demand");
    expect(prompt).toContain("_index.md");
    expect(prompt).toContain("wiki/");
    expect(prompt).toContain("raw/");
  });
});

describe("inspectAndCleanTree", () => {
  it("removes a new file written twice during crash recovery", async () => {
    const { repo, root, marker } = await setup({ "notes/a.md": "source" });
    const base = await repo.head();
    write(join(root, "wiki", "new.md"), "n2");
    await marker.begin(writingMarker(base, [{ path: "wiki/new.md", expectedBefore: fileHash("n1"), after: fileHash("n2") }]));
    await inspectAndCleanTree(repo, marker);
    expect(existsSync(join(root, "wiki", "new.md"))).toBe(false);
    expect(await repo.status()).toEqual([]);
  });

  it("throws when a path outside wiki/ and raw/ is dirty", async () => {
    const { repo, root, marker } = await setup({ "wiki/a.md": "v1" });
    write(join(root, "notes", "x.md"), "dirty");
    await expect(inspectAndCleanTree(repo, marker)).rejects.toThrow("changes outside wiki/ and raw/");
  });

  it("restores an attributable writing-phase touched path to baseHead", async () => {
    const { repo, root, marker } = await setup({ "wiki/a.md": "v1" });
    const base = await repo.head();
    write(join(root, "wiki", "a.md"), "v2");
    await marker.begin(writingMarker(base, [{ path: "wiki/a.md", expectedBefore: fileHash("v1"), after: fileHash("v2") }]));
    await inspectAndCleanTree(repo, marker);
    expect(readFileSync(join(root, "wiki", "a.md"), "utf8")).toBe("v1");
    expect(await repo.status()).toEqual([]);
  });

  it("keeps the tree untouched when no writing marker exists", async () => {
    const { repo, root, marker } = await setup({ "wiki/a.md": "v1" });
    write(join(root, "wiki", "a.md"), "v2");
    await expect(inspectAndCleanTree(repo, marker)).rejects.toThrow();
    expect(readFileSync(join(root, "wiki", "a.md"), "utf8")).toBe("v2");
  });

  it("throws when the touched file was modified after the recorded after", async () => {
    const { repo, root, marker } = await setup({ "wiki/a.md": "v1" });
    const base = await repo.head();
    write(join(root, "wiki", "a.md"), "v2");
    await marker.begin(writingMarker(base, [{ path: "wiki/a.md", expectedBefore: fileHash("v1"), after: fileHash("v2") }]));
    write(join(root, "wiki", "a.md"), "external");
    await expect(inspectAndCleanTree(repo, marker)).rejects.toThrow();
    expect(readFileSync(join(root, "wiki", "a.md"), "utf8")).toBe("external");
  });

  it("refuses cleanup of a touched path alongside an unknown dirty path and retains marker", async () => {
    const { repo, root, marker } = await setup({ "wiki/a.md": "v1" });
    const base = await repo.head();
    write(join(root, "wiki", "a.md"), "v2");
    write(join(root, "wiki", "owner.md"), "owner");
    await marker.begin(writingMarker(base, [{ path: "wiki/a.md", expectedBefore: fileHash("v1"), after: fileHash("v2") }]));
    await expect(inspectAndCleanTree(repo, marker)).rejects.toThrow();
    expect(readFileSync(join(root, "wiki", "a.md"), "utf8")).toBe("v2");
    expect(readFileSync(join(root, "wiki", "owner.md"), "utf8")).toBe("owner");
    expect(await marker.read()).not.toBeNull();
  });

  it("rejects staged unknown paths", async () => {
    const { repo, root, marker } = await setup({ "wiki/a.md": "v1", "notes/n.md": "n" });
    write(join(root, "wiki", "a.md"), "v2");
    write(join(root, "notes", "n.md"), "staged");
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["add", "notes/n.md"], { cwd: root });
    await marker.begin(writingMarker(await repo.head(), [{ path: "wiki/a.md", expectedBefore: fileHash("v1"), after: fileHash("v2") }]));
    await expect(inspectAndCleanTree(repo, marker)).rejects.toThrow();
    expect(readFileSync(join(root, "notes", "n.md"), "utf8")).toBe("staged");
    expect(await marker.read()).not.toBeNull();
  });

  it("preserves a touched path's external staged bytes during crash cleanup", async () => {
    const { repo, root, marker } = await setup({ "wiki/a.md": "v1" });
    const base = await repo.head();
    const target = join(root, "wiki", "a.md");
    write(target, "v2");
    await marker.begin(writingMarker(base, [{ path: "wiki/a.md", expectedBefore: fileHash("v1"), after: fileHash("v2") }]));
    write(target, "staged owner bytes");
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["add", "--", "wiki/a.md"], { cwd: root });
    write(target, "v2");

    await expect(inspectAndCleanTree(repo, marker)).rejects.toThrow(/index content does not match/i);

    expect(readFileSync(target, "utf8")).toBe("v2");
    expect(execFileSync("git", ["show", ":wiki/a.md"], { cwd: root, encoding: "utf8" })).toBe("staged owner bytes");
    expect(await marker.read()).not.toBeNull();
  });
});

describe("abortBatch", () => {
  it("preserves files and marker when the baseline revision cannot be read", async () => {
    const { repo, root, marker } = await setup({ "notes/a.md": "source" });
    write(join(root, "wiki", "new.md"), "new");
    await marker.begin(writingMarker("missing-revision", [{ path: "wiki/new.md", expectedBefore: { type: "absent", hash: null }, after: fileHash("new") }]));
    await expect(abortBatch(repo, marker)).rejects.toThrow();
    expect(readFileSync(join(root, "wiki", "new.md"), "utf8")).toBe("new");
    expect(await marker.read()).not.toBeNull();
  });

  it("preserves every path and marker when any dirty path is not attributable", async () => {
    const { repo, root, marker } = await setup({ "wiki/a.md": "v1", "wiki/b.md": "b1" });
    const base = await repo.head();
    write(join(root, "wiki", "a.md"), "a2");
    write(join(root, "wiki", "b.md"), "b2");
    write(join(root, "wiki", "new.md"), "new");
    await marker.begin(
      writingMarker(base, [
        { path: "wiki/a.md", expectedBefore: fileHash("v1"), after: fileHash("a2") },
        { path: "wiki/new.md", expectedBefore: { type: "absent", hash: null }, after: fileHash("new") },
      ]),
    );
    await expect(abortBatch(repo, marker)).rejects.toThrow();
    expect(readFileSync(join(root, "wiki", "a.md"), "utf8")).toBe("a2");
    expect(readFileSync(join(root, "wiki", "b.md"), "utf8")).toBe("b2");
    expect(existsSync(join(root, "wiki", "new.md"))).toBe(true);
    expect(await marker.read()).not.toBeNull();
  });

  it("preserves an externally modified touched path and retains the marker", async () => {
    const { repo, root, marker } = await setup({ "wiki/a.md": "v1" });
    const base = await repo.head();
    write(join(root, "wiki", "a.md"), "v2");
    await marker.begin(writingMarker(base, [{ path: "wiki/a.md", expectedBefore: fileHash("v1"), after: fileHash("v2") }]));
    write(join(root, "wiki", "a.md"), "external");
    await expect(abortBatch(repo, marker)).rejects.toThrow();
    expect(readFileSync(join(root, "wiki", "a.md"), "utf8")).toBe("external");
    expect(await marker.read()).not.toBeNull();
  });

  it("removes a new file even when a later write recorded a file baseline", async () => {
    const { repo, root, marker } = await setup({ "wiki/a.md": "v1" });
    const base = await repo.head();
    write(join(root, "wiki", "new.md"), "n2");
    // A second write to a brand-new file records `expectedBefore: file`, even though it did not
    // exist at baseHead; restore must still treat it as untracked and delete it.
    await marker.begin(writingMarker(base, [{ path: "wiki/new.md", expectedBefore: fileHash("n1"), after: fileHash("n2") }]));
    await abortBatch(repo, marker);
    expect(existsSync(join(root, "wiki", "new.md"))).toBe(false);
    expect(await repo.status()).toEqual([]);
  });

  it("does nothing when no marker exists", async () => {
    const { repo, root, marker } = await setup({ "wiki/a.md": "v1" });
    write(join(root, "wiki", "a.md"), "v2");
    await abortBatch(repo, marker);
    expect(readFileSync(join(root, "wiki", "a.md"), "utf8")).toBe("v2");
  });

  it("refuses a committed marker without restoring or removing it", async () => {
    const { repo, root, marker } = await setup({ "wiki/a.md": "v1" });
    const base = await repo.head();
    write(join(root, "wiki", "a.md"), "v2");
    await marker.begin({ ...writingMarker(base, [{ path: "wiki/a.md", expectedBefore: fileHash("v1"), after: fileHash("v2") }]), phase: "committed", commit: base });
    await expect(abortBatch(repo, marker)).rejects.toThrow();
    expect(readFileSync(join(root, "wiki", "a.md"), "utf8")).toBe("v2");
    expect((await marker.read())?.phase).toBe("committed");
  });

  it("retains all files and marker when one intent has no after fingerprint", async () => {
    const { repo, root, marker } = await setup({ "wiki/a.md": "v1" });
    const base = await repo.head();
    write(join(root, "wiki", "a.md"), "v2");
    write(join(root, "wiki", "b.md"), "partial");
    await marker.begin(writingMarker(base, [
      { path: "wiki/a.md", expectedBefore: fileHash("v1"), after: fileHash("v2") },
      { path: "wiki/b.md", expectedBefore: { type: "absent", hash: null } },
    ]));
    await expect(abortBatch(repo, marker)).rejects.toThrow();
    expect(readFileSync(join(root, "wiki", "a.md"), "utf8")).toBe("v2");
    expect(readFileSync(join(root, "wiki", "b.md"), "utf8")).toBe("partial");
    expect(await marker.read()).not.toBeNull();
  });

  it("preserves a touched path's external staged bytes during abort", async () => {
    const { repo, root, marker } = await setup({ "wiki/a.md": "v1" });
    const base = await repo.head();
    const target = join(root, "wiki", "a.md");
    write(target, "v2");
    await marker.begin(writingMarker(base, [{ path: "wiki/a.md", expectedBefore: fileHash("v1"), after: fileHash("v2") }]));
    write(target, "staged owner bytes");
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["add", "--", "wiki/a.md"], { cwd: root });
    write(target, "v2");

    await expect(abortBatch(repo, marker)).rejects.toThrow(/index content does not match/i);

    expect(readFileSync(target, "utf8")).toBe("v2");
    expect(execFileSync("git", ["show", ":wiki/a.md"], { cwd: root, encoding: "utf8" })).toBe("staged owner bytes");
    expect(await marker.read()).not.toBeNull();
  });
});
