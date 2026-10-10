import { createHash } from "node:crypto";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { gitEnv, runGit, type GitRunner } from "../vault/git.js";

export interface WikiRepoOptions {
  home: string;
  url: string;
  branch?: string;
  username?: string;
  token?: string;
  run?: GitRunner;
  protocols?: string;
  onWarning?: (message: string) => void;
}

const CLONE_TIMEOUT_MS = 300_000;
const GIT_TIMEOUT_MS = 60_000;
const AUTH_FAILURE = /could not read Username|terminal prompts disabled|Authentication failed|Access denied|returned error: (401|403)|Invalid (username|credentials)/i;

/** gitEnv isolates HOME, so git cannot auto-detect a committer identity; every wiki commit uses this fixed bot identity. */
const IDENTITY = ["-c", "user.name=vex", "-c", "user.email=vex@localhost"];

const basicAuth = (auth: { username?: string; token?: string }): string | undefined =>
  auth.token ? Buffer.from(`${auth.username || "git"}:${auth.token}`).toString("base64") : undefined;

function scrub(message: string, auth: { username?: string; token?: string }): string {
  let text = message;
  for (const secret of [basicAuth(auth), auth.token]) if (secret) text = text.split(secret).join("***");
  return text.replace(/authorization:[^\n]*/gi, "Authorization: ***");
}

/** Owner-facing hint for the common "git could not authenticate" failures, which git itself reports without mentioning the token. */
const authHint = (hasToken: boolean): string =>
  hasToken ? "check vault.token (needs read access to the repository) and vault.username" : "the repository may be private; set vault.token";

const tail = (message: string): string => {
  const lines = message.split("\n").map((line) => line.trim()).filter(Boolean);
  const important = lines.filter((line) => /^(fatal|error):/i.test(line));
  return (important.length ? important : lines).slice(0, 2).join(" ").slice(0, 300);
};

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

/**
 * The writable working copy of the notes vault that the wiki subsystem writes into.
 * Unlike `GitMirror` it never resets to the remote: local commits and uncommitted files are the transaction.
 */
export class WikiRepo {
  private readonly dir: string;
  private readonly rootPath: string;
  private readonly run: GitRunner;

  constructor(private readonly opts: WikiRepoOptions) {
    this.dir = join(opts.home, "wiki");
    const key = createHash("sha256").update(`${opts.url}\n${opts.branch ?? ""}`).digest("hex").slice(0, 12);
    this.rootPath = join(this.dir, key);
    this.run = opts.run ?? runGit;
  }

  get root(): string {
    return this.rootPath;
  }

  /** Clones the repository on first use, then returns the same root on every later call. */
  async open(): Promise<string> {
    if (!(await exists(join(this.rootPath, ".git")))) await this.clone();
    return this.rootPath;
  }

  async fetch(): Promise<void> {
    await this.git(["fetch", "--no-tags", "--prune", "origin"]);
  }

  async head(): Promise<string> {
    return (await this.git(["rev-parse", "HEAD"])).trim();
  }

  async originHead(): Promise<string> {
    return (await this.git(["rev-parse", `origin/${this.opts.branch ?? "HEAD"}`])).trim();
  }

  async isAncestor(a: string, b: string): Promise<boolean> {
    try {
      await this.git(["merge-base", "--is-ancestor", a, b]);
      return true;
    } catch (error) {
      if ((error as { code?: unknown }).code === 1) return false;
      throw error;
    }
  }

  /** Porcelain status lines, e.g. `" M wiki/a.md"` or `"?? wiki/b.md"`. */
  async status(): Promise<string[]> {
    return (await this.git(["status", "--porcelain"])).split("\n").filter((line) => line !== "");
  }

  async commit(paths: string[], message: string): Promise<string> {
    await this.git(["add", "--", ...paths]);
    await this.git([...IDENTITY, "commit", "-m", message]);
    return this.head();
  }

  async push(): Promise<void> {
    await this.git(["push", "origin", this.opts.branch ? `HEAD:${this.opts.branch}` : "HEAD"]);
  }

