/**
 * Process session registry - background process management
 * Based on moltbot's bash-process-registry.ts
 */

import type { ChildProcess } from "child_process";
import { spawn } from "child_process";

/** Check if running on Windows */
const isWindows = process.platform === "win32";

/** Cross-platform process termination */
function killProcessCrossPlatform(child: ChildProcess, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    if (isWindows) {
      // On Windows, use taskkill
      if (child.pid) {
        spawn("taskkill", ["/pid", String(child.pid), "/f", "/t"], { stdio: "ignore" });
      }
    } else {
      child.kill(signal);
    }
  } catch {
    // ignore
  }
}

/** Process session status */
export type SessionStatus = "running" | "completed" | "failed";

/** Process session */
export interface ProcessSession {
  id: string;
  command: string;
  pid?: number;
  child?: ChildProcess;
  startedAt: number;
  endedAt?: number;
  cwd: string;
  status: SessionStatus;
  exitCode?: number | null;
  exitSignal?: string | number | null;
  stdout: string;
  stderr: string;
  aggregated: string;
  tail: string;
  truncated: boolean;
  backgrounded: boolean;
  maxOutputChars: number;
}

/** Session registry */
const runningSessions = new Map<string, ProcessSession>();
const finishedSessions = new Map<string, ProcessSession>();

/** Session TTL (default 30 minutes) */
let sessionTtlMs = 30 * 60 * 1000;

/** Number of tail characters */
const TAIL_CHARS = 2000;

/** Set session TTL */
export function setSessionTtlMs(ms: number): void {
  sessionTtlMs = ms;
}

/** Generate a session ID */
export function createSessionId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

/** Add a session */
export function addSession(session: ProcessSession): void {
  runningSessions.set(session.id, session);
}

/** Get a running session */
export function getSession(id: string): ProcessSession | undefined {
  return runningSessions.get(id);
}

/** Get a finished session */
export function getFinishedSession(id: string): ProcessSession | undefined {
  return finishedSessions.get(id);
}

/** List running sessions */
export function listRunningSessions(): ProcessSession[] {
  return Array.from(runningSessions.values());
}

/** List finished sessions */
export function listFinishedSessions(): ProcessSession[] {
  cleanupExpiredSessions();
  return Array.from(finishedSessions.values());
}

/** Mark as backgrounded */
export function markBackgrounded(session: ProcessSession): void {
  session.backgrounded = true;
}

/** Mark as exited */
export function markExited(
  session: ProcessSession,
  exitCode: number | null,
  exitSignal: string | number | null,
  status: "completed" | "failed"
): void {
  session.status = status;
  session.exitCode = exitCode;
  session.exitSignal = exitSignal;
  session.endedAt = Date.now();

  // Move from running to finished
  runningSessions.delete(session.id);
  finishedSessions.set(session.id, session);
}

/** Append output */
export function appendOutput(
  session: ProcessSession,
  stream: "stdout" | "stderr",
  chunk: string
): void {
  const maxChars = session.maxOutputChars;

  if (stream === "stdout") {
    session.stdout += chunk;
    if (session.stdout.length > maxChars) {
      session.stdout = session.stdout.slice(-maxChars);
      session.truncated = true;
    }
  } else {
    session.stderr += chunk;
    if (session.stderr.length > maxChars) {
      session.stderr = session.stderr.slice(-maxChars);
      session.truncated = true;
    }
  }

  // Update aggregated output
  session.aggregated += chunk;
  if (session.aggregated.length > maxChars) {
    session.aggregated = session.aggregated.slice(-maxChars);
    session.truncated = true;
  }

  // Update tail
  session.tail = session.aggregated.slice(-TAIL_CHARS);
}

/** Drain and clear pending output */
export function drainSession(session: ProcessSession): { stdout: string; stderr: string } {
  const stdout = session.stdout;
  const stderr = session.stderr;
  session.stdout = "";
  session.stderr = "";
  return { stdout, stderr };
}

/** Delete a session */
export function deleteSession(id: string): boolean {
  if (finishedSessions.has(id)) {
    finishedSessions.delete(id);
    return true;
  }
  return false;
}

/** Terminate a session */
export function killSession(session: ProcessSession): void {
  if (session.child && !session.child.killed) {
    killProcessCrossPlatform(session.child, "SIGTERM");
    setTimeout(() => {
      if (session.child && !session.child.killed) {
        killProcessCrossPlatform(session.child, "SIGKILL");
      }
    }, 5000);
  }
}

/** Clean up expired sessions */
function cleanupExpiredSessions(): void {
  const now = Date.now();
  for (const [id, session] of finishedSessions) {
    if (session.endedAt && now - session.endedAt > sessionTtlMs) {
      finishedSessions.delete(id);
    }
  }
}

/** Get log slice */
export function sliceLogLines(
  content: string,
  offset?: number,
  limit?: number
): { slice: string; totalLines: number; totalChars: number } {
  const lines = content.split("\n");
  const totalLines = lines.length;
  const totalChars = content.length;

  const startIdx = Math.max(0, (offset ?? 1) - 1);
  const endIdx = limit ? Math.min(totalLines, startIdx + limit) : totalLines;

  const slice = lines.slice(startIdx, endIdx).join("\n");

  return { slice, totalLines, totalChars };
}

/** Get tail output */
export function tail(content: string, chars: number): string {
  if (content.length <= chars) return content;
  return "..." + content.slice(-chars);
}

/** Derive session name from command */
export function deriveSessionName(command: string): string {
  // Extract the first command
  const match = command.match(/^\s*(?:sudo\s+)?(\S+)/);
  if (match) {
    const cmd = match[1]!;
    // Strip path
    const basename = cmd.split("/").pop() || cmd;
    return basename.slice(0, 20);
  }
  return command.slice(0, 20);
}

/** Format duration */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
  return `${Math.floor(ms / 3600000)}h${Math.floor((ms % 3600000) / 60000)}m`;
}

/** Truncate middle */
export function truncateMiddle(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  const half = Math.floor((maxLen - 3) / 2);
  return str.slice(0, half) + "..." + str.slice(-half);
}
