import { randomUUID } from "node:crypto";
import { resolveRealPath, resolveToolPath } from "../tools/paths.js";
import { approvalDetail, summarizeArgs } from "../tools/summary.js";

export type ApprovalAnswer = "allow" | "allow_session" | "deny";

export interface ApprovalRequest {
  id: string;
  /** A short number, unique among pending requests, that WeChat answers name (`/y 3`). */
  code: number;
  sessionKey: string;
  windowLabel: string;
  toolName: string;
  summary: string;
  detail: string;
  createdAt: number;
  expiresAt: number;
  /** The call is confirmed every time; "always allow" is not offered for it. */
  everyCall?: true;
  /** What "always allow" would cover, such as `bash git`; absent when it is not offered. */
  allowScope?: string;
}

export interface ApprovalOutcome {
  allowed: boolean;
  reason?: string;
}

interface Pending {
  request: ApprovalRequest;
  settle: (outcome: ApprovalOutcome) => void;
}

export interface ApprovalEvent { type: "requested" | "allowed" | "denied"; toolName: string; windowLabel: string; reason?: string }

const ABORTED: ApprovalOutcome = { allowed: false, reason: "This turn was interrupted." };

/**
 * Programs whose "always allow" can be scoped per program: they only read and print, and have no
 * option that runs another program or writes a file. Anything else, such as git (config hooks),
 * sed (`e`), find (`-exec`), sort (`--compress-program`) or tar (`--checkpoint-action`), can be made to
 * run arbitrary commands with ordinary arguments, so it is confirmed every time.
 */
const READ_ONLY_PROGRAMS = new Set(["ls", "cat", "head", "tail", "wc", "pwd", "echo", "grep", "du", "df", "stat", "which", "whoami", "uname", "basename", "dirname", "realpath", "nl", "cut"]);

/** File tools ask only outside the workspace; "always allow" covers the one path asked about, never its folder. */
const PATH_TOOLS = new Set(["read", "write", "edit", "grep", "find"]);

/**
 * What answering "always allow" to a call covers: for `bash` the read-only program a simple command
 * runs, for a file tool the exact real path, otherwise the tool. Any other bash call (a compound or
 * substituted command, a path, another program) has no such scope and is confirmed every time.
 */
export function sessionScope(toolName: string, args: unknown, workspace = process.cwd()): string | undefined {
  if (PATH_TOOLS.has(toolName)) {
    const given = args && typeof args === "object" ? (args as { path?: unknown }).path : undefined;
    const path = given ?? (toolName === "grep" || toolName === "find" ? "." : undefined);
    if (typeof path !== "string") return undefined;
    try {
      return `${toolName} ${resolveRealPath(resolveToolPath(workspace, path))}`;
    } catch {
      return undefined;
    }
  }
  if (toolName !== "bash") return toolName;
  const command = args && typeof args === "object" ? (args as { command?: unknown }).command : undefined;
  if (typeof command !== "string" || /[;&|`$<>(){}\\\n]/.test(command)) return undefined;
  const program = command.trim().split(/\s+/)[0] ?? "";
  return READ_ONLY_PROGRAMS.has(program) ? `bash ${program}` : undefined;
}

export class ApprovalManager {
  private readonly pendingById = new Map<string, Pending>();
  private readonly sessionAllowed = new Map<string, Set<string>>();
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly onChange: () => void;
  private readonly workspace: string | undefined;
  private readonly onEvent: (event: ApprovalEvent) => void;
  private readonly everyCall: ReadonlySet<string>;
  private nextCode = 1;

  constructor(opts: { timeoutMs?: number; now?: () => number; onChange?: () => void; workspace?: string; onEvent?: (event: ApprovalEvent) => void; everyCall?: Iterable<string> } = {}) {
    this.timeoutMs = opts.timeoutMs ?? 10 * 60_000;
    this.now = opts.now ?? Date.now;
    this.onChange = opts.onChange ?? (() => {});
    this.workspace = opts.workspace;
    this.onEvent = opts.onEvent ?? (() => {});
    this.everyCall = new Set(opts.everyCall ?? []);
  }

  request(input: {
    sessionKey: string;
    windowLabel: string;
    toolName: string;
    args: unknown;
    signal?: AbortSignal;
  }): Promise<ApprovalOutcome> {
    if (input.signal?.aborted) return Promise.resolve(ABORTED);
    const createdAt = this.now();
    const scope = this.scope(input.toolName, input.args);
    const request: ApprovalRequest = {
      id: randomUUID(),
      code: this.nextCode++,
      sessionKey: input.sessionKey,
      windowLabel: input.windowLabel,
      toolName: input.toolName,
      summary: summarizeArgs(input.toolName, input.args),
      detail: approvalDetail(input.toolName, input.args, this.workspace),
      createdAt,
      expiresAt: createdAt + this.timeoutMs,
      ...(scope === undefined ? { everyCall: true as const } : { allowScope: scope }),
    };
    return new Promise((resolve) => {
      const minutes = Math.round(this.timeoutMs / 60_000);
      const timer = setTimeout(
        () => finish({ allowed: false, reason: `The owner did not answer within ${minutes} minutes; this ${input.toolName} call was cancelled.` }),
        this.timeoutMs,
      );
      const onAbort = () => finish(ABORTED);
      const finish = (outcome: ApprovalOutcome) => {
        if (!this.pendingById.delete(request.id)) return;
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", onAbort);
        resolve(outcome);
        this.onEvent({ type: outcome.allowed ? "allowed" : "denied", toolName: input.toolName, windowLabel: input.windowLabel, reason: outcome.allowed ? undefined : outcome.reason });
        this.onChange();
      };
      input.signal?.addEventListener("abort", onAbort, { once: true });
      this.pendingById.set(request.id, { request, settle: finish });
      this.onEvent({ type: "requested", toolName: input.toolName, windowLabel: input.windowLabel });
      this.onChange();
    });
  }

  answer(id: string, answer: ApprovalAnswer): boolean {
    const pending = this.pendingById.get(id);
    if (!pending) return false;
    const { request } = pending;
    if (answer === "allow_session" && request.allowScope !== undefined) {
      const scopes = this.sessionAllowed.get(request.sessionKey) ?? new Set<string>();
      scopes.add(request.allowScope);
      this.sessionAllowed.set(request.sessionKey, scopes);
    }
    pending.settle(
      answer === "deny" ? { allowed: false, reason: `The owner denied this ${request.toolName} call.` } : { allowed: true },
    );
    return true;
  }

  pending(): ApprovalRequest[] {
    return [...this.pendingById.values()].map((p) => ({ ...p.request }));
  }

  /** Whether an earlier "always allow" in this session covers the call. */
  isSessionAllowed(sessionKey: string, toolName: string, args?: unknown): boolean {
    const scope = this.scope(toolName, args);
    return scope !== undefined && (this.sessionAllowed.get(sessionKey)?.has(scope) ?? false);
  }

  private scope(toolName: string, args: unknown): string | undefined {
    return this.everyCall.has(toolName) ? undefined : sessionScope(toolName, args, this.workspace);
  }

  /** Drops the "always allow" answers of a conversation that no longer exists. */
  forgetSession(sessionKey: string): void {
    this.sessionAllowed.delete(sessionKey);
  }

  dispose(): void {
    for (const pending of [...this.pendingById.values()]) {
      pending.settle({ allowed: false, reason: "vexd is shutting down." });
    }
  }
}
