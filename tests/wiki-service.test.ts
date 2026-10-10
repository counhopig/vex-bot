import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runGit, type GitRunner } from "../src/vault/git.js";
import { fingerprint } from "../src/vault/wiki/marker.js";
import { dueWikiWork, previewNotice, Wiki, type WikiOptions } from "../src/vault/wiki/service.js";
import { emptyState } from "../src/vault/wiki/state.js";
import { commit, git, makeRemote } from "./helpers/gitRemote.js";
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

function makeWiki(home: string, url: string, overrides: Partial<WikiOptions> = {}): Wiki {
  return new Wiki({
    home,
    vault: { url },
    maxNotesPerRun: 20,
    notifyEnabled: false,
    notify: async () => {},
    runAgent: async () => "ok",
    run: fileRun,
    ...overrides,
  });
}

async function seed(home: string, overrides: Partial<WikiOptions> = {}): Promise<{ wiki: Wiki; root: string }> {
  const { remote, work } = makeRemote(join(dir, "seed"));
  commit(work, { "wiki/a.md": "v1" }, "2026-10-01T10:00:00+0000");
  const wiki = makeWiki(home, remote, overrides);
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
    const { wiki, root } = await seed(home);
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

  it("preserves and refuses to publish an unknown local commit", async () => {
    const home = join(dir, "home");
    const { wiki, root } = await seed(home);
    await wiki.init();
    writeFileSync(join(root, "owner.md"), "keep me");
    git(root, ["add", "owner.md"]);
    git(root, ["commit", "-m", "owner change"]);
    const localHead = git(root, ["rev-parse", "HEAD"]).trim();
    const remote = git(root, ["remote", "get-url", "origin"]).trim();
    const remoteBefore = git(remote, ["rev-parse", "refs/heads/main"]).trim();

    await expect(wiki.run({ kind: "on-demand" }, new AbortController().signal)).rejects.toThrow(/unrecognized local commit/i);
    expect(git(root, ["rev-parse", "HEAD"]).trim()).toBe(localHead);
    expect(readFileSync(join(root, "owner.md"), "utf8")).toBe("keep me");
    expect(git(remote, ["rev-parse", "refs/heads/main"]).trim()).toBe(remoteBefore);
    await wiki.close();
  });

  it("blocks publication after the configured origin URL changes", async () => {
    const { wiki, root } = await seed(join(dir, "home"));
    await wiki.init();
    git(root, ["remote", "set-url", "origin", join(dir, "wrong.git")]);

    await expect(wiki.run({ kind: "on-demand" }, new AbortController().signal)).rejects.toThrow(/origin.*url/i);
    await wiki.close();
  });

  it("blocks publication when an explicit push URL points elsewhere", async () => {
    const { wiki, root } = await seed(join(dir, "home"));
    await wiki.init();
    git(root, ["remote", "set-url", "--push", "origin", join(dir, "other.git")]);

    await expect(wiki.run({ kind: "on-demand" }, new AbortController().signal)).rejects.toThrow(/origin.*url/i);
    await wiki.close();
  });

  it("rejects a generated batch trailer on a commit that changes an owner note", async () => {
    const { wiki, root } = await seed(join(dir, "home"));
    await wiki.init();
    const remoteBefore = git(root, ["rev-parse", "origin/main"]).trim();
    writeFileSync(join(root, "owner.md"), "owner content");
    git(root, ["add", "owner.md"]);
    git(root, ["commit", "-m", `wiki: compile\n\nVex-Batch: b1\nVex-Kind: on-demand\nVex-Scan-Base: none`]);
    const localHead = git(root, ["rev-parse", "HEAD"]).trim();

    await expect(wiki.run({ kind: "on-demand" }, new AbortController().signal)).rejects.toThrow(/outside generated wiki\/raw paths/i);
    expect(git(root, ["rev-parse", "HEAD"]).trim()).toBe(localHead);
    expect(readFileSync(join(root, "owner.md"), "utf8")).toBe("owner content");
    expect(git(root, ["rev-parse", "origin/main"]).trim()).toBe(remoteBefore);
    await wiki.close();
  });

  it("rebases a recognized pending batch over a remote fast-forward", async () => {
    const { wiki, root } = await seed(join(dir, "home"), {
      runAgent: async (_prompt, context) => {
        const target = join(context.repo.root, "wiki", "generated.md");
        await context.marker.recordIntent("wiki/generated.md", await fingerprint(target));
        writeFileSync(target, "generated");
        await context.marker.recordAfter("wiki/generated.md", await fingerprint(target));
        commit(join(dir, "seed", "work"), { "notes/remote.md": "remote input" }, "2026-10-02T10:00:00+0000");
        return "ok";
      },
    });
    await wiki.init();

    const result = await wiki.run({ kind: "on-demand" }, new AbortController().signal);

    expect(result.publication).toBe("published");
    expect(readFileSync(join(root, "wiki", "generated.md"), "utf8")).toBe("generated");
    expect(git(root, ["show", "origin/main:notes/remote.md"])).toBe("remote input");
    expect(git(root, ["show", "origin/main:wiki/generated.md"])).toBe("generated");
    await wiki.close();
  });

  it("keeps a committed batch and marker when provenance changes during publication retry", async () => {
    const home = join(dir, "home");
    const { remote, work } = makeRemote(join(dir, "seed"));
    commit(work, { "wiki/base.md": "base" }, "2026-10-01T10:00:00+0000");
    const root = join(home, "wiki", key(remote));
    let injected = false;
    const guardedRun: GitRunner = async (args, options) => {
      if (!injected && args[0] === "push") {
        injected = true;
        writeFileSync(join(root, "owner.md"), "preserve");
        git(root, ["add", "owner.md"]);
        git(root, ["commit", "-m", "owner change during settlement"]);
        throw Object.assign(new Error("simulated concurrent push rejection"), { code: 1 });
      }
      return fileRun(args, options);
    };
    const wiki = makeWiki(home, remote, {
      run: guardedRun,
      runAgent: async (_prompt, context) => {
        const path = "wiki/generated.md";
        const target = join(context.repo.root, path);
        await context.marker.recordIntent(path, await fingerprint(target));
        writeFileSync(target, "generated");
        await context.marker.recordAfter(path, await fingerprint(target));
        return "ok";
      },
    });
    await wiki.init();
    const remoteBefore = git(remote, ["rev-parse", "refs/heads/main"]).trim();

    const result = await wiki.run({ kind: "on-demand" }, new AbortController().signal);

    expect(result.publication).toBe("pending");
    expect(git(root, ["rev-parse", "HEAD"]).trim()).not.toBe(remoteBefore);
    expect(readFileSync(join(root, "wiki", "generated.md"), "utf8")).toBe("generated");
    expect(readFileSync(join(root, "owner.md"), "utf8")).toBe("preserve");
    expect(existsSync(join(root, ".git", "vex-wiki-inflight.json"))).toBe(true);
    expect(git(remote, ["rev-parse", "refs/heads/main"]).trim()).toBe(remoteBefore);
    await wiki.close();
  });

  it("preserves local files across force-pushed remote history, including after reopen", async () => {
    const home = join(dir, "home");
    const { wiki, root } = await seed(home);
    await wiki.init();
    const originalHead = git(root, ["rev-parse", "HEAD"]).trim();
    const remote = git(root, ["remote", "get-url", "origin"]).trim();
    const work = join(dir, "seed", "work");
    git(work, ["checkout", "--orphan", "rewrite"]);
    git(work, ["rm", "-rf", "."]);
    writeFileSync(join(work, "replacement.md"), "rewritten remote");
    git(work, ["add", "replacement.md"]);
    git(work, ["commit", "-m", "rewritten history"]);
    git(work, ["push", "origin", "HEAD:refs/heads/main", "--force"]);
    const rewrittenTip = git(remote, ["rev-parse", "refs/heads/main"]).trim();

    await expect(wiki.run({ kind: "on-demand" }, new AbortController().signal)).rejects.toThrow(/remote branch .*rewritten/i);
    expect(git(root, ["rev-parse", "HEAD"]).trim()).toBe(originalHead);
    expect(readFileSync(join(root, "wiki", "a.md"), "utf8")).toBe("v1");
    expect(git(remote, ["rev-parse", "refs/heads/main"]).trim()).toBe(rewrittenTip);
    await wiki.close();

    const reopened = makeWiki(home, remote);
    await reopened.init();
    await expect(reopened.run({ kind: "on-demand" }, new AbortController().signal)).rejects.toThrow(/remote branch .*rewritten/i);
    expect(git(root, ["rev-parse", "HEAD"]).trim()).toBe(originalHead);
    expect(readFileSync(join(root, "wiki", "a.md"), "utf8")).toBe("v1");
    expect(git(remote, ["rev-parse", "refs/heads/main"]).trim()).toBe(rewrittenTip);
    await reopened.close();
  });

  it("serializes runs so a second run waits for the first", async () => {
    const home = join(dir, "home");
    let enteredFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => { enteredFirst = resolve; });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let calls = 0;
    const { wiki } = await seed(home, {
      runAgent: async () => {
        calls += 1;
        if (calls === 1) {
          enteredFirst();
          await firstGate;
        }
        return "ok";
      },
    });
    await wiki.init();
    const signal = new AbortController().signal;

    const first = wiki.run({ kind: "on-demand" }, signal);
    await firstEntered;
    const second = wiki.run({ kind: "on-demand" }, signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(1);

    releaseFirst();
    await first;
    await expect(second).resolves.toMatchObject({ publication: "not-needed" });
    expect(calls).toBe(2);
    await wiki.close();
  });

  it("rollback reverts the last published batch and clears the reference", async () => {
    const home = join(dir, "home");
    const { wiki, root } = await seed(home, {
      runAgent: async (_prompt, context) => {
        const abs = join(context.repo.root, "wiki/a.md");
        await context.marker.recordIntent("wiki/a.md", await fingerprint(abs));
        writeFileSync(abs, "v2");
        await context.marker.recordAfter("wiki/a.md", await fingerprint(abs));
        return "ok";
      },
    });
    await wiki.init();
    await wiki.run({ kind: "on-demand" }, new AbortController().signal);
    expect(readFileSync(join(root, "wiki", "a.md"), "utf8")).toBe("v2");
    const stateFile = join(home, "state", "wiki.json");
    const scanProgress = git(git(root, ["remote", "get-url", "origin"]).trim(), ["rev-parse", "refs/heads/main"]).trim();
    writeFileSync(stateFile, JSON.stringify({ ...JSON.parse(readFileSync(stateFile, "utf8")), lastScanCommit: scanProgress }));

    const result = await wiki.rollback(new AbortController().signal);

    expect(result.reverted).toBe(true);
    expect(readFileSync(join(root, "wiki", "a.md"), "utf8")).toBe("v1");
    const settledState = JSON.parse(readFileSync(stateFile, "utf8"));
    expect(settledState.lastBatchId).toBeNull();
    expect(settledState.lastScanCommit).toBe(scanProgress);
    const rollbackMessage = git(root, ["log", "-1", "--format=%B"]);
    const rollbackId = /Vex-Rollback: (.+)/.exec(rollbackMessage)?.[1];
    const targetBatchId = /Vex-Revert-Of: (.+)/.exec(rollbackMessage)?.[1];
    expect(rollbackId).toBeTruthy();
    expect(targetBatchId).toBeTruthy();
    writeFileSync(stateFile, JSON.stringify({ ...settledState, rollback: { targetBatchId, revertId: rollbackId } }));
    const headAfterFirstRollback = git(root, ["rev-parse", "HEAD"]).trim();
    const recovered = await wiki.rollback(new AbortController().signal);
    expect(recovered.reverted).toBe(true);
    expect(git(root, ["rev-parse", "HEAD"]).trim()).toBe(headAfterFirstRollback);
    expect(JSON.parse(readFileSync(stateFile, "utf8")).rollback).toBeNull();
    await wiki.close();
  });

  it("settles a failed rollback push by publishing the same revert once", async () => {
    const home = join(dir, "home");
    const { remote, work } = makeRemote(join(dir, "seed"));
    commit(work, { "wiki/a.md": "v1" }, "2026-10-01T10:00:00+0000");
    const root = join(home, "wiki", key(remote));
    let rejectRollbackPushes = 0;
    const guardedRun: GitRunner = async (args, options) => {
      if (rejectRollbackPushes > 0 && args[0] === "push" && git(root, ["log", "-1", "--format=%B"]).includes("Vex-Rollback:")) {
        rejectRollbackPushes -= 1;
        throw Object.assign(new Error("temporary push failure"), { code: 1 });
      }
      return fileRun(args, options);
    };
    const wiki = makeWiki(home, remote, {
      run: guardedRun,
      runAgent: async (_prompt, context) => {
        const path = "wiki/a.md";
        const abs = join(context.repo.root, path);
        await context.marker.recordIntent(path, await fingerprint(abs));
        writeFileSync(abs, "v2");
        await context.marker.recordAfter(path, await fingerprint(abs));
        return "ok";
      },
    });
    await wiki.init();
    await wiki.run({ kind: "on-demand" }, new AbortController().signal);
    rejectRollbackPushes = 2;

    const first = await wiki.rollback(new AbortController().signal);
    expect(first.reverted).toBe(false);
    expect(first.message).toMatch(/push failed/i);
    const second = await wiki.rollback(new AbortController().signal);

    expect(second.reverted).toBe(true);
    const rollbackCommits = git(root, ["log", "--format=%H%x00%B"]).split("Vex-Rollback:").length - 1;
    expect(rollbackCommits).toBe(1);
    expect(git(remote, ["show", "refs/heads/main:wiki/a.md"])).toBe("v1");
    await wiki.close();
  });

  it("recovers and publishes one revert after the rollback commit loses all state", async () => {
    const home = join(dir, "home");
    const { remote, work } = makeRemote(join(dir, "seed"));
    commit(work, { "wiki/a.md": "v1" }, "2026-10-01T10:00:00+0000");
    const root = join(home, "wiki", key(remote));
    const stateFile = join(home, "state", "wiki.json");
    let crashAfterRevertCommit = false;
    const crashingRun: GitRunner = async (args, options) => {
      const result = await fileRun(args, options);
      if (crashAfterRevertCommit && args.includes("commit") && args.some((arg) => arg.includes("Vex-Rollback:"))) {
        crashAfterRevertCommit = false;
        unlinkSync(stateFile);
        throw new Error("simulated crash after revert commit");
      }
      return result;
    };
    const options: Partial<WikiOptions> = {
      runAgent: async (_prompt, context) => {
        const path = "wiki/a.md";
        const abs = join(context.repo.root, path);
        await context.marker.recordIntent(path, await fingerprint(abs));
        writeFileSync(abs, "v2");
        await context.marker.recordAfter(path, await fingerprint(abs));
        return "ok";
      },
    };
    const wiki = makeWiki(home, remote, { ...options, run: crashingRun });
    await wiki.init();
    await wiki.run({ kind: "on-demand" }, new AbortController().signal);
    crashAfterRevertCommit = true;
    const crashed = await wiki.rollback(new AbortController().signal);
    expect(crashed.reverted).toBe(false);
    expect(existsSync(stateFile)).toBe(false);
    await wiki.close();

    const reopened = makeWiki(home, remote, options);
    await reopened.init();
    const recovered = await reopened.rollback(new AbortController().signal);

    expect(recovered.reverted).toBe(true);
    expect(git(remote, ["show", "refs/heads/main:wiki/a.md"])).toBe("v1");
    expect(git(root, ["log", "--format=%H%x00%B"]).split("Vex-Rollback:").length - 1).toBe(1);
    expect(JSON.parse(readFileSync(stateFile, "utf8")).rollback).toBeNull();
    await reopened.close();
  });

  it("preserves a same-path owner edit made during a revert", async () => {
    const home = join(dir, "home");
    const { remote, work } = makeRemote(join(dir, "seed"));
    commit(work, { "wiki/a.md": "v1" }, "2026-10-01T10:00:00+0000");
    const root = join(home, "wiki", key(remote));
    let injectEdit = false;
    const guardedRun: GitRunner = async (args, options) => {
      const result = await fileRun(args, options);
      if (injectEdit && args[0] === "revert" && args.includes("--no-commit")) {
        injectEdit = false;
        writeFileSync(join(root, "wiki/a.md"), "owner edit during conflict");
      }
      return result;
    };
    const wiki = makeWiki(home, remote, {
      run: guardedRun,
      runAgent: async (_prompt, context) => {
        const path = "wiki/a.md";
        const abs = join(context.repo.root, path);
        await context.marker.recordIntent(path, await fingerprint(abs));
        writeFileSync(abs, "v2");
        await context.marker.recordAfter(path, await fingerprint(abs));
        return "ok";
      },
    });
    await wiki.init();
    await wiki.run({ kind: "on-demand" }, new AbortController().signal);
    const batchHead = git(root, ["rev-parse", "HEAD"]).trim();
    injectEdit = true;

    const result = await wiki.rollback(new AbortController().signal);

    expect(result.reverted).toBe(false);
    expect(git(root, ["rev-parse", "HEAD"]).trim()).toBe(batchHead);
    expect(readFileSync(join(root, "wiki/a.md"), "utf8")).toBe("owner edit during conflict");
    await wiki.close();
  });

  it("preserves a same-path owner edit after a real revert conflict", async () => {
    const home = join(dir, "home");
    const { remote, work } = makeRemote(join(dir, "seed"));
    commit(work, { "wiki/a.md": "line one\nline two\n" }, "2026-10-01T10:00:00+0000");
    const root = join(home, "wiki", key(remote));
    let injectConflictEdit = false;
    const guardedRun: GitRunner = async (args, options) => {
      try {
        return await fileRun(args, options);
      } catch (error) {
        if (injectConflictEdit && args[0] === "revert" && args.includes("--no-commit")) {
          injectConflictEdit = false;
          writeFileSync(join(root, "wiki/a.md"), "owner bytes after conflict");
        }
        throw error;
      }
    };
    const wiki = makeWiki(home, remote, {
      run: guardedRun,
      runAgent: async (_prompt, context) => {
        const path = "wiki/a.md";
        const abs = join(context.repo.root, path);
        await context.marker.recordIntent(path, await fingerprint(abs));
        writeFileSync(abs, "line one\nline two generated\n");
        await context.marker.recordAfter(path, await fingerprint(abs));
        return "ok";
      },
    });
    await wiki.init();
    await wiki.run({ kind: "on-demand" }, new AbortController().signal);
    git(work, ["fetch", "origin"]);
    git(work, ["reset", "--hard", "origin/main"]);
    commit(work, { "wiki/a.md": "entirely replaced remote content\n" }, "2026-10-02T10:00:00+0000");
    git(root, ["fetch", "origin"]);
    git(root, ["merge", "--ff-only", "origin/main"]);
    const head = git(root, ["rev-parse", "HEAD"]).trim();
    injectConflictEdit = true;

    const result = await wiki.rollback(new AbortController().signal);

    expect(result.reverted).toBe(false);
    expect(result.message).toMatch(/revert failed/i);
    expect(git(root, ["rev-parse", "HEAD"]).trim()).toBe(head);
    expect(readFileSync(join(root, "wiki/a.md"), "utf8")).toBe("owner bytes after conflict");
    await wiki.close();
  });

  it("retains rollback expectations when a mismatching commit reply is lost", async () => {
    const home = join(dir, "home");
    const { remote, work } = makeRemote(join(dir, "seed"));
    commit(work, { "wiki/a.md": "v1" }, "2026-10-01T10:00:00+0000");
    const root = join(home, "wiki", key(remote));
    let injectCommitEdit = false;
    const guardedRun: GitRunner = async (args, options) => {
      const loseCommitReply = injectCommitEdit && args.includes("commit");
      if (loseCommitReply) {
        injectCommitEdit = false;
        writeFileSync(join(root, "wiki/a.md"), "owner edit during commit");
      }
      const result = await fileRun(args, options);
      if (loseCommitReply) throw new Error("simulated lost commit response");
      return result;
    };
    const wiki = makeWiki(home, remote, {
      run: guardedRun,
      runAgent: async (_prompt, context) => {
        const path = "wiki/a.md";
        const abs = join(context.repo.root, path);
        await context.marker.recordIntent(path, await fingerprint(abs));
        writeFileSync(abs, "v2");
        await context.marker.recordAfter(path, await fingerprint(abs));
        return "ok";
      },
    });
    await wiki.init();
    await wiki.run({ kind: "on-demand" }, new AbortController().signal);
    const batchSha = git(remote, ["rev-parse", "refs/heads/main"]).trim();
    injectCommitEdit = true;

    const result = await wiki.rollback(new AbortController().signal);

    expect(result.reverted).toBe(false);
    expect(result.message).toMatch(/revert failed/i);
    expect(readFileSync(join(root, "wiki/a.md"), "utf8")).toBe("owner edit during commit");
    expect(git(remote, ["rev-parse", "refs/heads/main"]).trim()).toBe(batchSha);
    await expect(wiki.run({ kind: "on-demand" }, new AbortController().signal)).rejects.toThrow(/does not match its durable expectation/i);
    await wiki.close();
  });

  it("keeps a committed compile marker when its commit blob does not match", async () => {
    const home = join(dir, "home");
    const { remote, work } = makeRemote(join(dir, "seed"));
    commit(work, { "wiki/a.md": "v1" }, "2026-10-01T10:00:00+0000");
    const root = join(home, "wiki", key(remote));
    let injectCommitEdit = false;
    const guardedRun: GitRunner = async (args, options) => {
      if (injectCommitEdit && args.includes("commit")) {
        injectCommitEdit = false;
        writeFileSync(join(root, "wiki/a.md"), "owner bytes");
      }
      return fileRun(args, options);
    };
    const wiki = makeWiki(home, remote, {
      run: guardedRun,
      runAgent: async (_prompt, context) => {
        const path = "wiki/a.md";
        const abs = join(context.repo.root, path);
        await context.marker.recordIntent(path, await fingerprint(abs));
        writeFileSync(abs, "v2");
        await context.marker.recordAfter(path, await fingerprint(abs));
        injectCommitEdit = true;
        return "ok";
      },
    });
    await wiki.init();
    const remoteBefore = git(remote, ["rev-parse", "refs/heads/main"]).trim();

    await expect(wiki.run({ kind: "on-demand" }, new AbortController().signal)).rejects.toThrow(/commit content does not match/i);
    await expect(wiki.run({ kind: "on-demand" }, new AbortController().signal)).rejects.toThrow(/commit content does not match/i);

    expect(readFileSync(join(root, "wiki/a.md"), "utf8")).toBe("owner bytes");
    expect(existsSync(join(root, ".git", "vex-wiki-inflight.json"))).toBe(true);
    expect(git(remote, ["rev-parse", "refs/heads/main"]).trim()).toBe(remoteBefore);
    await wiki.close();
  });

  it("refuses a pending rollback whose commit identity is missing", async () => {
    const home = join(dir, "home");
    const { wiki, root } = await seed(home);
    await wiki.init();
    const stateFile = join(home, "state", "wiki.json");
    mkdirSync(join(home, "state"), { recursive: true });
    writeFileSync(stateFile, JSON.stringify({ ...emptyState(), lastBatchId: "missing", rollback: { targetBatchId: "b", revertId: "r" } }));

    const head = git(root, ["rev-parse", "HEAD"]).trim();
    const pending = await wiki.rollback(new AbortController().signal);

    expect(pending.reverted).toBe(false);
    expect(pending.message).toMatch(/matching rollback commit/i);
    expect(git(root, ["rev-parse", "HEAD"]).trim()).toBe(head);
    expect(JSON.parse(readFileSync(stateFile, "utf8")).rollback).toEqual({ targetBatchId: "b", revertId: "r" });
    await wiki.close();
  });

  it("blocks automatic rollback when history contains an orphan revert relationship", async () => {
    const home = join(dir, "home");
    const { wiki, root } = await seed(home);
    await wiki.init();
    const remote = git(root, ["remote", "get-url", "origin"]).trim();
    const work = join(dir, "seed", "work");
    writeFileSync(join(work, "wiki/a.md"), "orphan content");
    git(work, ["add", "wiki/a.md"]);
    git(work, ["commit", "-m", "wiki: rollback", "-m", "Vex-Rollback: orphan", "-m", "Vex-Revert-Of: missing-batch"]);
    git(work, ["push", "origin", "HEAD:refs/heads/main", "--force"]);
    const localHead = git(root, ["rev-parse", "HEAD"]).trim();
    const remoteHead = git(remote, ["rev-parse", "refs/heads/main"]).trim();

    await expect(wiki.rollback(new AbortController().signal)).rejects.toThrow(/invalid rollback relationship/i);

    expect(git(root, ["rev-parse", "HEAD"]).trim()).toBe(localHead);
    expect(git(remote, ["rev-parse", "refs/heads/main"]).trim()).toBe(remoteHead);
    expect(readFileSync(join(root, "wiki/a.md"), "utf8")).toBe("v1");
    await wiki.close();
  });

  it("approveBootstrap publishes the preview and marks bootstrap done", async () => {
    const home = join(dir, "home");
    const notices: string[] = [];
    const { wiki, root } = await seed(home, {
      notifyEnabled: true,
      notify: async (text) => { notices.push(text); },
      runAgent: async (_prompt, context) => {
        const abs = join(context.repo.root, "wiki/a.md");
        await context.marker.recordIntent("wiki/a.md", await fingerprint(abs));
        writeFileSync(abs, "v2");
        await context.marker.recordAfter("wiki/a.md", await fingerprint(abs));
        return "ok";
      },
    });
    commit(join(dir, "seed", "work"), { "notes/note.md": "n1" }, "2026-10-02T10:00:00+0000");
    await wiki.init();
    await wiki.run({ kind: "bootstrap" }, new AbortController().signal);
    expect(readFileSync(join(root, "wiki", "a.md"), "utf8")).toBe("v2");

    const preview = await wiki.preview();
    expect(preview).toMatchObject({ pages: ["wiki/a.md"] });
    expect(notices).toEqual([previewNotice(preview!)]);
    expect(notices[0]).toContain("wiki/a.md");
    expect(notices[0]).toContain("approve the Wiki preview");
    const remoteUrl = git(root, ["remote", "get-url", "origin"]).trim();
    const reopened = makeWiki(home, remoteUrl);
    await reopened.init();
    expect(await reopened.preview()).toEqual(preview);
    await reopened.close();

    const approved = await wiki.approveBootstrap(new AbortController().signal);

    expect(approved.pushed).toBe(true);
    expect(JSON.parse(readFileSync(join(home, "state", "wiki.json"), "utf8")).bootstrap).toBe("done");
    const publishedHead = git(root, ["rev-parse", "HEAD"]).trim();
    const rejectedPublished = await wiki.rejectBootstrap(new AbortController().signal);
    expect(rejectedPublished.discarded).toBe(false);
    expect(rejectedPublished.message).toMatch(/already published/i);
    expect(git(root, ["rev-parse", "HEAD"]).trim()).toBe(publishedHead);
    await wiki.close();
  });

  it("rejectBootstrap discards an unpublished preview locally without pushing", async () => {
    const home = join(dir, "home");
    const { wiki, root } = await seed(home, {
      runAgent: async (_prompt, context) => {
        const abs = join(context.repo.root, "wiki/a.md");
        await context.marker.recordIntent("wiki/a.md", await fingerprint(abs));
        writeFileSync(abs, "v2");
        await context.marker.recordAfter("wiki/a.md", await fingerprint(abs));
        return "ok";
      },
    });
    commit(join(dir, "seed", "work"), { "notes/note.md": "n1" }, "2026-10-02T10:00:00+0000");
    await wiki.init();
    await wiki.run({ kind: "bootstrap" }, new AbortController().signal);

    const rejected = await wiki.rejectBootstrap(new AbortController().signal);

    expect(rejected.discarded).toBe(true);
    expect(readFileSync(join(root, "wiki", "a.md"), "utf8")).toBe("v1");
    expect(JSON.parse(readFileSync(join(home, "state", "wiki.json"), "utf8")).bootstrap).toBe("pending");
    await wiki.close();
  });

  it("preserves an owner edit and state when rejecting a dirty preview", async () => {
    const home = join(dir, "home");
    const { wiki, root } = await seed(home, {
      runAgent: async (_prompt, context) => {
        const abs = join(context.repo.root, "wiki/a.md");
        await context.marker.recordIntent("wiki/a.md", await fingerprint(abs));
        writeFileSync(abs, "v2");
        await context.marker.recordAfter("wiki/a.md", await fingerprint(abs));
        return "ok";
      },
    });
    commit(join(dir, "seed", "work"), { "notes/note.md": "n1" }, "2026-10-02T10:00:00+0000");
    await wiki.init();
    await wiki.run({ kind: "bootstrap" }, new AbortController().signal);
    const beforeState = readFileSync(join(home, "state", "wiki.json"), "utf8");
    const beforeHead = git(root, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(root, "owner.md"), "owner bytes");
    writeFileSync(join(root, "staged-owner.md"), "staged owner bytes");
    git(root, ["add", "staged-owner.md"]);

    const approved = await wiki.approveBootstrap(new AbortController().signal);
    expect(approved.pushed).toBe(false);

    const result = await wiki.rejectBootstrap(new AbortController().signal);

    expect(result.discarded).toBe(false);
    expect(result.message).toMatch(/not clean/i);
    expect(git(root, ["rev-parse", "HEAD"]).trim()).toBe(beforeHead);
    expect(readFileSync(join(root, "owner.md"), "utf8")).toBe("owner bytes");
    expect(readFileSync(join(root, "staged-owner.md"), "utf8")).toBe("staged owner bytes");
    expect(git(root, ["diff", "--cached", "--name-only"])).toContain("staged-owner.md");
    expect(readFileSync(join(home, "state", "wiki.json"), "utf8")).toBe(beforeState);
    await wiki.close();
  });

  it("keeps a bootstrap preview when it is no longer the local tip", async () => {
    const home = join(dir, "home");
    const { wiki, root } = await seed(home, {
      runAgent: async (_prompt, context) => {
        const abs = join(context.repo.root, "wiki/a.md");
        await context.marker.recordIntent("wiki/a.md", await fingerprint(abs));
        writeFileSync(abs, "v2");
        await context.marker.recordAfter("wiki/a.md", await fingerprint(abs));
        return "ok";
      },
    });
    commit(join(dir, "seed", "work"), { "notes/note.md": "n1" }, "2026-10-02T10:00:00+0000");
    await wiki.init();
    await wiki.run({ kind: "bootstrap" }, new AbortController().signal);
    const preview = await wiki.preview();
    writeFileSync(join(root, "wiki/extra.md"), "later local batch");
    git(root, ["add", "wiki/extra.md"]);
    git(root, ["-c", "user.name=Vex Bot", "-c", "user.email=vex@localhost", "commit", "-m", "wiki: ingest follow-up", "-m", "Vex-Batch: follow-up", "-m", "Vex-Kind: on-demand", "-m", "Vex-Scan-Base: none"]);
    const head = git(root, ["rev-parse", "HEAD"]).trim();

    const rejected = await wiki.rejectBootstrap(new AbortController().signal);

    expect(rejected.discarded).toBe(false);
    expect(rejected.message).toMatch(/no bootstrap preview/i);
    expect(git(root, ["rev-parse", "HEAD"]).trim()).toBe(head);
    expect(preview).not.toBeNull();
    expect(git(root, ["merge-base", "--is-ancestor", preview!.commit, "HEAD"]).trim()).toBe("");
    await wiki.close();
  });

  it("completes an empty-vault bootstrap instead of relaunching it", async () => {
    const home = join(dir, "home");
    const { wiki } = await seed(home, {
      runAgent: async () => {
        throw new Error("the agent must not run for an empty vault");
      },
    });
    await wiki.init();

    const result = await wiki.run({ kind: "bootstrap" }, new AbortController().signal);

    expect(result).toMatchObject({ publication: "not-needed" });
    expect((await wiki.status()).bootstrap).toBe("done");
    await wiki.close();
  });

  it("reports a failed run to the owner once", async () => {
    const home = join(dir, "home");
    const notifications: string[] = [];
    const { wiki } = await seed(home, {
      notifyEnabled: true,
      notify: async (text) => { notifications.push(text); },
      runAgent: async () => {
        throw new Error("agent exploded");
      },
    });
    await wiki.init();

    await expect(wiki.run({ kind: "on-demand" }, new AbortController().signal)).rejects.toThrow("agent exploded");

    expect(notifications.filter((text) => text.includes("run failed"))).toHaveLength(1);
    await wiki.close();
  });

  it("restores writing-phase paths and clears the marker when the agent fails", async () => {
    const home = join(dir, "home");
    const { wiki, root } = await seed(home, {
      runAgent: async (_prompt, context) => {
        const abs = join(context.repo.root, "wiki/a.md");
        await context.marker.recordIntent("wiki/a.md", await fingerprint(abs));
        writeFileSync(abs, "v2");
        await context.marker.recordAfter("wiki/a.md", await fingerprint(abs));
        throw new Error("agent failed");
      },
    });
    await wiki.init();

    await expect(wiki.run({ kind: "on-demand" }, new AbortController().signal)).rejects.toThrow("agent failed");

    expect(readFileSync(join(root, "wiki", "a.md"), "utf8")).toBe("v1");
    expect(existsSync(join(root, ".git", "vex-wiki-inflight.json"))).toBe(false);
    await wiki.close();
  });

  it("scheduled run chunks changed notes and commits them as one batch", async () => {
    const home = join(dir, "home");
    const prompts: string[] = [];
    const chunks = [["wiki/a.md", "wiki/b.md"], ["wiki/c.md"]];
    const { wiki, root } = await seed(home, {
      maxNotesPerRun: 2,
      runAgent: async (prompt, context) => {
        const paths = chunks[prompts.length] ?? [];
        prompts.push(prompt);
        for (const path of paths) {
          const abs = join(context.repo.root, path);
          await context.marker.recordIntent(path, await fingerprint(abs));
          writeFileSync(abs, `${path} edited`);
          await context.marker.recordAfter(path, await fingerprint(abs));
        }
        return "ok";
      },
    });
    commit(join(dir, "seed", "work"), { "notes/a.md": "a", "notes/b.md": "b", "notes/c.md": "c" }, "2026-10-02T10:00:00+0000");
    await wiki.init();
    const before = Number(git(root, ["rev-list", "--count", "HEAD"]).trim());

    const result = await wiki.run({ kind: "scheduled" }, new AbortController().signal);

    expect(prompts).toHaveLength(2);
    expect(result.publication).toBe("published");
    expect(Number(git(root, ["rev-list", "--count", "HEAD"]).trim())).toBe(before + 1);
    expect(git(root, ["log", "-1", "--format=%B"])).toContain("Vex-Batch:");
    await wiki.close();
  });

  it("scheduled run with no vault changes advances the scan cursor without calling the agent", async () => {
    const home = join(dir, "home");
    let calls = 0;
    const { wiki } = await seed(home, {
      runAgent: async () => {
        calls += 1;
        return "ok";
      },
    });
    await wiki.init();

    const result = await wiki.run({ kind: "scheduled" }, new AbortController().signal);

    expect(result).toMatchObject({ publication: "not-needed" });
    expect(calls).toBe(0);
    expect(JSON.parse(readFileSync(join(home, "state", "wiki.json"), "utf8")).lastScanCommit).toBeTruthy();
    await wiki.close();
  });

  it("archives link text before compilation and updates the same source path on repeated ingestion", async () => {
    const home = join(dir, "home");
    const url = "https://example.com/article";
    const sourcePath = `raw/link-${createHash("sha256").update(url).digest("hex")}.md`;
    let expected = "Original article";
    const { wiki, root } = await seed(home, {
      runAgent: async (prompt, context) => {
        expect(readFileSync(join(context.repo.root, sourcePath), "utf8")).toContain(expected);
        expect(prompt).toContain(`Source archived at: ${sourcePath}`);
        return "ok";
      },
    });
    await wiki.init();
    const result = await wiki.run({ kind: "on-demand", source: { url, title: "Article", text: expected } }, new AbortController().signal);
    expect(result).toMatchObject({ publication: "published", pages: [] });
    expect(git(root, ["show", `origin/main:${sourcePath}`])).toContain("Original article");
    expected = "Updated original article";
    const again = await wiki.run({ kind: "on-demand", source: { url, title: "Article", text: expected } }, new AbortController().signal);
    expect(again).toMatchObject({ publication: "published", pages: [] });
    expect(git(root, ["show", `origin/main:${sourcePath}`])).toContain(expected);
    const duplicate = await wiki.run({ kind: "on-demand", source: { url, title: "Article", text: expected } }, new AbortController().signal);
    expect(duplicate).toMatchObject({ publication: "not-needed" });
    await wiki.close();
  });

  it("adapts long URL segments before the batch while archiving the complete body", async () => {
    const home = join(dir, "home");
    const url = "https://example.com/long";
    const body = "a".repeat(12_000) + "🙂" + "b".repeat(12_000);
    const prompts: string[] = [];
    const { wiki, root } = await seed(home, {
      sourceSegmentBudget: async (prefix, context) => {
        expect(prefix).toContain("Source URL:");
        expect(await context.repo.statusEntries()).toEqual([]);
        expect(existsSync(join(context.repo.root, `raw/link-${createHash("sha256").update(url).digest("hex")}.md`))).toBe(false);
        return 4_000;
      },
      runAgent: async (prompt) => { prompts.push(prompt); return "ok"; },
    });
    await wiki.init();
    const result = await wiki.run({ kind: "on-demand", source: { url, canonicalUrl: "https://example.com/canonical", text: body } }, new AbortController().signal);
    const segments = prompts.map((prompt) => prompt.split("Source text:\n")[1] ?? "");
    expect(segments).toHaveLength(7);
    expect(segments.every((segment) => segment.length <= 4_000)).toBe(true);
    expect(segments.join("")).toBe(body);
    expect(prompts.every((prompt, index) => prompt.includes(`Source segment ${index + 1} of 7`))).toBe(true);
    expect(readFileSync(join(root, `raw/link-${createHash("sha256").update(url).digest("hex")}.md`), "utf8")).toContain(body);
    expect(result.pages).toEqual([]);
    await wiki.close();
  });

  it("reports no compiled Wiki pages when only the raw source changed", async () => {
    const home = join(dir, "home");
    const { wiki } = await seed(home, { runAgent: async (_prompt, context) => {
      const path = "wiki/a.md";
      const target = join(context.repo.root, path);
      await context.marker.recordIntent(path, await fingerprint(target));
      writeFileSync(target, "temporary");
      await context.marker.recordAfter(path, await fingerprint(target));
      await context.marker.recordIntent(path, await fingerprint(target));
      writeFileSync(target, "v1");
      await context.marker.recordAfter(path, await fingerprint(target));
      return "ok";
    } });
    await wiki.init();
    const result = await wiki.run({ kind: "on-demand", source: { url: "https://example.com/raw-only", text: "new original" } }, new AbortController().signal);
    expect(result.publication).toBe("published");
    expect(result.pages).toEqual([]);
    await wiki.close();
  });

  it("keeps a note staged during compilation local and refuses publication", async () => {
    const home = join(dir, "home");
    const { wiki, root } = await seed(home, {
      runAgent: async (_prompt, context) => {
        const path = "wiki/generated.md";
        const target = join(context.repo.root, path);
        await context.marker.recordIntent(path, await fingerprint(target));
        writeFileSync(target, "generated");
        await context.marker.recordAfter(path, await fingerprint(target));
        writeFileSync(join(context.repo.root, "notes.md"), "owner staged note");
        git(context.repo.root, ["add", "--", "notes.md"]);
        return "ok";
      },
    });
    await wiki.init();
    const remote = git(root, ["remote", "get-url", "origin"]).trim();
    const before = git(remote, ["rev-parse", "HEAD"]).trim();

    await expect(wiki.run({ kind: "on-demand" }, new AbortController().signal)).rejects.toThrow(/dirty paths are not owned/i);

    expect(git(remote, ["rev-parse", "HEAD"]).trim()).toBe(before);
    expect(readFileSync(join(root, "notes.md"), "utf8")).toBe("owner staged note");
    expect(git(root, ["diff", "--cached", "--name-only"])).toBe("notes.md\n");
    expect(existsSync(join(root, ".git", "vex-wiki-inflight.json"))).toBe(true);
    await wiki.close();
  });

  it("keeps an owner note staged after the final status check out of the batch commit", async () => {
    const home = join(dir, "home");
    const { remote, work } = makeRemote(join(dir, "seed"));
    commit(work, { "wiki/base.md": "base", "notes/owner.md": "owner v1" }, "2026-10-01T10:00:00+0000");
    const root = join(home, "wiki", key(remote));
    let injected = false;
    const racingRunner: GitRunner = async (args, options) => {
      const result = await fileRun(args, options);
      if (!injected && args[0] === "diff" && args[1] === "--cached") {
        injected = true;
        writeFileSync(join(root, "notes/owner.md"), "owner v2");
        git(root, ["add", "--", "notes/owner.md"]);
      }
      return result;
    };
    const wiki = makeWiki(home, remote, {
      run: racingRunner,
      runAgent: async (_prompt, context) => {
        const path = "wiki/generated.md";
        const target = join(context.repo.root, path);
        await context.marker.recordIntent(path, await fingerprint(target));
        writeFileSync(target, "generated");
        await context.marker.recordAfter(path, await fingerprint(target));
        return "ok";
      },
    });
    await wiki.init();
    const remoteBefore = git(remote, ["rev-parse", "HEAD"]).trim();

    const result = await wiki.run({ kind: "on-demand" }, new AbortController().signal);
    const remoteAfter = git(remote, ["rev-parse", "HEAD"]).trim();

    expect(injected).toBe(true);
    expect(result.publication).toBe("published");
    expect(git(remote, ["show", `${remoteAfter}:notes/owner.md`])).toBe("owner v1");
    expect(git(remote, ["show", `${remoteAfter}:wiki/generated.md`])).toBe("generated");
    expect(readFileSync(join(root, "notes/owner.md"), "utf8")).toBe("owner v2");
    expect(git(root, ["diff", "--cached", "--name-only", "--no-renames"])).toBe("notes/owner.md\n");
    expect(remoteAfter).not.toBe(remoteBefore);
    await wiki.close();
  });

  it("preserves different owner bytes staged for a touched path", async () => {
    const home = join(dir, "home");
    const { wiki, root } = await seed(home, {
      runAgent: async (_prompt, context) => {
        const path = "wiki/generated.md";
        const target = join(context.repo.root, path);
        await context.marker.recordIntent(path, await fingerprint(target));
        writeFileSync(target, "generated");
        await context.marker.recordAfter(path, await fingerprint(target));
        writeFileSync(target, "owner staged bytes");
        git(context.repo.root, ["add", "--", path]);
        writeFileSync(target, "generated");
        return "ok";
      },
    });
    await wiki.init();
    const remote = git(root, ["remote", "get-url", "origin"]).trim();
    const before = git(remote, ["rev-parse", "HEAD"]).trim();

    await expect(wiki.run({ kind: "on-demand" }, new AbortController().signal)).rejects.toThrow(/index content does not match/i);

    expect(git(remote, ["rev-parse", "HEAD"]).trim()).toBe(before);
    expect(git(root, ["show", ":wiki/generated.md"])).toBe("owner staged bytes");
    expect(readFileSync(join(root, "wiki/generated.md"), "utf8")).toBe("generated");
    expect(existsSync(join(root, ".git", "vex-wiki-inflight.json"))).toBe(true);
    await expect(wiki.run({ kind: "on-demand" }, new AbortController().signal)).rejects.toThrow(/index content does not match/i);
    expect(git(root, ["show", ":wiki/generated.md"])).toBe("owner staged bytes");
    expect(readFileSync(join(root, "wiki/generated.md"), "utf8")).toBe("generated");
    expect(existsSync(join(root, ".git", "vex-wiki-inflight.json"))).toBe(true);
    await wiki.close();
  });

  it("marks a successfully created commit committed when Git reports a later command failure", async () => {
    const home = join(dir, "home");
    const { remote } = makeRemote(join(dir, "seed"));
    const work = join(dir, "seed", "work");
    commit(work, { "wiki/base.md": "base" }, "2026-10-01T10:00:00+0000");
    const root = join(home, "wiki", key(remote));
    let commitSucceeded = false;
    let injected = false;
    const failingRunner: GitRunner = async (args, options) => {
      if (args.includes("commit")) commitSucceeded = true;
      if (commitSucceeded && !injected && args[0] === "rev-parse" && args[1] === "HEAD") {
        injected = true;
        throw new Error("simulated reply failure after successful commit");
      }
      return fileRun(args, options);
    };
    const options: Partial<WikiOptions> = {
      run: failingRunner,
      runAgent: async (_prompt, context) => {
        const path = "wiki/generated.md";
        const target = join(context.repo.root, path);
        await context.marker.recordIntent(path, await fingerprint(target));
        writeFileSync(target, "generated");
        await context.marker.recordAfter(path, await fingerprint(target));
        return "ok";
      },
    };
    const wiki = makeWiki(home, remote, options);
    await wiki.init();

    const source = { url: "https://example.com/commit-marker", text: "Original" };
    const result = await wiki.run({ kind: "on-demand", source }, new AbortController().signal);

    expect(injected).toBe(true);
    expect(result).toMatchObject({ publication: "pending" });
    expect(git(root, ["show", "HEAD:wiki/generated.md"])).toBe("generated");
    expect(JSON.parse(readFileSync(join(root, ".git", "vex-wiki-inflight.json"), "utf8"))).toMatchObject({ phase: "committed" });
    expect(JSON.parse(readFileSync(join(home, "state", "wiki.json"), "utf8"))).toMatchObject({ failureStreak: 1, nextAttemptAt: expect.any(Number) });
    await wiki.close();
    const reopened = makeWiki(home, remote, options);
    await reopened.init();
    await reopened.run({ kind: "on-demand", source }, new AbortController().signal);
    expect((git(remote, ["log", "main", "--format=%B"]).match(/Vex-Batch:/g) ?? [])).toHaveLength(1);
    expect(git(remote, ["show", "main:wiki/generated.md"])).toBe("generated");
    await reopened.close();
  });

  it("returns a pending receipt when push succeeds but state settlement fails, then recovers after reopen", async () => {
    const home = join(dir, "home");
    const { remote } = makeRemote(join(dir, "seed"));
    commit(join(dir, "seed", "work"), { "wiki/base.md": "base" }, "2026-10-01T10:00:00+0000");
    mkdirSync(join(home, "state"), { recursive: true });
    const statePath = join(home, "state", "wiki.json");
    let brokeState = false;
    const failingRunner: GitRunner = async (args, options) => {
      const result = await fileRun(args, options);
      if (args[0] === "push" && !brokeState) {
        brokeState = true;
        mkdirSync(statePath);
      }
      return result;
    };
    const options: Partial<WikiOptions> = {
      run: failingRunner,
      runAgent: async (_prompt, context) => {
        const target = join(context.repo.root, "wiki/generated.md");
        await context.marker.recordIntent("wiki/generated.md", await fingerprint(target));
        writeFileSync(target, "generated");
        await context.marker.recordAfter("wiki/generated.md", await fingerprint(target));
        return "ok";
      },
    };
    const wiki = makeWiki(home, remote, options);
    await wiki.init();
    const source = { url: "https://example.com/state-failure", text: "Original" };
    const pending = await wiki.run({ kind: "on-demand", source }, new AbortController().signal);
    expect(pending).toMatchObject({ publication: "pending", pages: ["wiki/generated.md"] });
    expect(git(remote, ["show", "main:wiki/generated.md"])).toBe("generated");
    expect(existsSync(join(home, "wiki", key(remote), ".git", "vex-wiki-inflight.json"))).toBe(true);
    await wiki.close();

    rmSync(statePath, { recursive: true, force: true });
    const reopened = makeWiki(home, remote, { runAgent: async () => { throw new Error("recovered batch must not compile again"); } });
    await reopened.init();
    const recovered = await reopened.run({ kind: "on-demand", source }, new AbortController().signal);
    expect(recovered).toMatchObject({ batchId: pending.batchId, publication: "published" });
    expect((git(remote, ["log", "main", "--format=%B"]).match(/Vex-Batch:/g) ?? [])).toHaveLength(1);
    expect(existsSync(join(home, "wiki", key(remote), ".git", "vex-wiki-inflight.json"))).toBe(false);
    await reopened.close();
  });

  it("settles writes that return to the base bytes as a no-change run", async () => {
    const home = join(dir, "home");
    const { wiki, root } = await seed(home, {
      runAgent: async (_prompt, context) => {
        const path = "wiki/a.md";
        const target = join(context.repo.root, path);
        const original = readFileSync(target, "utf8");
        await context.marker.recordIntent(path, await fingerprint(target));
        writeFileSync(target, "temporary");
        await context.marker.recordAfter(path, await fingerprint(target));
        await context.marker.recordIntent(path, await fingerprint(target));
        writeFileSync(target, original);
        await context.marker.recordAfter(path, await fingerprint(target));
        return "ok";
      },
    });
    await wiki.init();
    const head = git(root, ["rev-parse", "HEAD"]).trim();

    await expect(wiki.run({ kind: "on-demand" }, new AbortController().signal)).resolves.toMatchObject({ publication: "not-needed" });

    expect(git(root, ["rev-parse", "HEAD"]).trim()).toBe(head);
    expect(readFileSync(join(root, "wiki/a.md"), "utf8")).toBe("v1");
    expect(existsSync(join(root, ".git", "vex-wiki-inflight.json"))).toBe(false);
    await wiki.close();
  });

  it("does not clear a no-change marker over different staged bytes", async () => {
    const home = join(dir, "home");
    const { wiki, root } = await seed(home, {
      runAgent: async (_prompt, context) => {
        const path = "wiki/a.md";
        const target = join(context.repo.root, path);
        await context.marker.recordIntent(path, await fingerprint(target));
        writeFileSync(target, "temporary");
        await context.marker.recordAfter(path, await fingerprint(target));
        await context.marker.recordIntent(path, await fingerprint(target));
        writeFileSync(target, "v1");
        await context.marker.recordAfter(path, await fingerprint(target));
        writeFileSync(target, "staged owner bytes");
        git(context.repo.root, ["add", "--", path]);
        writeFileSync(target, "v1");
        return "ok";
      },
    });
    await wiki.init();

    await expect(wiki.run({ kind: "on-demand" }, new AbortController().signal)).rejects.toThrow(/index content does not match/i);

    expect(git(root, ["show", ":wiki/a.md"])).toBe("staged owner bytes");
    expect(readFileSync(join(root, "wiki/a.md"), "utf8")).toBe("v1");
    expect(existsSync(join(root, ".git", "vex-wiki-inflight.json"))).toBe(true);
    await wiki.close();
  });

  it("restores an archived link when compilation fails", async () => {
    const home = join(dir, "home");
    const url = "https://example.com/failure";
    const path = `raw/link-${createHash("sha256").update(url).digest("hex")}.md`;
    const { wiki, root } = await seed(home, { runAgent: async () => { throw new Error("compile failed"); } });
    await wiki.init();
    await expect(wiki.run({ kind: "on-demand", source: { url, text: "Original text" } }, new AbortController().signal)).rejects.toThrow("compile failed");
    expect(existsSync(join(root, path))).toBe(false);
    expect(git(root, ["status", "--porcelain"])).toBe("");
    await wiki.close();
  });

  it("on-demand run calls the agent once with the source and leaves the scan cursor unchanged", async () => {
    const home = join(dir, "home");
    const prompts: string[] = [];
    const { wiki } = await seed(home, {
      runAgent: async (prompt, context) => {
        prompts.push(prompt);
        const abs = join(context.repo.root, "wiki/a.md");
        await context.marker.recordIntent("wiki/a.md", await fingerprint(abs));
        writeFileSync(abs, "v2");
        await context.marker.recordAfter("wiki/a.md", await fingerprint(abs));
        return "ok";
      },
    });
    await wiki.init();
    mkdirSync(join(home, "state"), { recursive: true });
    writeFileSync(join(home, "state", "wiki.json"), JSON.stringify({ ...emptyState(), lastScanCommit: "keep-me" }));

    const result = await wiki.run(
      { kind: "on-demand", source: { title: "Title", url: "https://example.com/x", text: "Body" } },
      new AbortController().signal,
    );

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("https://example.com/x");
    expect(prompts[0]).toContain("Body");
    expect(result.publication).toBe("published");
    expect(JSON.parse(readFileSync(join(home, "state", "wiki.json"), "utf8")).lastScanCommit).toBe("keep-me");
    await wiki.close();
  });
});

