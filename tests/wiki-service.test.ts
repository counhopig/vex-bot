import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runGit, type GitRunner } from "../src/vault/git.js";
import { Wiki } from "../src/wiki/service.js";
import { emptyState } from "../src/wiki/state.js";
import { commit, makeRemote } from "./helpers/gitRemote.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

let dir: string;
beforeEach(async () => {
  dir = await makeTmpDir();
});
afterEach(async () => {
  await removeTmpDir(dir);
});

const key = (url: string, branch?: string): string =>
  createHash("sha256").update(`${url}\n${branch ?? ""}`).digest("hex").slice(0, 12);

/** WikiRepo isolates HOME and sets GIT_ALLOW_PROTOCOL=http:https; allow the file transport for local test remotes. */
const fileRun: GitRunner = (args, options) => runGit(args, { ...options, env: { ...options.env, GIT_ALLOW_PROTOCOL: "file:http:https" } });

function makeWiki(home: string, url: string): Wiki {
  return new Wiki({
    home,
    vault: { url },
    maxNotesPerRun: 20,
    notifyEnabled: false,
    notify: async () => {},
    runAgent: async () => "ok",
    readSkill: async () => "",
    run: fileRun,
  });
}

async function seed(home: string): Promise<{ wiki: Wiki; root: string }> {
  const { remote, work } = makeRemote(join(dir, "seed"));
  commit(work, { "wiki/a.md": "v1" }, "2026-10-01T10:00:00+0000");
  const wiki = makeWiki(home, remote);
  return { wiki, root: join(home, "wiki", key(remote)) };
}

describe("Wiki service", () => {
  it("init creates the wiki and raw subtrees", async () => {
    const home = join(dir, "home");
    const { wiki, root } = await seed(home);

    await wiki.init();

    expect(existsSync(join(root, "wiki"))).toBe(true);
    expect(existsSync(join(root, "raw"))).toBe(true);
    await wiki.close();
  });

  it("status reports a fresh clone as pending with no state", async () => {
    const { wiki } = await seed(join(dir, "home"));

    await wiki.init();

    expect(await wiki.status()).toEqual({ bootstrap: "pending", nextAttemptAt: null, lastBatchId: null });
    await wiki.close();
  });

  it("status reads nextAttemptAt from persisted state", async () => {
    const home = join(dir, "home");
    const { wiki } = await seed(home);
    await wiki.init();
    mkdirSync(join(home, "state"), { recursive: true });
    writeFileSync(join(home, "state", "wiki.json"), JSON.stringify({ ...emptyState(), nextAttemptAt: 123 }));

    expect((await wiki.status()).nextAttemptAt).toBe(123);
    await wiki.close();
  });

  it("close is a safe no-op after init", async () => {
    const { wiki } = await seed(join(dir, "home"));
    await wiki.init();

    await wiki.close();
    await wiki.close();
  });
});
