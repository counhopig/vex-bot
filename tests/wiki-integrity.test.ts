import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertRecognizedLocalHistory, observeWiki } from "../src/wiki/integrity.js";
import { WikiRepo } from "../src/wiki/git.js";
import { commit, git, makeRemote } from "./helpers/gitRemote.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

let dir: string;
beforeEach(async () => { dir = await makeTmpDir(); });
afterEach(async () => { await removeTmpDir(dir); });

async function seed() {
  const { remote, work } = makeRemote(join(dir, "seed"));
  commit(work, { "wiki/start.md": "start" }, "2026-10-01T10:00:00+0000");
  const repo = new WikiRepo({ home: join(dir, "home"), url: remote, protocols: "file" });
  const root = await repo.open();
  return { repo, root, remote };
}

describe("Wiki repository integrity", () => {
  it("observes status paths with spaces and unicode as structured NUL records", async () => {
    const { repo, root } = await seed();
    mkdirSync(join(root, "wiki"), { recursive: true });
    writeFileSync(join(root, "wiki", "你好 note.md"), "new");
    const observed = await observeWiki(repo);
    expect(observed.fetchUrls).toHaveLength(1);
    expect(observed.pushUrls).toEqual(observed.fetchUrls);
    expect(observed.branch).toBe("main");
    expect(observed.status).toContainEqual({ index: "?", worktree: "?", path: "wiki/你好 note.md" });
  });

  it("rejects an unpublished commit despite a clean worktree", async () => {
    const { repo, root } = await seed();
    writeFileSync(join(root, "owner.md"), "owner");
    git(root, ["add", "owner.md"]);
    git(root, ["commit", "-m", "owner edit"]);
    const observation = await observeWiki(repo);
    expect(observation.status).toEqual([]);
    await expect(assertRecognizedLocalHistory(repo, observation)).rejects.toThrow(/unrecognized local commit/i);
  });

  it("rejects duplicate batch identities in repository history", async () => {
    const { repo, root } = await seed();
    const first = await repo.head();
    writeFileSync(join(root, "wiki", "one.md"), "one");
    git(root, ["add", "wiki/one.md"]);
    git(root, ["commit", "-m", `compile\n\nVex-Batch: b1\nVex-Kind: on-demand\nVex-Scan-Base: none`]);
    writeFileSync(join(root, "wiki", "two.md"), "two");
    git(root, ["add", "wiki/two.md"]);
    git(root, ["commit", "-m", `compile\n\nVex-Batch: b1\nVex-Kind: on-demand\nVex-Scan-Base: none`]);
    // The duplicated identities are local-only and must stop before publication.
    expect(await repo.isAncestor(first, await repo.head())).toBe(true);
    await expect(assertRecognizedLocalHistory(repo)).rejects.toThrow(/duplicate.*Vex-Batch/i);
  });

  it("keeps the original path for staged renames in NUL status", async () => {
    const { repo, root } = await seed();
    git(root, ["mv", "wiki/start.md", "wiki/renamed note.md"]);
    const observed = await observeWiki(repo);
    expect(observed.status).toContainEqual({ index: "R", worktree: " ", path: "wiki/renamed note.md", originalPath: "wiki/start.md" });
  });

  it("treats detached HEAD as an integrity refusal", async () => {
    const { repo, root } = await seed();
    git(root, ["checkout", "--detach", "HEAD"]);
    await expect(observeWiki(repo)).rejects.toThrow(/detached/i);
  });

  it("rejects an active branch that differs from origin/HEAD", async () => {
    const { repo, root } = await seed();
    git(root, ["checkout", "-b", "unexpected"]);
    await expect(observeWiki(repo)).rejects.toThrow(/active branch.*expected origin branch main/i);
  });
});
