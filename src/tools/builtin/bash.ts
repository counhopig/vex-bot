/**
 * Built-in tool — Bash command execution.
 *
 * Security (preserved from _archive):
 *   - Environment filtering: spawned child processes inherit only a
 *     minimal allowlist of env vars (no API keys, no secrets).
 *     Everything else must be opted in via envPassthrough.
 *   - Path sandboxing: cwd validated against allowedPaths.
 *   - Per-owner process isolation: ownerKey stamped on every session.
 *   - Timeout enforcement with SIGTERM → SIGKILL escalation.
 */

import { Type, type Static } from "@sinclair/typebox";
import { spawn } from "child_process";
import { resolve, sep } from "path";
import type { Tool, ToolResult } from "../types.js";
import {
  jsonResult,
  textResult,
  readStringParam,
  readNumberParam,
  readBooleanParam,
} from "../common.js";
import {
  createSessionId,
  addSession,
  markBackgrounded,
  markExited,
  appendOutput,
  drainSession,
  deriveSessionName,
  formatDuration,
  truncateMiddle,
  GLOBAL_OWNER_KEY,
  type ProcessSession,
} from "./process-registry.js";

export interface BashToolOptions {
  allowedPaths?: string[];
  defaultTimeout?: number;
  maxTimeout?: number;
  maxOutputSize?: number;
  envPassthrough?: string[];
  enabled?: boolean;
  owner?: string;
}

const DEFAULT_OPTIONS: Required<BashToolOptions> = {
  allowedPaths: [process.cwd()],
  defaultTimeout: 120000,
  maxTimeout: 600000,
  maxOutputSize: 100000,
  envPassthrough: [],
  enabled: true,
  owner: GLOBAL_OWNER_KEY,
};

// The bash tool is a real shell: a command denylist over shell strings is
// trivially bypassable (find -delete, base64|sh, $IFS tricks, ...) and only
// buys false confidence. The actual boundaries are (1) who can reach the agent
// at all (webAuth) and (2) what the child process can see. We enforce (2) here:
// spawned commands inherit only a minimal, non-secret set of variables so a
// single `bash` call cannot exfiltrate the whole process environment (API keys
// live there). Everything else must be opted in via envPassthrough.
const BASE_ENV_ALLOWLIST = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TERM", "TMPDIR", "TZ", "PWD",
  "SystemRoot", "SystemDrive", "windir", "TEMP", "TMP", "PATHEXT", "ComSpec",
  "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA",
  "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
  "http_proxy", "https_proxy", "ftp_proxy", "all_proxy", "no_proxy",
  "HTTP_PROXY", "HTTPS_PROXY", "FTP_PROXY", "ALL_PROXY", "NO_PROXY",
];

const isWindowsEnv = process.platform === "win32";

export function buildChildEnv(
  passthrough: string[],
  opts?: { caseInsensitive?: boolean },
): NodeJS.ProcessEnv {
  const caseInsensitive = opts?.caseInsensitive ?? isWindowsEnv;
  const normalize = (key: string) =>
    caseInsensitive ? key.toUpperCase() : key;
  const allow = new Set(
    [...BASE_ENV_ALLOWLIST, ...passthrough].map(normalize),
  );
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (
      allow.has(normalize(key)) ||
      key.toUpperCase().startsWith("LC_")
    ) {
      env[key] = value;
    }
  }
  return env;
}

function isPathAllowed(path: string, allowedPaths: string[]): boolean {
  const resolvedPath = resolve(path);
  return allowedPaths.some((allowed) => {
    const ra = resolve(allowed);
    return resolvedPath === ra || resolvedPath.startsWith(ra + sep);
  });
}

function getShellCommand(
  command: string,
): { shell: string; args: string[] } {
  if (isWindowsEnv) return { shell: "cmd.exe", args: ["/c", command] };
  return { shell: "bash", args: ["-c", command] };
}

function killProcess(
  proc: ReturnType<typeof spawn>,
  signal: "SIGTERM" | "SIGKILL",
): void {
  try {
    if (isWindowsEnv && proc.pid) {
      spawn("taskkill", ["/pid", String(proc.pid), "/f", "/t"], {
        stdio: "ignore",
      });
    } else {
      proc.kill(signal);
    }
  } catch {
    // ignore
  }
}

