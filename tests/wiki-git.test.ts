import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GitRunner } from "../src/vault/git.js";
import { WikiRepo, type WikiRepoOptions } from "../src/wiki/git.js";
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
