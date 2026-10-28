import { execFile } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export type SandboxMode = "off" | "workspace";

export interface SandboxConfig {
  mode: SandboxMode;
  /** Extra paths commands may read, including ones inside the data home. */
  readable: string[];
  /** Extra paths commands may change. */
  writable: string[];
  /** The helper binary; found next to the build or on PATH when unset. */
  helper?: string;
}

export interface SandboxPaths {
  workspace: string;
  /** Vex's data home: hidden from commands apart from the workspace and the configuration file. */
  home: string;
  config: string;
}

/** A confined way to start bash, or why there is none. Commands never run unconfined when the sandbox is on. */
export type Sandbox =
  | { ok: true; abi: number; wrap: (program: string, args: string[]) => { file: string; args: string[] } }
  | { ok: false; reason: string };

const HELPER = "vex-sandbox";

/** The helper `npm run build` compiles into `dist/native`, else the one on PATH (the Docker image installs it there). */
function defaultHelper(): string {
  const built = join(dirname(fileURLToPath(import.meta.url)), "..", "native", HELPER);
  return existsSync(built) ? built : HELPER;
}

const real = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

const within = (path: string, root: string): boolean => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/**
 * Landlock only grants, so hiding the data home means granting each sibling along its path instead of `/`.
 * A child that resolves into the data home, or above it, is left out so a symlink cannot reopen it.
 */
function readableAround(hidden: string): string[] {
  const roots: string[] = [];
  let parent = "/";
  for (const segment of hidden.split(sep).filter(Boolean)) {
    let names: string[] = [];
    try {
      names = readdirSync(parent);
    } catch {
      // An unreadable level stays closed.
    }
    for (const name of names) {
      if (name === segment) continue;
      const path = join(parent, name);
      const target = real(path);
      if (!within(target, hidden) && !within(hidden, target)) roots.push(path);
    }
    parent = join(parent, segment);
  }
  return roots;
}

/** Helper arguments for one command: list everything, read all but the data home, write the workspace and temporary files. */
export function sandboxArguments(paths: SandboxPaths, config: Pick<SandboxConfig, "readable" | "writable">): string[] {
  const home = real(paths.home);
  const read = home === "/" ? [] : readableAround(home);
  if (home === "/") read.push("/");
  read.push(paths.config, ...config.readable);
  const write = [paths.workspace, tmpdir(), "/dev/shm", "/dev/null", "/dev/zero", "/dev/full", ...config.writable];
  return ["-l", "/", ...read.flatMap((path) => ["-r", path]), ...write.flatMap((path) => ["-w", path])];
}

/** Checks once that the helper can confine a process on this kernel. */
export async function prepareSandbox(paths: SandboxPaths, config: SandboxConfig): Promise<Sandbox | undefined> {
  if (config.mode === "off") return undefined;
  const helper = config.helper ?? defaultHelper();
  const probe = await new Promise<{ abi: number } | { reason: string }>((done) => {
    execFile(helper, ["--probe"], { timeout: 5_000 }, (error, stdout, stderr) => {
      const abi = Number.parseInt(stdout, 10);
      if (!error && abi >= 1) done({ abi });
      else done({ reason: stderr.trim() || error?.message || "the helper did not report a Landlock version" });
    });
  });
  if ("reason" in probe) return { ok: false, reason: `${helper}: ${probe.reason}` };
  return {
    ok: true,
    abi: probe.abi,
    wrap: (program, args) => ({ file: helper, args: [...sandboxArguments(paths, config), "--", program, ...args] }),
  };
}
