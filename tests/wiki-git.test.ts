import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GitRunner } from "../src/vault/git.js";
import { parseTrailers, WikiRepo, type WikiRepoOptions } from "../src/wiki/git.js";
import { commit, git, makeRemote } from "./helpers/gitRemote.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

let dir: string;
beforeEach(async () => {
  dir = await makeTmpDir();
});
afterEach(async () => {
  await removeTmpDir(dir);
});

function repo(url: string, extra: Partial<WikiRepoOptions> = {}): WikiRepo {
  return new WikiRepo({ home: join(dir, "home"), url, protocols: "file", ...extra });
}

function key(url: string, branch?: string): string {
  return createHash("sha256").update(`${url}\n${branch ?? ""}`).digest("hex").slice(0, 12);
}

describe("WikiRepo", () => {
  it("clones once and reopens the same root", async () => {
    const { remote, work } = makeRemote(join(dir, "seed"));
    commit(work, { "wiki/a.md": "v1" }, "2026-10-01T10:00:00+0000");
    const r = repo(remote);
    expect(r.root).toBe(join(dir, "home", "wiki", key(remote)));
    const first = await r.open();
    expect(first).toBe(r.root);
    expect(readFileSync(join(first, "wiki", "a.md"), "utf8")).toBe("v1");
    writeFileSync(join(first, "local.txt"), "keep");
    const reopened = await repo(remote).open();
    expect(reopened).toBe(first);
    expect(existsSync(join(reopened, "local.txt"))).toBe(true);
  });

  it("follows the configured branch and keys the root by it", async () => {
    const { remote, work } = makeRemote(join(dir, "seed"));
    commit(work, { "a.md": "main" }, "2026-10-01T10:00:00+0000");
    git(work, ["checkout", "-b", "dev"]);
    commit(work, { "a.md": "dev" }, "2026-10-02T10:00:00+0000", "dev");
    const r = repo(remote, { branch: "dev" });
    expect(r.root).toBe(join(dir, "home", "wiki", key(remote, "dev")));
    const root = await r.open();
    expect(readFileSync(join(root, "a.md"), "utf8")).toBe("dev");
  });

  it("commits only the given paths and pushes them", async () => {
    const { remote, work } = makeRemote(join(dir, "seed"));
    commit(work, { "wiki/a.md": "v1", "notes/n.md": "n" }, "2026-10-01T10:00:00+0000");
    const r = repo(remote);
    const root = await r.open();
    writeFileSync(join(root, "wiki", "a.md"), "v2");
    writeFileSync(join(root, "notes", "n.md"), "changed");
    const before = await r.head();
    const sha = await r.commit(["wiki/a.md"], "update a");
    expect(sha).not.toBe(before);
    expect(sha).toBe(await r.head());
    expect(await r.status()).toContain(" M notes/n.md");
    expect(await r.isAncestor(sha, before)).toBe(false);
    expect(await r.isAncestor(before, sha)).toBe(true);
    await r.push();
    await r.fetch();
    const origin = await r.originHead();
    expect(await r.isAncestor(sha, origin)).toBe(true);
    expect(await r.isAncestor(origin, sha)).toBe(true);
  });

  it("reports porcelain status for a dirty tree", async () => {
    const { remote, work } = makeRemote(join(dir, "seed"));
    commit(work, { "wiki/a.md": "v1" }, "2026-10-01T10:00:00+0000");
    const r = repo(remote);
    const root = await r.open();
    expect(await r.status()).toEqual([]);
    mkdirSync(join(root, "wiki"), { recursive: true });
    writeFileSync(join(root, "wiki", "b.md"), "new");
    expect(await r.status()).toContain("?? wiki/b.md");
    writeFileSync(join(root, "wiki", "a.md"), "v2");
    expect(await r.status()).toContain(" M wiki/a.md");
  });

  it("sends the token only through the environment and never reports it", async () => {
    const basic = Buffer.from("me:s3cr3t").toString("base64");
    const seen: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const run: GitRunner = async (args, { env }) => {
      seen.push({ args, env });
      throw new Error(`fatal: Authentication failed\nAuthorization: Basic ${basic} s3cr3t`);
    };
    const r = new WikiRepo({ home: join(dir, "home"), url: "https://git.example/me/vault.git", username: "me", token: "s3cr3t", run });
    const error = await r.open().catch((e: Error) => e.message);
    expect(error).toContain("Authentication failed");
    expect(error).not.toContain("s3cr3t");
    expect(error).not.toContain(basic);
    expect(seen.length).toBeGreaterThan(0);
    for (const { args, env } of seen) {
      expect(args.join(" ")).not.toContain("s3cr3t");
      expect(env.GIT_CONFIG_KEY_0).toBe("http.extraHeader");
      expect(env.GIT_CONFIG_VALUE_0).toBe(`Authorization: Basic ${basic}`);
      expect(env.GIT_TERMINAL_PROMPT).toBe("0");
      expect(env.GIT_ALLOW_PROTOCOL).toBe("http:https");
    }
  });

  it("parses trailers", () => {
    expect(parseTrailers("subject\n\nVex-Batch: x\nVex-Kind: scheduled\nVex-Scan-Base: abc")).toEqual({ "Vex-Batch": ["x"], "Vex-Kind": ["scheduled"], "Vex-Scan-Base": ["abc"] });
  });

  it("parses trailer keys case-insensitively and keeps every value", () => {
    expect(parseTrailers("subject\n\nvex-batch: first\nVex-Batch: second\nother text")).toEqual({ "vex-batch": ["first", "second"] });
  });

  it("points at the token when git cannot authenticate", async () => {
    const run: GitRunner = async () => {
      throw new Error("fatal: could not read Username for 'https://git.example': terminal prompts disabled");
    };
    const url = "https://git.example/me/vault.git";
    const withToken = await new WikiRepo({ home: join(dir, "home"), url, token: "s3cr3t", run }).open().catch((e: Error) => e.message);
    expect(withToken).toContain("could not read Username");
    expect(withToken).toContain("check vault.token (needs read access to the repository) and vault.username");
    const withoutToken = await new WikiRepo({ home: join(dir, "home"), url, run }).open().catch((e: Error) => e.message);
    expect(withoutToken).toContain("the repository may be private; set vault.token");
  });

  it("says so when git is not installed", async () => {
    const run: GitRunner = async () => {
      throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
    };
    const error = await new WikiRepo({ home: join(dir, "home"), url: "https://git.example/me/vault.git", run }).open().catch((e: Error) => e.message);
    expect(error).toBe("git was not found; install git to use a wiki repository");
  });
});