describe("dueWikiWork", () => {
  it("bootstraps a pending wiki only after the backoff gate opens, whatever the cadence", () => {
    expect(dueWikiWork({ bootstrap: "pending", gate: 2000, now: 1000, cadenceDue: true })).toBeNull();
    expect(dueWikiWork({ bootstrap: "pending", gate: 2000, now: 2000, cadenceDue: false })).toBe("bootstrap");
    expect(dueWikiWork({ bootstrap: "pending", gate: null, now: 0, cadenceDue: false })).toBe("bootstrap");
  });
  it("does nothing while the bootstrap preview awaits review", () => {
    expect(dueWikiWork({ bootstrap: "awaiting-review", gate: null, now: 1000, cadenceDue: true })).toBeNull();
  });
  it("runs a bootstrapped wiki only when both the cadence and the backoff gate allow it", () => {
    expect(dueWikiWork({ bootstrap: "done", gate: null, now: 1000, cadenceDue: false })).toBeNull();
    expect(dueWikiWork({ bootstrap: "done", gate: 5000, now: 1000, cadenceDue: true })).toBeNull();
    expect(dueWikiWork({ bootstrap: "done", gate: 1000, now: 1000, cadenceDue: true })).toBe("scheduled");
  });
});

describe("Wiki notes copy", () => {
  it("fast-forwards the shared clone for note reads at most once a minute", async () => {
    const home = join(dir, "home");
    let now = Date.parse("2026-10-02T10:00:00Z");
    const { wiki, root } = await seed(home, { now: () => now });
    await wiki.init();
    const work = join(dir, "seed", "work");

    commit(work, { "notes/first.md": "first" }, "2026-10-02T10:00:00+0000");
    const copy = await wiki.notesCopy.readableCopy();
    expect(copy.root).toBe(root);
    expect(copy.source).toMatch(/^git copy synced /);
    expect(readFileSync(join(root, "notes/first.md"), "utf8")).toBe("first");

    commit(work, { "notes/second.md": "second" }, "2026-10-02T10:01:00+0000");
    now += 30_000;
    await wiki.notesCopy.readableCopy();
    expect(existsSync(join(root, "notes/second.md"))).toBe(false);
    now += 30_000;
    await wiki.notesCopy.readableCopy();
    expect(readFileSync(join(root, "notes/second.md"), "utf8")).toBe("second");
    await wiki.close();
  });

  it("leaves a dirty tree and an unpublished bootstrap preview where they are", async () => {
    const home = join(dir, "home");
    let now = Date.parse("2026-10-02T10:00:00Z");
    const { wiki, root } = await seed(home, {
      now: () => now,
      runAgent: async (_prompt, context) => {
        const abs = join(context.repo.root, "wiki/a.md");
        await context.marker.recordIntent("wiki/a.md", await fingerprint(abs));
        writeFileSync(abs, "preview");
        await context.marker.recordAfter("wiki/a.md", await fingerprint(abs));
        return "ok";
      },
    });
    const work = join(dir, "seed", "work");
    commit(work, { "notes/note.md": "n1" }, "2026-10-02T10:00:00+0000");
    await wiki.init();

    writeFileSync(join(root, "stray.md"), "owner edit");
    commit(work, { "notes/later.md": "later" }, "2026-10-02T10:01:00+0000");
    await wiki.notesCopy.readableCopy();
    expect(existsSync(join(root, "notes/later.md"))).toBe(false);
    rmSync(join(root, "stray.md"));

    await wiki.run({ kind: "bootstrap" }, new AbortController().signal);
    const previewHead = git(root, ["rev-parse", "HEAD"]).trim();
    commit(work, { "notes/after-preview.md": "after" }, "2026-10-02T10:02:00+0000");
    now += 60_000;
    expect((await wiki.notesCopy.readableCopy()).source).toMatch(/^git copy synced /);
    expect(git(root, ["rev-parse", "HEAD"]).trim()).toBe(previewHead);
    expect(existsSync(join(root, "notes/after-preview.md"))).toBe(false);
    await wiki.close();
  });

  it("serves note reads during a wiki run without waiting for its lock", async () => {
    const home = join(dir, "home");
    let duringRun: { root: string; source: string } | undefined;
    const holder: { wiki?: Wiki } = {};
    const { wiki, root } = await seed(home, {
      runAgent: async () => { duringRun = await holder.wiki!.notesCopy.readableCopy(); return "ok"; },
    });
    holder.wiki = wiki;
    commit(join(dir, "seed", "work"), { "notes/note.md": "n1" }, "2026-10-02T10:00:00+0000");
    await wiki.init();
    await wiki.run({ kind: "scheduled" }, new AbortController().signal);
    expect(duringRun?.root).toBe(root);
    await wiki.close();
  });

  it("refuses reads before the clone is opened", async () => {
    const { wiki } = await seed(join(dir, "home"));
    await expect(wiki.notesCopy.readableCopy()).rejects.toThrow(/still opening/);
  });
});
