import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const BASE_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

export function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...BASE_ENV, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** A bare "remote" repository and a working copy to push from, both inside dir. */
export function makeRemote(dir: string): { remote: string; work: string } {
  const remote = join(dir, "remote.git");
  const work = join(dir, "work");
  mkdirSync(remote, { recursive: true });
  mkdirSync(work, { recursive: true });
  git(remote, ["init", "--bare", "-b", "main"]);
  git(work, ["init", "-b", "main"]);
  git(work, ["remote", "add", "origin", remote]);
  return { remote, work };
}

/** Writes files, commits them at the given date and force-pushes HEAD to the branch. */
export function commit(work: string, files: Record<string, string>, date: string, branch = "main"): void {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(work, name)), { recursive: true });
    writeFileSync(join(work, name), text);
  }
  git(work, ["add", "-A"]);
  git(work, ["commit", "-m", `change ${date}`], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  git(work, ["push", "origin", `HEAD:refs/heads/${branch}`, "--force"]);
}
