import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommitTimes, GitMirror, gitEnv, parseLog, runGit, type GitRunner } from "../src/vault/git.js";
import { commit, git, makeRemote } from "./helpers/gitRemote.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

let dir: string;
let src: string;
const clock = { now: 1_000_000 };
beforeEach(async () => {
  dir = await makeTmpDir();
  src = join(dir, "src");
  mkdirSync(src);
  clock.now = 1_000_000;
});
afterEach(async () => { await removeTmpDir(dir); });

function mirror(url: string, extra: Partial<ConstructorParameters<typeof GitMirror>[0]> = {}): GitMirror {
  return new GitMirror({ home: join(dir, "home"), url, protocols: "file", now: () => clock.now, ...extra });
}

describe("GitMirror", () => {
  it("clones, then follows new commits and force pushes", async () => {
    const { remote, work } = makeRemote(src);
    commit(work, { "Notes/a.md": "v1" }, "2026-10-01T10:00:00+0000");
    const m = mirror(remote);
    const first = await m.refresh();
    expect(first.error).toBeUndefined();
    expect(readFileSync(join(first.root!, "Notes/a.md"), "utf8")).toBe("v1");
    expect(first.syncedAt).toBe(clock.now);

    commit(work, { "Notes/a.md": "v2", "b.md": "new" }, "2026-10-02T10:00:00+0000");
    clock.now += 61_000;
    const second = await m.refresh();
    expect(readFileSync(join(second.root!, "Notes/a.md"), "utf8")).toBe("v2");
    expect(existsSync(join(second.root!, "b.md"))).toBe(true);

    git(work, ["reset", "--hard", "HEAD~1"]);
    commit(work, { "Notes/a.md": "rewritten" }, "2026-10-03T10:00:00+0000");
    clock.now += 61_000;
    const third = await m.refresh();
    expect(readFileSync(join(third.root!, "Notes/a.md"), "utf8")).toBe("rewritten");
    expect(existsSync(join(third.root!, "b.md"))).toBe(false);
  });

  it("follows the configured branch", async () => {
    const { remote, work } = makeRemote(src);
    commit(work, { "a.md": "main" }, "2026-10-01T10:00:00+0000");
    git(work, ["checkout", "-b", "dev"]);
    commit(work, { "a.md": "dev" }, "2026-10-02T10:00:00+0000", "dev");
    const state = await mirror(remote, { branch: "dev" }).refresh();
    expect(readFileSync(join(state.root!, "a.md"), "utf8")).toBe("dev");
  });

  it("updates at most once a minute and shares one update between concurrent callers", async () => {
    const { remote, work } = makeRemote(src);
    commit(work, { "a.md": "v1" }, "2026-10-01T10:00:00+0000");
    const run = vi.fn(runGit);
    const m = mirror(remote, { run });
    await m.refresh();
    const calls = run.mock.calls.length;
    clock.now += 30_000;
    await m.refresh();
    expect(run.mock.calls.length).toBe(calls);
    clock.now += 31_000;
    const [a, b] = await Promise.all([m.refresh(), m.refresh()]);
    expect(a).toBe(b);
    expect(run.mock.calls.length).toBeGreaterThan(calls);
  });

  it("keeps serving the last copy when the remote disappears, and says why", async () => {
    const { remote, work } = makeRemote(src);
    commit(work, { "a.md": "v1" }, "2026-10-01T10:00:00+0000");
    const warnings: string[] = [];
    const m = mirror(remote, { onWarning: (message) => warnings.push(message) });
    await m.refresh();
    renameSync(remote, `${remote}.gone`);
    clock.now += 61_000;
    const state = await m.refresh();
    expect(readFileSync(join(state.root!, "a.md"), "utf8")).toBe("v1");
    expect(state.error).toMatch(/fatal/);
    expect(state.syncedAt).toBe(1_000_000);
    expect(warnings[0]).toContain("could not be updated");
  });

  it("remembers when the copy was synced across restarts", async () => {
    const { remote, work } = makeRemote(src);
    commit(work, { "a.md": "v1" }, "2026-10-01T10:00:00+0000");
    await mirror(remote).refresh();
    renameSync(remote, `${remote}.gone`);
    clock.now += 500_000;
    const restarted = await mirror(remote).refresh();
    expect(restarted.root).not.toBeNull();
    expect(restarted.syncedAt).toBe(1_000_000);
    expect(restarted.error).toMatch(/fatal/);
  });

  it("reports a failed first clone without throwing, and retries at once", async () => {
    const missing = join(dir, "missing.git");
    const m = mirror(missing);
    const state = await m.refresh();
    expect(state.root).toBeNull();
    expect(state.error).toMatch(/fatal/);
    const { remote, work } = makeRemote(src);
    commit(work, { "a.md": "v1" }, "2026-10-01T10:00:00+0000");
    git(src, ["clone", "--bare", remote, missing]);
    const retry = await m.refresh();
    expect(retry.error).toBeUndefined();
    expect(readFileSync(join(retry.root!, "a.md"), "utf8")).toBe("v1");
  });

  it("starts a fresh copy when the address changes and removes the old one", async () => {
    const one = makeRemote(src);
    commit(one.work, { "a.md": "one" }, "2026-10-01T10:00:00+0000");
    const first = await mirror(one.remote).refresh();
    const two = join(dir, "two.git");
    git(src, ["clone", "--bare", one.remote, two]);
    const second = await mirror(two).refresh();
    expect(second.root).not.toBe(first.root);
    expect(existsSync(first.root!)).toBe(false);
    expect(readdirSync(join(dir, "home", "vault"))).toEqual([basename(second.root!)]);
  });

  it("passes the token only through the environment and never reports it", async () => {
    const basic = Buffer.from("me:s3cr3t").toString("base64");
    const seen: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const run: GitRunner = async (args, { env }) => {
      seen.push({ args, env });
      throw new Error(`fatal: Authentication failed\nAuthorization: Basic ${basic} s3cr3t`);
    };
    const warnings: string[] = [];
    const m = new GitMirror({ home: join(dir, "home"), url: "https://git.example/me/notes.git", username: "me", token: "s3cr3t", run, now: () => clock.now, onWarning: (message) => warnings.push(message) });
    const state = await m.refresh();
    expect(seen.length).toBeGreaterThan(0);
    for (const { args, env } of seen) {
      expect(args.join(" ")).not.toContain("s3cr3t");
      expect(env.GIT_CONFIG_KEY_0).toBe("http.extraHeader");
      expect(env.GIT_CONFIG_VALUE_0).toBe(`Authorization: Basic ${basic}`);
      expect(env.GIT_TERMINAL_PROMPT).toBe("0");
      expect(env.GIT_ALLOW_PROTOCOL).toBe("http:https");
    }
    const reported = JSON.stringify([state, warnings]);
    expect(reported).not.toContain("s3cr3t");
    expect(reported).not.toContain(basic);
    expect(state.error).toContain("Authentication failed");
  });

  it("points at the token when git cannot authenticate", async () => {
    const run: GitRunner = async () => { throw new Error("fatal: could not read Username for 'https://git.example': terminal prompts disabled"); };
    const url = "https://git.example/me/notes.git";
    const withToken = await mirror(url, { run, token: "s3cr3t" }).refresh();
    expect(withToken.error).toContain("could not read Username");
    expect(withToken.error).toContain("check vault.token (needs read access to the repository) and vault.username");
    const withoutToken = await mirror(url, { run }).refresh();
    expect(withoutToken.error).toContain("the repository may be private; set vault.token");
  });

  it("adds no token hint to unrelated failures", async () => {
    const run: GitRunner = async () => { throw new Error("fatal: repository 'https://git.example/me/notes.git' not found"); };
    const state = await mirror("https://git.example/me/notes.git", { run, token: "s3cr3t" }).refresh();
    expect(state.error).not.toContain("vault.token");
  });

  it("says so when git is not installed", async () => {
    const run: GitRunner = async () => { throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }); };
    const state = await mirror("https://git.example/me/notes.git", { run }).refresh();
    expect(state.error).toBe("git was not found; install git to use a vault url");
  });
});

