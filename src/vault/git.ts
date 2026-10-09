import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export type GitRunner = (args: string[], options: { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<string>;

export const runGit: GitRunner = (args, { cwd, env, timeoutMs }) =>
  new Promise((resolve, reject) => {
    execFile("git", args, { cwd, env, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      reject(Object.assign(new Error(String(stderr || error.message).trim()), { code: (error as NodeJS.ErrnoException).code }));
    });
  });

const CLONE_TIMEOUT_MS = 300_000;
const GIT_TIMEOUT_MS = 60_000;
const LOG_TIMEOUT_MS = 120_000;
const PASSTHROUGH = ["PATH", "LANG", "LC_ALL", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR"];

export interface GitAuth { username?: string; token?: string }

function basicAuth(auth: GitAuth): string | undefined {
  return auth.token ? Buffer.from(`${auth.username || "git"}:${auth.token}`).toString("base64") : undefined;
}

/** The only environment git runs with. Credentials ride in an http.extraHeader, never in arguments or .git/config. */
export function gitEnv(home: string, auth: GitAuth = {}, protocols = "http:https"): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { HOME: home, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0", GIT_ALLOW_PROTOCOL: protocols };
  for (const key of PASSTHROUGH) if (process.env[key] !== undefined) env[key] = process.env[key];
  const basic = basicAuth(auth);
  if (basic) Object.assign(env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}` });
  return env;
}

function scrub(message: string, auth: GitAuth): string {
  let text = message;
  for (const secret of [auth.token, basicAuth(auth)]) if (secret) text = text.split(secret).join("***");
  return text.replace(/authorization:[^\n]*/gi, "Authorization: ***");
}

const tail = (message: string): string => {
  const lines = message.split("\n").map((line) => line.trim()).filter(Boolean);
  const important = lines.filter((line) => /^(fatal|error):/i.test(line));
  return (important.length ? important : lines).slice(0, 2).join(" ").slice(0, 300);
};

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

export interface MirrorOptions extends GitAuth {
  home: string;
  url: string;
  branch?: string;
  now?: () => number;
  run?: GitRunner;
  protocols?: string;
  refreshEveryMs?: number;
  onWarning?: (message: string) => void;
}
export interface MirrorState { root: string | null; syncedAt: number | null; error?: string }

/** A read-only local copy of a git repository. It is a mirror: every update resets to the remote, so force pushes are fine. */
export class GitMirror {
  private state: MirrorState = { root: null, syncedAt: null };
  private lastAttempt = Number.NEGATIVE_INFINITY;
  private inflight: Promise<MirrorState> | undefined;
  private readonly vaultDir: string;
  private readonly root: string;
  private readonly now: () => number;
  private readonly run: GitRunner;

  constructor(private readonly opts: MirrorOptions) {
    this.vaultDir = join(opts.home, "vault");
    const key = createHash("sha256").update(`${opts.url}\n${opts.branch ?? ""}`).digest("hex").slice(0, 12);
    this.root = join(this.vaultDir, key);
    this.now = opts.now ?? Date.now;
    this.run = opts.run ?? runGit;
  }

  refresh(): Promise<MirrorState> {
    if (this.inflight) return this.inflight;
    if (this.state.root && this.now() - this.lastAttempt < (this.opts.refreshEveryMs ?? 60_000)) return Promise.resolve(this.state);
    this.inflight = this.sync().finally(() => { this.inflight = undefined; });
    return this.inflight;
  }

  private async sync(): Promise<MirrorState> {
    this.lastAttempt = this.now();
    try {
      if (await exists(join(this.root, ".git"))) await this.update();
      else await this.clone();
      const syncedAt = this.now();
      await writeFile(join(this.root, ".git", "vex-synced"), String(syncedAt)).catch(() => undefined);
      this.state = { root: this.root, syncedAt };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const copy = await this.existingCopy();
      this.state = { root: copy ? this.root : null, syncedAt: copy?.syncedAt ?? null, error: message };
      this.opts.onWarning?.(`The notes vault could not be updated: ${message}`);
    }
    return this.state;
  }

  private async existingCopy(): Promise<{ syncedAt: number | null } | null> {
    if (!(await exists(join(this.root, ".git")))) return null;
    const marker = Number(await readFile(join(this.root, ".git", "vex-synced"), "utf8").catch(() => ""));
    return { syncedAt: Number.isFinite(marker) && marker > 0 ? marker : null };
  }

  private async clone(): Promise<void> {
    const tmp = `${this.root}.tmp`;
    await mkdir(this.vaultDir, { recursive: true });
    await rm(tmp, { recursive: true, force: true });
    await this.git(["clone", "--no-tags", "--single-branch", ...(this.opts.branch ? ["--branch", this.opts.branch] : []), "--", this.opts.url, tmp], undefined, CLONE_TIMEOUT_MS);
    await rm(this.root, { recursive: true, force: true });
    await rename(tmp, this.root);
    for (const name of await readdir(this.vaultDir)) {
      if (name !== basename(this.root)) await rm(join(this.vaultDir, name), { recursive: true, force: true });
    }
  }

  private async update(): Promise<void> {
    await this.git(["fetch", "--no-tags", "--prune", "origin", this.opts.branch ?? "HEAD"], this.root);
    await this.git(["reset", "--hard", "FETCH_HEAD"], this.root);
    await this.git(["clean", "-ffdx"], this.root);
  }

  private async git(args: string[], cwd?: string, timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
    try {
      return await this.run(args, { cwd, env: gitEnv(this.vaultDir, this.opts, this.opts.protocols), timeoutMs });
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") throw new Error("git was not found; install git to use a vault url");
      throw new Error(tail(scrub(error instanceof Error ? error.message : String(error), this.opts)));
    }
  }
}

const SAFE = ["-c", "safe.directory=*"];
const LOG_ARGS = [...SAFE, "-c", "core.quotepath=false", "log", "--relative", "--name-only", "--no-renames", "--format=%x00%ct"];

/** Parses `git log --name-only --format=%x00%ct`; the first (newest) commit that touches a file wins. */
export function parseLog(output: string): Map<string, number> {
  const times = new Map<string, number>();
  for (const chunk of output.split("\0")) {
    const [stamp, ...files] = chunk.split("\n").filter((line) => line !== "");
    const seconds = Number(stamp);
    if (!stamp || !Number.isFinite(seconds)) continue;
    for (const file of files) if (!times.has(file)) times.set(file, seconds * 1000);
  }
  return times;
}

/** Last commit time of every file in a git repository, recomputed only when HEAD moves. */
export class CommitTimes {
  private key = "";
  private times: Map<string, number> | null = null;

  constructor(private readonly run: GitRunner = runGit) {}

  async get(root: string): Promise<Map<string, number> | null> {
    const env = gitEnv(tmpdir());
    try {
      const head = (await this.run([...SAFE, "rev-parse", "HEAD"], { cwd: root, env, timeoutMs: GIT_TIMEOUT_MS })).trim();
      const key = `${root}\n${head}`;
      if (key !== this.key || !this.times) {
        this.times = parseLog(await this.run(LOG_ARGS, { cwd: root, env, timeoutMs: LOG_TIMEOUT_MS }));
        this.key = key;
      }
      return this.times;
    } catch {
      return null;
    }
  }
}
