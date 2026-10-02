import { randomUUID } from "node:crypto";
import { summarizeArgs } from "../tools/summary.js";

export type ApprovalAnswer = "allow" | "allow_session" | "deny";

export interface ApprovalRequest {
  id: string;
  sessionKey: string;
  windowLabel: string;
  toolName: string;
  summary: string;
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

const ABORTED: ApprovalOutcome = { allowed: false, reason: "本轮已被中断。" };

export class ApprovalManager {
  private readonly pendingById = new Map<string, Pending>();
  private readonly sessionAllowed = new Map<string, Set<string>>();
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly onChange: () => void;

  constructor(opts: { timeoutMs?: number; now?: () => number; onChange?: () => void } = {}) {
    this.timeoutMs = opts.timeoutMs ?? 10 * 60_000;
    this.now = opts.now ?? Date.now;
    this.onChange = opts.onChange ?? (() => {});
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
      createdAt,
      expiresAt: createdAt + this.timeoutMs,
    };
    return new Promise((resolve) => {
      const minutes = Math.round(this.timeoutMs / 60_000);
      const timer = setTimeout(
        () => finish({ allowed: false, reason: `主人 ${minutes} 分钟内没有答复，这次 ${input.toolName} 调用已取消。` }),
        this.timeoutMs,
      );
      const onAbort = () => finish(ABORTED);
      const finish = (outcome: ApprovalOutcome) => {
        if (!this.pendingById.delete(request.id)) return;
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", onAbort);
        resolve(outcome);
        this.onChange();
      };
      input.signal?.addEventListener("abort", onAbort, { once: true });
      this.pendingById.set(request.id, { request, settle: finish });
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
      answer === "deny" ? { allowed: false, reason: `主人拒绝了这次 ${request.toolName} 调用。` } : { allowed: true },
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
      pending.settle({ allowed: false, reason: "vexd 正在关闭。" });
    }
  }
}
