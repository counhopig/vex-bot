import { randomUUID } from "node:crypto";
import { approvalDetail, summarizeArgs } from "../tools/summary.js";

export type ApprovalAnswer = "allow" | "allow_session" | "deny";

export interface ApprovalRequest {
  id: string;
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

/** Programs that run whatever they are given; allowing one for a session would allow any command. */
const COMMAND_RUNNERS = new Set(["sh", "bash", "zsh", "dash", "fish", "env", "sudo", "doas", "su", "xargs", "nohup", "timeout", "nice", "watch", "eval", "exec", "command", "builtin", "source", "python", "python3", "node", "perl", "ruby", "php", "lua", "deno", "bun", "npx", "ssh"]);

/**
 * What answering "always allow" to a call covers: the tool, or for `bash` the one program a simple
 * command runs. A compound or substituted command, a path, or a program that runs other commands has
 * no such scope and is confirmed every time.
 */
export function sessionScope(toolName: string, args: unknown): string | undefined {
  if (toolName !== "bash") return toolName;
  const command = args && typeof args === "object" ? (args as { command?: unknown }).command : undefined;
  if (typeof command !== "string" || /[;&|`$<>(){}\\\n]/.test(command)) return undefined;
  const program = command.trim().split(/\s+/)[0] ?? "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(program) || COMMAND_RUNNERS.has(program)) return undefined;
  return `bash ${program}`;
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
    return this.everyCall.has(toolName) ? undefined : sessionScope(toolName, args);
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
