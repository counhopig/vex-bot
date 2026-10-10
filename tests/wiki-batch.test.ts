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
});

describe("abortBatch", () => {
  it("restores only the attributable touched paths and removes the marker", async () => {
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
    await abortBatch(repo, marker);
    expect(readFileSync(join(root, "wiki", "a.md"), "utf8")).toBe("v1");
    expect(readFileSync(join(root, "wiki", "b.md"), "utf8")).toBe("b2");
    expect(existsSync(join(root, "wiki", "new.md"))).toBe(false);
    expect(await repo.status()).toEqual([" M wiki/b.md"]);
    expect(await marker.read()).toBeNull();
  });

  it("keeps an externally modified touched path instead of overwriting it", async () => {
    const { repo, root, marker } = await setup({ "wiki/a.md": "v1" });
    const base = await repo.head();
    write(join(root, "wiki", "a.md"), "v2");
    await marker.begin(writingMarker(base, [{ path: "wiki/a.md", expectedBefore: fileHash("v1"), after: fileHash("v2") }]));
    write(join(root, "wiki", "a.md"), "external");
    await abortBatch(repo, marker);
    expect(readFileSync(join(root, "wiki", "a.md"), "utf8")).toBe("external");
    expect(await marker.read()).toBeNull();
  });

  it("does nothing when no marker exists", async () => {
    const { repo, root, marker } = await setup({ "wiki/a.md": "v1" });
    write(join(root, "wiki", "a.md"), "v2");
    await abortBatch(repo, marker);
    expect(readFileSync(join(root, "wiki", "a.md"), "utf8")).toBe("v2");
  });
});
