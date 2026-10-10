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

export class ApprovalManager {
  private readonly pendingById = new Map<string, Pending>();
  private readonly sessionAllowed = new Map<string, Set<string>>();
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly onChange: () => void;
  private readonly workspace: string | undefined;
  private readonly onEvent: (event: ApprovalEvent) => void;

  constructor(opts: { timeoutMs?: number; now?: () => number; onChange?: () => void; workspace?: string; onEvent?: (event: ApprovalEvent) => void } = {}) {
    this.timeoutMs = opts.timeoutMs ?? 10 * 60_000;
    this.now = opts.now ?? Date.now;
    this.onChange = opts.onChange ?? (() => {});
    this.workspace = opts.workspace;
    this.onEvent = opts.onEvent ?? (() => {});
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
    const request: ApprovalRequest = {
      id: randomUUID(),
      sessionKey: input.sessionKey,
      windowLabel: input.windowLabel,
      toolName: input.toolName,
      summary: summarizeArgs(input.toolName, input.args),
      detail: approvalDetail(input.toolName, input.args, this.workspace),
      createdAt,
      expiresAt: createdAt + this.timeoutMs,
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
    if (answer === "allow_session") {
      const tools = this.sessionAllowed.get(request.sessionKey) ?? new Set<string>();
      tools.add(request.toolName);
      this.sessionAllowed.set(request.sessionKey, tools);
    }
    pending.settle(
      answer === "deny" ? { allowed: false, reason: `The owner denied this ${request.toolName} call.` } : { allowed: true },
    );
    return true;
  }

  pending(): ApprovalRequest[] {
    return [...this.pendingById.values()].map((p) => ({ ...p.request }));
  }

  isSessionAllowed(sessionKey: string, toolName: string): boolean {
    return this.sessionAllowed.get(sessionKey)?.has(toolName) ?? false;
  }

  dispose(): void {
    for (const pending of [...this.pendingById.values()]) {
      pending.settle({ allowed: false, reason: "vexd is shutting down." });
    }
  }
}