  /** Path-limited restore from a revision, leaving every other working-tree change in place. */
  async checkoutPaths(rev: string, paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.git(["checkout", rev, "--", ...paths]);
  }

  /** Deletes the given untracked paths (and untracked content under them); tracked files are never touched. */
  async removeUntracked(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.git(["clean", "-fd", "--", ...paths]);
  }

  async resetHard(rev: string): Promise<void> {
    await this.git(["reset", "--hard", rev]);
  }

  /** Reverts `sha` without committing, then commits the result under the bot identity; returns the new HEAD. */
  async revert(sha: string, message: string): Promise<string> {
    await this.git(["revert", "--no-commit", sha]);
    await this.git([...IDENTITY, "commit", "-m", message]);
    return this.head();
  }

  async show(rev: string, path: string): Promise<string> {
    return this.git(["show", `${rev}:${path}`]);
  }

  /** Rebases onto the remote branch; on conflict the rebase is aborted so the caller only sees the error, not a half-rebased tree. */
  async rebase(): Promise<void> {
    try {
      await this.git(["rebase", `origin/${this.opts.branch ?? "HEAD"}`]);
    } catch (error) {
      await this.git(["rebase", "--abort"]).catch(() => undefined);
      throw error;
    }
  }

  /** `git diff --name-status` reduced to added/modified/deleted paths; other statuses are dropped. */
  async diffNames(from: string, to: string, glob: string): Promise<Array<{ path: string; status: "A" | "M" | "D" }>> {
    const output = await this.git(["diff", "--name-status", "--no-renames", `${from}..${to}`, "--", glob]);
    const entries: Array<{ path: string; status: "A" | "M" | "D" }> = [];
    for (const line of output.split("\n")) {
      if (line === "") continue;
      const [status, path] = line.split("\t");
      if (path === undefined) continue;
      if (status === "A" || status === "M" || status === "D") entries.push({ path, status });
    }
    return entries;
  }

  /** Raw `git log --format=%H%x00%B%x00` output for a revision range; the records are NUL-separated for the caller to parse. */
  async log(spec: string): Promise<string> {
    return this.git(["log", "--format=%H%x00%B%x00", spec]);
  }

  private async clone(): Promise<void> {
    const tmp = `${this.rootPath}.tmp`;
    await mkdir(this.dir, { recursive: true });
    await rm(tmp, { recursive: true, force: true });
    await this.git(["clone", "--no-tags", "--single-branch", ...(this.opts.branch ? ["--branch", this.opts.branch] : []), "--", this.opts.url, tmp], null, CLONE_TIMEOUT_MS);
    await rm(this.rootPath, { recursive: true, force: true });
    await rename(tmp, this.rootPath);
  }

  /** `null` runs outside the root, which does not exist yet during the initial clone. */
  private async git(args: string[], cwd: string | null = this.rootPath, timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
    try {
      return await this.run(args, { cwd: cwd ?? undefined, env: gitEnv(this.dir, this.opts, this.opts.protocols), timeoutMs });
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === "ENOENT") throw new Error("git was not found; install git to use a wiki repository");
      const message = tail(scrub(error instanceof Error ? error.message : String(error), this.opts));
      throw Object.assign(new Error(AUTH_FAILURE.test(message) ? `${message}; ${authHint(Boolean(this.opts.token))}` : message), { code });
    }
  }
}

const TRAILER_LINE = /^\s*([A-Za-z0-9][A-Za-z0-9-]*):\s?(.*?)\s*$/;

/**
 * Trailer lines (`Key: value`) from a commit message, keyed case-insensitively.
 * A key keeps the spelling of its first occurrence and collects the value of every line it appears on.
 */
export function parseTrailers(message: string): Record<string, string[]> {
  const trailers: Record<string, string[]> = {};
  const spellings = new Map<string, string>();
  for (const line of message.split("\n")) {
    const match = TRAILER_LINE.exec(line);
    const rawKey = match?.[1];
    if (!rawKey) continue;
    const lower = rawKey.toLowerCase();
    const key = spellings.get(lower) ?? rawKey;
    spellings.set(lower, key);
    (trailers[key] ??= []).push(match?.[2] ?? "");
  }
  return trailers;
}