describe("gitEnv", () => {
  it("sends no credentials without a token, defaults the username and passes proxies through", () => {
    vi.stubEnv("HTTPS_PROXY", "http://proxy:3128");
    try {
      const plain = gitEnv("/tmp/h");
      expect(plain.GIT_CONFIG_COUNT).toBeUndefined();
      expect(plain.HTTPS_PROXY).toBe("http://proxy:3128");
      expect(plain.HOME).toBe("/tmp/h");
      expect(plain.LC_ALL).toBe("C");
      expect(gitEnv("/tmp/h", { token: "t" }).GIT_CONFIG_VALUE_0).toBe(`Authorization: Basic ${Buffer.from("git:t").toString("base64")}`);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("parseLog", () => {
  it("keeps the newest commit time of each file", () => {
    const out = "\u000010\n\nA.md\nB.md\n\u00005\n\nA.md\nC.md\n";
    expect([...parseLog(out)]).toEqual([["A.md", 10_000], ["B.md", 10_000], ["C.md", 5_000]]);
  });
});

describe("CommitTimes", () => {
  it("reports the last commit time of each file", async () => {
    const { work } = makeRemote(src);
    commit(work, { "a.md": "1", "Sub/b.md": "1" }, "2026-10-01T10:00:00+0000");
    commit(work, { "a.md": "2" }, "2026-10-05T10:00:00+0000");
    const times = await new CommitTimes().get(work);
    expect(times?.get("a.md")).toBe(Date.parse("2026-10-05T10:00:00Z"));
    expect(times?.get("Sub/b.md")).toBe(Date.parse("2026-10-01T10:00:00Z"));
  });

  it("returns null outside a git repository and recomputes only when HEAD moves", async () => {
    const plain = join(dir, "plain");
    mkdirSync(plain);
    expect(await new CommitTimes().get(plain)).toBeNull();
    const { work } = makeRemote(src);
    commit(work, { "a.md": "1" }, "2026-10-01T10:00:00+0000");
    const run = vi.fn(runGit);
    const times = new CommitTimes(run);
    await times.get(work);
    const calls = run.mock.calls.length;
    await times.get(work);
    expect(run.mock.calls.length).toBe(calls + 1);
    commit(work, { "a.md": "2" }, "2026-10-02T10:00:00+0000");
    await times.get(work);
    expect(run.mock.calls.length).toBe(calls + 3);
  });
});
