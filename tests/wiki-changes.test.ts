import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chunk, detectChanges } from "../src/wiki/changes.js";
import { WikiRepo } from "../src/wiki/git.js";
import { commit, makeRemote } from "./helpers/gitRemote.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

const SEED = {
  "notes/one.md": "# one\n",
  "notes/two.md": "# two\n",
  "wiki/secret.md": "# wiki\n",
  "raw/blob.md": "# raw\n",
  "notes/readme.txt": "not markdown\n",
  "notes/.draft.md": "# draft\n",
  ".hidden/private.md": "# private\n",
};

describe("chunk", () => {
  it("splits items into consecutive groups of at most size", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("returns no groups for an empty input", () => {
    expect(chunk([], 2)).toEqual([]);
  });

  it("treats a size below one as a single item per group", () => {
    expect(chunk([1], 0)).toEqual([[1]]);
  });
});

describe("detectChanges", () => {
  let dir: string;
  let work: string;
  let repo: WikiRepo;

  beforeEach(async () => {
    dir = await makeTmpDir();
    const made = makeRemote(dir);
    work = made.work;
    commit(work, SEED, "2020-01-01T00:00:00Z");
    repo = new WikiRepo({ home: dir, url: made.remote, branch: "main", protocols: "file" });
    await repo.open();
  });

  afterEach(async () => {
    await removeTmpDir(dir);
  });

  it("reports every markdown file as added on the first run, skipping wiki/raw/hidden paths", async () => {
    const changes = await detectChanges(repo, null);
    expect(changes).toEqual([
      { path: "notes/one.md", status: "A" },
      { path: "notes/two.md", status: "A" },
    ]);
  });

  it("reports added, modified and deleted markdown between revisions, carrying deleted content", async () => {
    const base = await repo.head();
    await rm(join(work, "notes/two.md"));
    commit(
      work,
      {
        "notes/one.md": "# one changed\n",
        "notes/three.md": "# three\n",
        "notes/other.txt": "added non-markdown\n",
        "wiki/new.md": "# new wiki page\n",
      },
      "2020-01-02T00:00:00Z",
    );
    await repo.fetch();
    await repo.resetHard("origin/main");

    const changes = await detectChanges(repo, base);
    const sorted = [...changes].sort((a, b) => a.path.localeCompare(b.path));
    expect(sorted).toEqual([
      { path: "notes/one.md", status: "M" },
      { path: "notes/three.md", status: "A" },
      { path: "notes/two.md", status: "D", previous: "# two\n" },
    ]);
  });
});