export function createBashTool(options?: BashToolOptions): Tool {
  const provided = Object.fromEntries(
    Object.entries(options ?? {}).filter(([, v]) => v !== undefined),
  );
  const opts = {
    ...DEFAULT_OPTIONS,
    ...provided,
  } as Required<BashToolOptions>;

  const parameters = Type.Object({
    command: Type.String({ description: "The bash command to execute" }),
    cwd: Type.Optional(
      Type.String({ description: "Working directory for the command" }),
    ),
    timeout: Type.Optional(
      Type.Number({ description: "Timeout in milliseconds (max 600000)" }),
    ),
    run_in_background: Type.Optional(
      Type.Boolean({
        description: "Run in background and return session ID",
      }),
    ),
    description: Type.Optional(
      Type.String({
        description: "Brief description of what the command does",
      }),
    ),
  });

  return {
    name: "bash",
    label: "Bash",
    description:
      "Execute a bash command with optional background execution.",
    parameters,
    execute: async (_toolCallId, args, signal, _onUpdate, _ctx) => {
      if (!opts.enabled) {
        return jsonResult(
          { status: "error", error: "Bash tool is disabled" },
          true,
        );
      }

      const params = args as Static<typeof parameters>;
      const command = params.command;
      const cwd =
        params.cwd ?? opts.allowedPaths[0] ?? process.cwd();
      const timeout = Math.min(
        params.timeout ?? opts.defaultTimeout,
        opts.maxTimeout,
      );
      const runInBackground = params.run_in_background ?? false;
      const description = params.description;

      if (!isPathAllowed(cwd, opts.allowedPaths)) {
        return jsonResult(
          { status: "error", error: `Access denied: ${cwd}` },
          true,
        );
      }

      const sessionId = createSessionId();
      const session: ProcessSession = {
        id: sessionId,
        ownerKey: opts.owner,
        command: truncateMiddle(command, 200),
        startedAt: Date.now(),
        cwd,
        status: "running",
        stdout: "",
        stderr: "",
        aggregated: "",
        tail: "",
        truncated: false,
        backgrounded: runInBackground,
        maxOutputChars: opts.maxOutputSize,
      };

      const { shell, args: shellArgs } = getShellCommand(command);
      const proc = spawn(shell, shellArgs, {
        cwd,
        env: buildChildEnv(opts.envPassthrough),
        stdio: ["pipe", "pipe", "pipe"],
      });
      session.child = proc;
      session.pid = proc.pid;
      addSession(session);

      proc.stdout?.on("data", (data: Buffer) =>
        appendOutput(session, "stdout", data.toString()),
      );
      proc.stderr?.on("data", (data: Buffer) =>
        appendOutput(session, "stderr", data.toString()),
      );
      proc.on("close", (code, sig) =>
        markExited(
          session,
          code,
          sig,
          code === 0 ? "completed" : "failed",
        ),
      );
      proc.on("error", (error) => {
        appendOutput(session, "stderr", `Process error: ${error.message}`);
        markExited(session, null, null, "failed");
      });

      if (runInBackground) {
        markBackgrounded(session);
        return jsonResult({
          status: "backgrounded",
          session_id: sessionId,
          pid: proc.pid,
          command: session.command,
          description: description ?? deriveSessionName(command),
        });
      }

      return new Promise<ToolResult>((resolvePromise) => {
        let killed = false;
        const timeoutId = setTimeout(() => {
          killed = true;
          killProcess(proc, "SIGTERM");
          setTimeout(() => {
            if (!proc.killed) killProcess(proc, "SIGKILL");
          }, 5000);
        }, timeout);

        signal?.addEventListener("abort", () => {
          killed = true;
          killProcess(proc, "SIGTERM");
        });

        proc.on("close", (code) => {
          clearTimeout(timeoutId);
          const { stdout, stderr } = drainSession(session);
          if (killed) {
            resolvePromise(
              jsonResult(
                {
                  status: "killed",
                  reason: signal?.aborted ? "aborted" : "timeout",
                  session_id: sessionId,
                  stdout: stdout.trim(),
                  stderr: stderr.trim(),
                  duration: formatDuration(
                    Date.now() - session.startedAt,
                  ),
                },
                true,
              ),
            );
          } else {
            const output =
              (
                stdout.trim() +
                (stderr.trim()
                  ? "\n\n[stderr]\n" + stderr.trim()
                  : "")
              ).trim() || "(no output)";
            if (code === 0) {
              resolvePromise(
                textResult(output, {
                  exitCode: code,
                  command: session.command,
                  session_id: sessionId,
                  duration: formatDuration(
                    Date.now() - session.startedAt,
                  ),
                }),
              );
            } else {
              resolvePromise(
                jsonResult(
                  {
                    status: "error",
                    exitCode: code,
                    session_id: sessionId,
                    stdout: stdout.trim(),
                    stderr: stderr.trim(),
                    duration: formatDuration(
                      Date.now() - session.startedAt,
                    ),
                  },
                  true,
                ),
              );
            }
          }
        });
      });
    },
  };
}

export function createBashTools(options?: BashToolOptions): Tool[] {
  return [createBashTool(options)];
}
