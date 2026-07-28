/**
 * Process session registry — background process management.
 *
 * Security (preserved from _archive):
 *   - Per-owner isolation: every ProcessSession has an ownerKey.
 *     getSession / getFinishedSession / listRunningSessions /
 *     listFinishedSessions / deleteSession all filter by ownerKey.
 *   - disposeOwnerSessions kills + forgets all sessions for an owner
 *     (called when a per-user runtime is torn down).
 *
 * The module-level Maps are the one intentional exception to "no
 * process-global state" because background processes are kernel-level
 * resources that exist independently of an Agent instance. The per-owner
 * filtering isolates them at access time.
 */

import type { ChildProcess } from "child_process";
import { spawn } from "child_process";

const isWindows = process.platform === "win32";

function killProcessCrossPlatform(
  child: ChildProcess,
  signal: "SIGTERM" | "SIGKILL",
): void {
  try {
    if (isWindows) {
      if (child.pid) {
        spawn("taskkill", ["/pid", String(child.pid), "/f", "/t"], {
          stdio: "ignore",
        });
      }
    } else {
      child.kill(signal);
    }
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const GLOBAL_OWNER_KEY = "__global__";

export type SessionStatus = "running" | "completed" | "failed";

export interface ProcessSession {
  id: string;
  ownerKey: string;
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

// ---------------------------------------------------------------------------
// State (process-global — background processes are kernel-level resources)
// ---------------------------------------------------------------------------

const runningSessions = new Map<string, ProcessSession>();
const finishedSessions = new Map<string, ProcessSession>();

let sessionTtlMs = 30 * 60 * 1000;
const TAIL_CHARS = 2000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function setSessionTtlMs(ms: number): void {
  sessionTtlMs = ms;
}

export function createSessionId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

export function addSession(session: ProcessSession): void {
  runningSessions.set(session.id, session);
}

function ownedBy(
  session: ProcessSession | undefined,
  ownerKey?: string,
): ProcessSession | undefined {
  if (!session) return undefined;
  if (ownerKey !== undefined && session.ownerKey !== ownerKey) return undefined;
  return session;
}

export function getSession(
  id: string,
  ownerKey?: string,
): ProcessSession | undefined {
  return ownedBy(runningSessions.get(id), ownerKey);
}

export function getFinishedSession(
  id: string,
  ownerKey?: string,
): ProcessSession | undefined {
  return ownedBy(finishedSessions.get(id), ownerKey);
}

export function listRunningSessions(
  ownerKey?: string,
): ProcessSession[] {
  const all = Array.from(runningSessions.values());
  return ownerKey === undefined ? all : all.filter((s) => s.ownerKey === ownerKey);
}

export function listFinishedSessions(
  ownerKey?: string,
): ProcessSession[] {
  cleanupExpiredSessions();
  const all = Array.from(finishedSessions.values());
  return ownerKey === undefined ? all : all.filter((s) => s.ownerKey === ownerKey);
}

export function markBackgrounded(session: ProcessSession): void {
  session.backgrounded = true;
}

export function markExited(
  session: ProcessSession,
  exitCode: number | null,
  exitSignal: string | number | null,
  status: "completed" | "failed",
): void {
  session.status = status;
  session.exitCode = exitCode;
  session.exitSignal = exitSignal;
  session.endedAt = Date.now();
  runningSessions.delete(session.id);
  finishedSessions.set(session.id, session);
}

export function appendOutput(
  session: ProcessSession,
  stream: "stdout" | "stderr",
  chunk: string,
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
  session.aggregated += chunk;
  if (session.aggregated.length > maxChars) {
    session.aggregated = session.aggregated.slice(-maxChars);
    session.truncated = true;
  }
  session.tail = session.aggregated.slice(-TAIL_CHARS);
}

export function drainSession(
  session: ProcessSession,
): { stdout: string; stderr: string } {
  const stdout = session.stdout;
  const stderr = session.stderr;
  session.stdout = "";
  session.stderr = "";
  return { stdout, stderr };
}

export function deleteSession(id: string, ownerKey?: string): boolean {
  const session = finishedSessions.get(id);
  if (session && (ownerKey === undefined || session.ownerKey === ownerKey)) {
    finishedSessions.delete(id);
    return true;
  }
  return false;
}

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

export function disposeOwnerSessions(ownerKey: string): void {
  for (const [id, session] of runningSessions) {
    if (session.ownerKey === ownerKey) {
      killSession(session);
      runningSessions.delete(id);
    }
  }
  for (const [id, session] of finishedSessions) {
    if (session.ownerKey === ownerKey) finishedSessions.delete(id);
  }
}

function cleanupExpiredSessions(): void {
  const now = Date.now();
  for (const [id, session] of finishedSessions) {
    if (session.endedAt && now - session.endedAt > sessionTtlMs) {
      finishedSessions.delete(id);
    }
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export function sliceLogLines(
  content: string,
  offset?: number,
  limit?: number,
): { slice: string; totalLines: number; totalChars: number } {
  const lines = content.split("\n");
  const totalLines = lines.length;
  const totalChars = content.length;
  const startIdx = Math.max(0, (offset ?? 1) - 1);
  const endIdx = limit
    ? Math.min(totalLines, startIdx + limit)
    : totalLines;
  return { slice: lines.slice(startIdx, endIdx).join("\n"), totalLines, totalChars };
}

export function tail(content: string, chars: number): string {
  if (content.length <= chars) return content;
  return "..." + content.slice(-chars);
}

export function deriveSessionName(command: string): string {
  const match = command.match(/^\s*(?:sudo\s+)?(\S+)/);
  if (match) {
    const cmd = match[1]!;
    const basename = cmd.split("/").pop() || cmd;
    return basename.slice(0, 20);
  }
  return command.slice(0, 20);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000)
    return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
  return `${Math.floor(ms / 3600000)}h${Math.floor((ms % 3600000) / 60000)}m`;
}

export function truncateMiddle(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  const half = Math.floor((maxLen - 3) / 2);
  return str.slice(0, half) + "..." + str.slice(-half);
}
