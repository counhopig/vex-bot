/**
 * Built-in tool - Bash command execution tool
 */

import { Type } from "@sinclair/typebox";
import { spawn } from "child_process";
import { resolve, sep } from "path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { jsonResult, textResult, readStringParam, readNumberParam, readBooleanParam } from "../common.js";
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
  type ProcessSession,
} from "./process-registry.js";

export interface BashToolOptions {
  allowedPaths?: string[];
  defaultTimeout?: number;
  maxTimeout?: number;
  maxOutputSize?: number;
  /**
   * Extra environment variable names to expose to spawned commands, on top of
   * the base allowlist. Anything not listed here or in BASE_ENV_ALLOWLIST is
   * withheld from the child process — including provider API keys.
   */
  envPassthrough?: string[];
  enabled?: boolean;
}

const DEFAULT_OPTIONS: Required<BashToolOptions> = {
  allowedPaths: [process.cwd()],
  defaultTimeout: 120000,
  maxTimeout: 600000,
  maxOutputSize: 100000,
  envPassthrough: [],
  enabled: true,
};

// The bash tool is a real shell: a command denylist over shell strings is
// trivially bypassable (find -delete, base64|sh, $IFS tricks, ...) and only
// buys false confidence. The actual boundaries are (1) who can reach the agent
// at all (webAuth) and (2) what the child process can see. We enforce (2) here:
// spawned commands inherit only a minimal, non-secret set of variables so a
// single `bash` call cannot exfiltrate the whole process environment (API keys
// live there). Everything else must be opted in via envPassthrough.
const BASE_ENV_ALLOWLIST = [
  // POSIX essentials
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TERM", "TMPDIR", "TZ", "PWD",
  // Windows essentials
  "SystemRoot", "SystemDrive", "windir", "TEMP", "TMP", "PATHEXT", "ComSpec",
  "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA",
  "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
  // Proxy configuration — curl/git/npm in child processes are dead behind a
  // proxy without these. Tools honor both casings, so list both.
  "http_proxy", "https_proxy", "ftp_proxy", "all_proxy", "no_proxy",
  "HTTP_PROXY", "HTTPS_PROXY", "FTP_PROXY", "ALL_PROXY", "NO_PROXY",
];

// Windows environment variables are case-insensitive, and process.env
// enumerates them in their original casing ("Path", not "PATH") — so the
// allowlist must match case-insensitively there. POSIX env is case-sensitive.
export function buildChildEnv(passthrough: string[], opts?: { caseInsensitive?: boolean }): NodeJS.ProcessEnv {
  const caseInsensitive = opts?.caseInsensitive ?? isWindows;
  const normalize = (key: string) => (caseInsensitive ? key.toUpperCase() : key);
  const allow = new Set([...BASE_ENV_ALLOWLIST, ...passthrough].map(normalize));
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    // Locale variables (LC_ALL, LC_CTYPE, ...) are safe and commonly needed.
    if (allow.has(normalize(key)) || key.toUpperCase().startsWith("LC_")) env[key] = value;
  }
  return env;
}

function isPathAllowed(path: string, allowedPaths: string[]): boolean {
  const resolved = resolve(path);
  return allowedPaths.some((allowed) => {
    const ra = resolve(allowed);
    return resolved === ra || resolved.startsWith(ra + sep);
  });
}

const isWindows = process.platform === "win32";

function getShellCommand(command: string): { shell: string; args: string[] } {
  if (isWindows) return { shell: "cmd.exe", args: ["/c", command] };
  return { shell: "bash", args: ["-c", command] };
}

function killProcess(proc: ReturnType<typeof spawn>, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    if (isWindows && proc.pid) spawn("taskkill", ["/pid", String(proc.pid), "/f", "/t"], { stdio: "ignore" });
    else proc.kill(signal);
  } catch {}
}

