import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runGit, type GitRunner } from "../src/vault/git.js";
import { fingerprint } from "../src/wiki/marker.js";
import { Wiki, type WikiOptions } from "../src/wiki/service.js";
import { emptyState } from "../src/wiki/state.js";
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
    readSkill: async () => "",
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
    await expect(second).resolves.toBeNull();
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

    const result = await wiki.rollback(new AbortController().signal);

    expect(result.reverted).toBe(true);
    expect(readFileSync(join(root, "wiki", "a.md"), "utf8")).toBe("v1");
    expect(JSON.parse(readFileSync(join(home, "state", "wiki.json"), "utf8")).lastBatchId).toBeNull();
    await wiki.close();
  });

  it("rollback completes a pending rollback instead of reverting twice", async () => {
    const home = join(dir, "home");
    const { wiki } = await seed(home);
    await wiki.init();
    const stateFile = join(home, "state", "wiki.json");
    mkdirSync(join(home, "state"), { recursive: true });
    writeFileSync(stateFile, JSON.stringify({ ...emptyState(), lastBatchId: "missing", rollback: { targetBatchId: "b", revertId: "r" } }));

    const pending = await wiki.rollback(new AbortController().signal);

    expect(pending.message).toMatch(/pending rollback|nothing/i);
    await wiki.close();
  });

  it("approveBootstrap publishes the preview and marks bootstrap done", async () => {
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
    expect(readFileSync(join(root, "wiki", "a.md"), "utf8")).toBe("v2");

    const approved = await wiki.approveBootstrap(new AbortController().signal);

    expect(approved.pushed).toBe(true);
    expect(JSON.parse(readFileSync(join(home, "state", "wiki.json"), "utf8")).bootstrap).toBe("done");
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

  it("completes an empty-vault bootstrap instead of relaunching it", async () => {
    const home = join(dir, "home");
    const { wiki } = await seed(home, {
      runAgent: async () => {
        throw new Error("the agent must not run for an empty vault");
      },
    });
    await wiki.init();

    const result = await wiki.run({ kind: "bootstrap" }, new AbortController().signal);

    expect(result).toBeNull();
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
    const chunks = [["notes/a.md", "notes/b.md"], ["notes/c.md"]];
    const { wiki, root } = await seed(home, {
      maxNotesPerRun: 2,
      runAgent: async (prompt, context) => {
        const paths = chunks[prompts.length] ?? [];
        prompts.push(prompt);
        for (const path of paths) {
          const abs = join(context.repo.root, path);
          await context.marker.recordIntent(path, await fingerprint(abs));
          writeFileSync(abs, `${readFileSync(abs, "utf8")} edited`);
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
    expect(result).not.toBeNull();
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

    expect(result).toBeNull();
    expect(calls).toBe(0);
    expect(JSON.parse(readFileSync(join(home, "state", "wiki.json"), "utf8")).lastScanCommit).toBeTruthy();
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
    expect(result).not.toBeNull();
    expect(JSON.parse(readFileSync(join(home, "state", "wiki.json"), "utf8")).lastScanCommit).toBe("keep-me");
    await wiki.close();
  });
});
