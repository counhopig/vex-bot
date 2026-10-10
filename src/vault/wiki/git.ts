import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readlink, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../../store/atomic.js";
import { gitEnv, runGit, type GitRunner } from "../git.js";
import type { FileFingerprint } from "./marker.js";

export type { GitRunner };

export class WikiIntegrityError extends Error {
  constructor(message: string) { super(message); this.name = "WikiIntegrityError"; }
}

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

interface RollbackExpectation {
  id: string;
  targetBatchId: string;
  paths: Array<{ path: string; fingerprint: FileFingerprint }>;
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
    await this.assertIdentity();
    const branch = await this.expectedBranch();
    const acceptedRef = "refs/vex/wiki-remote-tip";
    const acceptedTip = await this.ref(acceptedRef);
    const previousTip = acceptedTip ?? await this.ref(`refs/remotes/origin/${branch}`);
    if (acceptedTip === null && previousTip !== null) await this.updateRef(acceptedRef, previousTip);
    await this.git(["fetch", "--no-tags", "--prune", "origin"]);
    const refreshedTip = await this.ref(`refs/remotes/origin/${branch}`);
    if (previousTip !== null && refreshedTip === null) throw new WikiIntegrityError(`wiki remote branch ${branch} disappeared; preserving local repository`);
    if (previousTip !== null && refreshedTip !== null && !(await this.isAncestor(previousTip, refreshedTip))) {
      throw new WikiIntegrityError(`wiki remote branch ${branch} was rewritten; preserving local repository`);
    }
    if (refreshedTip !== null) await this.updateRef(acceptedRef, refreshedTip);
  }

  async originUrls(): Promise<{ fetch: string[]; push: string[] }> {
    const values = async (args: string[]): Promise<string[]> => {
      try { return (await this.git(args)).split("\n").filter(Boolean); }
      catch (error) { if ((error as { code?: unknown }).code === 1) return []; throw error; }
    };
    return {
      fetch: await values(["remote", "get-url", "--all", "origin"]),
      push: await values(["remote", "get-url", "--push", "--all", "origin"]),
    };
  }

  async expectedBranch(): Promise<string> {
    if (this.opts.branch) return this.opts.branch.replace(/^refs\/heads\//, "");
    try {
      return (await this.git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])).trim().replace(/^origin\//, "");
    } catch {
      throw new WikiIntegrityError("wiki origin/HEAD does not identify the configured default branch");
    }
  }

  async activeBranch(): Promise<string> {
    try {
      return (await this.git(["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
    } catch {
      throw new WikiIntegrityError("wiki HEAD is detached; preserving local repository");
    }
  }

  async assertIdentity(): Promise<void> {
    let urls: { fetch: string[]; push: string[] };
    try { urls = await this.originUrls(); }
    catch { throw new WikiIntegrityError("wiki origin remote is missing or unreadable; preserving local repository"); }
    const expected = this.opts.url;
    if (urls.fetch.length !== 1 || urls.fetch[0] !== expected || urls.push.some((url) => url !== expected)) {
      throw new WikiIntegrityError("wiki origin URL does not match the configured repository URL");
    }
    const branch = await this.expectedBranch();
    if (await this.activeBranch() !== branch) throw new WikiIntegrityError(`wiki active branch does not match expected origin branch ${branch}`);
  }

  async head(): Promise<string> {
    return (await this.git(["rev-parse", "HEAD"])).trim();
  }

  async originHead(): Promise<string> {
    return (await this.git(["rev-parse", `origin/${this.opts.branch ?? "HEAD"}`])).trim();
  }

  /** Resolves a ref (branch, tag, or `refs/...` path) to its SHA, or `null` when the ref does not exist. */
  async ref(name: string): Promise<string | null> {
    try {
      return (await this.git(["rev-parse", "--verify", "--quiet", name])).trim();
    } catch (error) {
      if ((error as { code?: unknown }).code === 1) return null;
      throw error;
    }
  }

  async updateRef(name: string, sha: string): Promise<void> {
    await this.git(["update-ref", name, sha]);
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

  async mergeBase(a: string, b: string): Promise<string | null> {
    try { return (await this.git(["merge-base", a, b])).trim(); }
    catch (error) { if ((error as { code?: unknown }).code === 1) return null; throw error; }
  }

  /** Porcelain status lines, e.g. `" M wiki/a.md"` or `"?? wiki/b.md"`. */
  async status(): Promise<string[]> {
    return (await this.git(["status", "--porcelain"])).split("\n").filter((line) => line !== "");
  }

  /** Structured status records from porcelain v1's NUL-delimited format. */
  async statusEntries(): Promise<Array<{ index: string; worktree: string; path: string; originalPath?: string }>> {
    const fields = (await this.git(["status", "--porcelain=v1", "-z", "--untracked-files=all"])).split("\0");
    const entries: Array<{ index: string; worktree: string; path: string; originalPath?: string }> = [];
    for (let i = 0; i < fields.length; i += 1) {
      const field = fields[i] ?? "";
      if (!field) continue;
      const entry: { index: string; worktree: string; path: string; originalPath?: string } = {
        index: field[0] ?? " ", worktree: field[1] ?? " ", path: field.slice(3),
      };
      if (entry.index === "R" || entry.index === "C" || entry.worktree === "R" || entry.worktree === "C") {
        const originalPath = fields[i + 1];
        if (originalPath !== undefined) { entry.originalPath = originalPath; i += 1; }
      }
      entries.push(entry);
    }
    return entries;
  }

  async changedPaths(sha: string): Promise<string[]> {
    return (await this.git(["diff-tree", "--no-commit-id", "--name-only", "--no-renames", "-r", "-z", sha])).split("\0").filter(Boolean);
  }

  async commit(paths: string[], message: string, expected?: Map<string, FileFingerprint>, allowedBefore?: Map<string, FileFingerprint>): Promise<string> {
    const literal = paths.map((path) => `:(literal)${path}`);
    if (expected && allowedBefore) await this.assertIndexFingerprints(allowedBefore, expected);
    await this.git(["add", "--", ...literal]);
    const cached = (await this.git(["diff", "--cached", "--name-only", "--no-renames", "-z"])).split("\0").filter(Boolean);
    const inScope = (candidate: string): boolean => paths.some((path) => candidate === path || candidate.startsWith(path.endsWith("/") ? path : path + "/"));
    const stagedSelected = cached.filter(inScope);
    if (stagedSelected.length === 0) throw new WikiIntegrityError("selected wiki paths have no staged changes");
    if (expected) await this.assertIndexFingerprints(expected);
    await this.git([...IDENTITY, "commit", "--only", "-m", message, "--", ...literal]);
    return this.head();
  }

  async assertIndexFingerprints(expected: Map<string, FileFingerprint>, alternatives?: Map<string, FileFingerprint>): Promise<void> {
    for (const [path, fingerprint] of expected) {
      const listing = await this.git(["ls-files", "--stage", "-z", "--", `:(literal)${path}`]);
      const record = listing.split("\0").find(Boolean);
      if (!record) {
        if (fingerprint.type !== "absent" && alternatives?.get(path)?.type !== "absent") throw new WikiIntegrityError(`wiki index is missing selected path: ${path}`);
        continue;
      }
      const tab = record.indexOf("\t");
      const [mode, sha, stage] = record.slice(0, tab).split(" ");
      if (record.slice(tab + 1) !== path || stage !== "0" || !sha) throw new WikiIntegrityError(`wiki index has an ambiguous entry for ${path}`);
      const type = mode === "120000" ? "symlink" : mode === "100644" || mode === "100755" ? "file" : "other";
      const hash = type === "other" ? null : createHash("sha256").update(await this.git(["cat-file", "blob", sha])).digest("hex");
      const matchesExpected = fingerprint.type === type && fingerprint.hash === hash;
      const alternative = alternatives?.get(path);
      const matchesAlternative = alternative?.type === type && alternative.hash === hash;
      if (!matchesExpected && !matchesAlternative) throw new WikiIntegrityError(`wiki index content does not match the batch: ${path}`);
    }
  }

  async push(): Promise<void> {
    await this.assertIdentity();
    await this.git(["push", "origin", this.opts.branch ? `HEAD:${this.opts.branch}` : "HEAD"]);
  }

  /** Path-limited restore from a revision, leaving every other working-tree change in place. */
  async checkoutPaths(rev: string, paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.git(["checkout", rev, "--", ...paths.map((path) => `:(literal)${path}`)]);
  }

  /** Deletes the given untracked paths (and untracked content under them); tracked files are never touched. */
  async removeUntracked(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.git(["clean", "-fd", "--", ...paths.map((path) => `:(literal)${path}`)]);
  }

  async resetHard(rev: string): Promise<void> {
    await this.git(["reset", "--hard", rev]);
  }

  /** Reverts `sha` without committing, then commits the result under the bot identity; returns the new HEAD. */
  async revert(sha: string, message: string): Promise<string> {
    await this.git(["revert", "--no-commit", sha]);
    const allowed = new Set(await this.changedPaths(sha));
    const entries = await this.statusEntries();
    const outside = entries.find((entry) => !allowed.has(entry.path));
    if (outside) throw new WikiIntegrityError(`wiki tree changed outside rollback scope: ${outside.path}`);
    const staged = (await this.git(["diff", "--cached", "--name-only", "--no-renames", "-z"])).split("\0").filter(Boolean);
    if (staged.some((path) => !allowed.has(path))) throw new WikiIntegrityError("wiki index changed outside rollback scope");
    const expected = new Map<string, FileFingerprint>();
    for (const path of staged) expected.set(path, await this.indexFingerprint(path));
    await this.assertWorktreeMatches(expected);
    await this.assertIndexFingerprints(expected);
    await this.assertWorktreeMatches(expected);
    const rollbackId = this.rollbackIdentity(message, "Vex-Rollback");
    const targetBatchId = this.rollbackIdentity(message, "Vex-Revert-Of");
    await this.writeRollbackExpectation({
      id: rollbackId,
      targetBatchId,
      paths: [...expected].map(([path, fingerprint]) => ({ path, fingerprint })),
    });
    await this.git([...IDENTITY, "commit", "--only", "-m", message, "--", ...staged.map((path) => `:(literal)${path}`)]);
    const result = await this.head();
    await this.validateRollbackExpectation({ id: rollbackId, targetBatchId, paths: [...expected].map(([path, fingerprint]) => ({ path, fingerprint })) }, result);
    await this.removeRollbackExpectation(rollbackId);
    return result;
  }

  async assertRollbackExpectations(): Promise<void> {
    const directory = this.rollbackExpectationDirectory();
    let names: string[];
    try { names = await readdir(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const name of names.filter((entry) => entry.endsWith(".json"))) {
      let expectation: RollbackExpectation;
      try {
        expectation = JSON.parse(await readFile(join(directory, name), "utf8")) as RollbackExpectation;
      } catch {
        throw new WikiIntegrityError(`rollback expectation ${name} is unreadable; publication blocked`);
      }
      if (!expectation || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(expectation.id)
        || name !== `${expectation.id}.json` || !/^[A-Za-z0-9._-]{1,128}$/.test(expectation.targetBatchId) || !Array.isArray(expectation.paths)) {
        throw new WikiIntegrityError(`rollback expectation ${name} is invalid; publication blocked`);
      }
      const commits = new Map<string, string>();
      const refs = ["HEAD", await this.originHead()];
      for (const ref of refs) {
        const fields = (await this.git(["log", "--format=%H%x00%B%x00", ref])).split("\0");
        for (let index = 0; index + 1 < fields.length; index += 2) {
          const sha = (fields[index] ?? "").trim();
          const body = fields[index + 1] ?? "";
          const id = this.trailerValue(body, "Vex-Rollback");
          if (id === expectation.id) commits.set(sha, body);
        }
      }
      if (commits.size !== 1) throw new WikiIntegrityError(`rollback ${expectation.id} has no unique committed result; publication blocked`);
      const sha = [...commits.keys()][0]!;
      await this.validateRollbackExpectation(expectation, sha, [...commits.values()][0]);
      await this.removeRollbackExpectation(expectation.id);
    }
  }

  private async validateRollbackExpectation(expectation: RollbackExpectation, sha: string, body?: string): Promise<void> {
    const message = body ?? (await this.git(["show", "-s", "--format=%B", sha]));
    if (this.trailerValue(message, "Vex-Revert-Of") !== expectation.targetBatchId) {
      throw new WikiIntegrityError(`rollback ${expectation.id} target does not match its durable expectation; publication blocked`);
    }
    const expected = new Map(expectation.paths.map((entry) => [entry.path, entry.fingerprint]));
    if (expected.size !== expectation.paths.length) throw new WikiIntegrityError(`rollback ${expectation.id} has duplicate expected paths; publication blocked`);
    for (const { path, fingerprint } of expectation.paths) {
      if ((!path.startsWith("wiki/") && !path.startsWith("raw/")) || path.includes("\0") || path.split("/").some((part) => part === "" || part === "." || part === "..")
        || !fingerprint || !["absent", "file", "symlink", "directory", "other"].includes(fingerprint.type)
        || (fingerprint.type === "file" || fingerprint.type === "symlink"
          ? typeof fingerprint.hash !== "string" || !/^[a-f0-9]{64}$/i.test(fingerprint.hash)
          : fingerprint.hash !== null)) {
        throw new WikiIntegrityError(`rollback ${expectation.id} contains an invalid expected path or fingerprint; publication blocked`);
      }
    }
    const changed = await this.changedPaths(sha);
    if (changed.some((path) => !expected.has(path))) throw new WikiIntegrityError(`rollback ${expectation.id} changed an unverified path; publication blocked`);
    for (const path of expected.keys()) {
      const actual = await this.fingerprintAt(sha, path);
      const wanted = expected.get(path);
      if (!wanted || actual.type !== wanted.type || actual.hash !== wanted.hash) {
        throw new WikiIntegrityError(`rollback ${expectation.id} content does not match its durable expectation at ${path}; publication blocked`);
      }
    }
  }

  private rollbackExpectationDirectory(): string {
    return join(this.root, ".git", "vex-wiki-rollback-expected");
  }

  private async writeRollbackExpectation(expectation: RollbackExpectation): Promise<void> {
    const directory = this.rollbackExpectationDirectory();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFileAtomic(join(directory, `${expectation.id}.json`), `${JSON.stringify(expectation)}\n`, 0o600, 0o700);
  }

  private async removeRollbackExpectation(id: string): Promise<void> {
    await rm(join(this.rollbackExpectationDirectory(), `${id}.json`), { force: true });
  }

  private rollbackIdentity(message: string, name: string): string {
    const value = this.trailerValue(message, name);
    if (!value) throw new WikiIntegrityError(`rollback commit is missing ${name}`);
    if (name.toLowerCase() === "vex-rollback" && !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) {
      throw new WikiIntegrityError("rollback identity is invalid");
    }
    if (name.toLowerCase() === "vex-revert-of" && !/^[A-Za-z0-9._-]{1,128}$/.test(value)) {
      throw new WikiIntegrityError("rollback target identity is invalid");
    }
    return value;
  }

  private trailerValue(message: string, name: string): string | null {
    const trailers = parseTrailers(message);
    for (const key of Object.keys(trailers)) if (key.toLowerCase() === name.toLowerCase()) {
      const values = trailers[key] ?? [];
      return values.length === 1 ? values[0] ?? null : null;
    }
    return null;
  }

  private async indexFingerprint(path: string): Promise<FileFingerprint> {
    const listing = await this.git(["ls-files", "--stage", "-z", "--", `:(literal)${path}`]);
    const record = listing.split("\0").find(Boolean);
    if (!record) return { type: "absent", hash: null };
    const tab = record.indexOf("\t");
    const [mode, sha, stage] = record.slice(0, tab).split(" ");
    if (record.slice(tab + 1) !== path || stage !== "0" || !sha) throw new WikiIntegrityError(`wiki index has an ambiguous entry for ${path}`);
    const type = mode === "120000" ? "symlink" : mode === "100644" || mode === "100755" ? "file" : "other";
    if (type === "other") return { type, hash: null };
    return { type, hash: createHash("sha256").update(await this.git(["cat-file", "blob", sha])).digest("hex") };
  }

  private async assertWorktreeMatches(expected: Map<string, FileFingerprint>): Promise<void> {
    for (const [path, wanted] of expected) {
      let actual: FileFingerprint;
      try {
        const info = await lstat(join(this.root, path));
        if (info.isSymbolicLink()) actual = { type: "symlink", hash: createHash("sha256").update(await readlink(join(this.root, path))).digest("hex") };
        else if (info.isFile()) actual = { type: "file", hash: createHash("sha256").update(await readFile(join(this.root, path))).digest("hex") };
        else actual = { type: "other", hash: null };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        actual = { type: "absent", hash: null };
      }
      if (actual.type !== wanted.type || actual.hash !== wanted.hash) throw new WikiIntegrityError(`wiki worktree differs from the verified revert index: ${path}`);
    }
  }

  async show(rev: string, path: string): Promise<string> {
    return this.git(["show", `${rev}:${path}`]);
  }

  async filesAt(rev: string, paths: string[]): Promise<Set<string>> {
    if (paths.length === 0) return new Set();
    const output = await this.git(["ls-tree", "-r", "-z", "--name-only", rev, "--", ...paths.map((path) => `:(literal)${path}`)]);
    return new Set(output.split("\0").filter(Boolean));
  }

  async fingerprintAt(rev: string, path: string): Promise<FileFingerprint> {
    const listing = await this.git(["ls-tree", "-z", rev, "--", `:(literal)${path}`]);
    const record = listing.split("\0").find(Boolean);
    if (!record) return { type: "absent", hash: null };
    const tab = record.indexOf("\t");
    if (tab < 0 || record.slice(tab + 1) !== path) return { type: "absent", hash: null };
    const [mode, objectType, sha] = record.slice(0, tab).split(" ");
    if (objectType !== "blob" || !sha) return { type: "other", hash: null };
    const bytes = await this.git(["cat-file", "blob", sha]);
    const type = mode === "120000" ? "symlink" : mode === "100644" || mode === "100755" ? "file" : "other";
    return type === "other"
      ? { type, hash: null }
      : { type, hash: createHash("sha256").update(bytes).digest("hex") };
  }

  /** Rebases onto the remote branch; on conflict the rebase is aborted so the caller only sees the error, not a half-rebased tree. */
  async rebase(): Promise<void> {
    try {
      await this.git([...IDENTITY, "rebase", `origin/${this.opts.branch ?? "HEAD"}`]);
    } catch (error) {
      await this.git(["rebase", "--abort"]).catch(() => undefined);
      throw error;
    }
  }

  /** Moves HEAD to the fetched remote tip when that is a pure fast-forward; returns whether it moved. */
  async fastForward(): Promise<boolean> {
    const head = await this.head();
    const tip = await this.originHead();
    if (head === tip || !(await this.isAncestor(head, tip))) return false;
    await this.git(["merge", "--ff-only", tip]);
    return true;
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