describe("WikiRepo recovery and history", () => {
  it("aborts a conflicting rebase and leaves the tree clean", async () => {
    const { remote, work } = makeRemote(join(dir, "seed"));
    commit(work, { "wiki/a.md": "base" }, "2026-10-01T10:00:00+0000");
    const r = repo(remote);
    const root = await r.open();
    commit(work, { "wiki/a.md": "remote" }, "2026-10-02T10:00:00+0000");
    writeFileSync(join(root, "wiki", "a.md"), "local");
    await r.commit(["wiki/a.md"], "local change");
    await r.fetch();
    await expect(r.rebase()).rejects.toThrow();
    expect(await r.status()).toEqual([]);
  });

  it("checkoutPaths restores only the named path", async () => {
    const { remote, work } = makeRemote(join(dir, "seed"));
    commit(work, { "wiki/a.md": "a1", "wiki/b.md": "b1" }, "2026-10-01T10:00:00+0000");
    const r = repo(remote);
    const root = await r.open();
    const base = await r.head();
    writeFileSync(join(root, "wiki", "a.md"), "a2");
    writeFileSync(join(root, "wiki", "b.md"), "b2");
    await r.checkoutPaths(base, ["wiki/a.md"]);
    expect(readFileSync(join(root, "wiki", "a.md"), "utf8")).toBe("a1");
    expect(readFileSync(join(root, "wiki", "b.md"), "utf8")).toBe("b2");
    expect(await r.status()).toContain(" M wiki/b.md");
  });

  it("resetHard moves HEAD back and discards worktree edits", async () => {
    const { remote, work } = makeRemote(join(dir, "seed"));
    commit(work, { "wiki/a.md": "v1" }, "2026-10-01T10:00:00+0000");
    const r = repo(remote);
    const root = await r.open();
    const base = await r.head();
    writeFileSync(join(root, "wiki", "a.md"), "v2");
    await r.commit(["wiki/a.md"], "v2");
    await r.resetHard(base);
    expect(await r.head()).toBe(base);
    expect(readFileSync(join(root, "wiki", "a.md"), "utf8")).toBe("v1");
  });

  it("removeUntracked deletes only untracked paths", async () => {
    const { remote, work } = makeRemote(join(dir, "seed"));
    commit(work, { "wiki/a.md": "v1" }, "2026-10-01T10:00:00+0000");
    const r = repo(remote);
    const root = await r.open();
    writeFileSync(join(root, "wiki", "a.md"), "edited");
    mkdirSync(join(root, "wiki", "new"), { recursive: true });
    writeFileSync(join(root, "wiki", "new", "b.md"), "b");
    await r.removeUntracked(["wiki/new"]);
    expect(existsSync(join(root, "wiki", "new"))).toBe(false);
    expect(await r.status()).toContain(" M wiki/a.md");
  });

  it("reverts a commit under the bot identity", async () => {
    const { remote, work } = makeRemote(join(dir, "seed"));
    commit(work, { "wiki/a.md": "v1" }, "2026-10-01T10:00:00+0000");
    const r = repo(remote);
    const root = await r.open();
    const base = await r.head();
    writeFileSync(join(root, "wiki", "a.md"), "v2");
    const change = await r.commit(["wiki/a.md"], "change");
    const sha = await r.revert(change, "wiki: rollback\n\nVex-Rollback: rb1");
    expect(sha).not.toBe(change);
    expect(sha).toBe(await r.head());
    expect(readFileSync(join(root, "wiki", "a.md"), "utf8")).toBe("v1");
    expect(await r.isAncestor(base, sha)).toBe(true);
    expect(await r.isAncestor(change, sha)).toBe(true);
    expect(git(root, ["log", "-1", "--format=%an <%ae>"])).toBe("vex <vex@localhost>\n");
  });

  it("shows a file at a revision", async () => {
    const { remote, work } = makeRemote(join(dir, "seed"));
    commit(work, { "wiki/a.md": "v1" }, "2026-10-01T10:00:00+0000");
    const r = repo(remote);
    const root = await r.open();
    const base = await r.head();
    writeFileSync(join(root, "wiki", "a.md"), "v2");
    await r.commit(["wiki/a.md"], "v2");
    expect(await r.show(base, "wiki/a.md")).toBe("v1");
    expect(await r.show("HEAD", "wiki/a.md")).toBe("v2");
  });

  it("logs a revision range with messages that parseTrailers understands", async () => {
    const { remote, work } = makeRemote(join(dir, "seed"));
    commit(work, { "wiki/a.md": "v1" }, "2026-10-01T10:00:00+0000");
    const r = repo(remote);
    const root = await r.open();
    const base = await r.head();
    writeFileSync(join(root, "wiki", "a.md"), "v2");
    const sha = await r.commit(["wiki/a.md"], `wiki: ingest\n\nVex-Batch: b1\nVex-Kind: scheduled\nVex-Scan-Base: ${base}`);
    const out = await r.log(`${base}..HEAD`);
    const [logSha, body] = out.split("\0");
    expect(logSha).toBe(sha);
    expect(parseTrailers(body ?? "")).toMatchObject({ "Vex-Batch": ["b1"], "Vex-Kind": ["scheduled"], "Vex-Scan-Base": [base] });
  });

  it("diffNames reports added, modified and deleted markdown only", async () => {
    const { remote, work } = makeRemote(join(dir, "seed"));
    commit(work, { "wiki/a.md": "a", "wiki/b.md": "b", "wiki/keep.txt": "t" }, "2026-10-01T10:00:00+0000");
    const r = repo(remote);
    const root = await r.open();
    const from = await r.head();
    writeFileSync(join(root, "wiki", "a.md"), "a2");
    writeFileSync(join(root, "wiki", "c.md"), "c");
    rmSync(join(root, "wiki", "b.md"));
    writeFileSync(join(root, "wiki", "keep.txt"), "t2");
    const to = await r.commit(["wiki"], "batch");
    expect(await r.diffNames(from, to, "*.md")).toEqual([
      { path: "wiki/a.md", status: "M" },
      { path: "wiki/b.md", status: "D" },
      { path: "wiki/c.md", status: "A" },
    ]);
  });
});