export function createBashTool(options?: BashToolOptions): AgentTool {
  // Callers pass fields as `field: maybeUndefined` (e.g. envPassthrough from
  // optional config), and object spread would let those undefineds clobber the
  // defaults — drop them so defaults always win over absent values.
  const provided = Object.fromEntries(Object.entries(options ?? {}).filter(([, v]) => v !== undefined));
  const opts = { ...DEFAULT_OPTIONS, ...provided } as Required<BashToolOptions>;
  return {
    name: "bash",
    label: "Bash",
    description: "Execute a bash command with optional background execution.",
    parameters: Type.Object({
      command: Type.String({ description: "The bash command to execute" }),
      cwd: Type.Optional(Type.String({ description: "Working directory for the command" })),
      timeout: Type.Optional(Type.Number({ description: "Timeout in milliseconds (max 600000)" })),
      run_in_background: Type.Optional(Type.Boolean({ description: "Run in background and return session ID" })),
      description: Type.Optional(Type.String({ description: "Brief description of what the command does" })),
    }),
    execute: async (_toolCallId, args, signal) => {
      if (!opts.enabled) return jsonResult({ status: "error", error: "Bash tool is disabled" }, true);
      const params = args as Record<string, unknown>;
      const command = readStringParam(params, "command", { required: true })!;
      const cwd = readStringParam(params, "cwd") ?? process.cwd();
      const timeout = Math.min(readNumberParam(params, "timeout") ?? opts.defaultTimeout, opts.maxTimeout);
      const runInBackground = readBooleanParam(params, "run_in_background");
      const description = readStringParam(params, "description");
      if (!isPathAllowed(cwd, opts.allowedPaths)) return jsonResult({ status: "error", error: `Access denied: ${cwd}` }, true);

      const sessionId = createSessionId();
      const session: ProcessSession = {
        id: sessionId, command: truncateMiddle(command, 200), startedAt: Date.now(), cwd, status: "running",
        stdout: "", stderr: "", aggregated: "", tail: "", truncated: false, backgrounded: runInBackground ?? false, maxOutputChars: opts.maxOutputSize,
      };
      const { shell, args: shellArgs } = getShellCommand(command);
      const proc = spawn(shell, shellArgs, { cwd, env: buildChildEnv(opts.envPassthrough), stdio: ["pipe", "pipe", "pipe"] });
      session.child = proc; session.pid = proc.pid; addSession(session);
      proc.stdout?.on("data", (data) => appendOutput(session, "stdout", data.toString()));
      proc.stderr?.on("data", (data) => appendOutput(session, "stderr", data.toString()));
      proc.on("close", (code, sig) => markExited(session, code, sig, code === 0 ? "completed" : "failed"));
      proc.on("error", (error) => { appendOutput(session, "stderr", `Process error: ${error.message}`); markExited(session, null, null, "failed"); });

      if (runInBackground) {
        markBackgrounded(session);
        return jsonResult({ status: "backgrounded", session_id: sessionId, pid: proc.pid, command: session.command, description: description ?? deriveSessionName(command) });
      }
      return new Promise((resolvePromise) => {
        let killed = false;
        const timeoutId = setTimeout(() => { killed = true; killProcess(proc, "SIGTERM"); setTimeout(() => { if (!proc.killed) killProcess(proc, "SIGKILL"); }, 5000); }, timeout);
        signal?.addEventListener("abort", () => { killed = true; killProcess(proc, "SIGTERM"); });
        proc.on("close", (code) => {
          clearTimeout(timeoutId);
          const { stdout, stderr } = drainSession(session);
          if (killed) resolvePromise(jsonResult({ status: "killed", reason: signal?.aborted ? "aborted" : "timeout", session_id: sessionId, stdout: stdout.trim(), stderr: stderr.trim(), duration: formatDuration(Date.now() - session.startedAt) }, true));
          else {
            let output = (stdout.trim() + (stderr.trim() ? "\n\n[stderr]\n" + stderr.trim() : "")).trim() || "(no output)";
            if (code === 0) resolvePromise(textResult(output, { exitCode: code, command: session.command, session_id: sessionId, duration: formatDuration(Date.now() - session.startedAt) }));
            else resolvePromise(jsonResult({ status: "error", exitCode: code, session_id: sessionId, stdout: stdout.trim(), stderr: stderr.trim(), duration: formatDuration(Date.now() - session.startedAt) }, true));
          }
        });
      });
    },
  };
}

export function createBashTools(options?: BashToolOptions): AgentTool[] {
  return [createBashTool(options)];
}