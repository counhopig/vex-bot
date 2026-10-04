import type { BeforeToolCallContext, BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import type { ApprovalManager } from "./approvals.js";
import type { ToolPolicy } from "./policy.js";

export function createToolGate(deps: {
  policy: ToolPolicy;
  approvals: ApprovalManager;
  sessionKey: string;
  windowLabel: () => string;
}): (ctx: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined> {
  return async ({ toolCall, args }, signal) => {
    const decision = deps.policy.decide(toolCall.name, args);
    if (decision === "allow") return undefined;
    if (decision === "deny") return { block: true, reason: `The tool ${toolCall.name} is disabled.` };
    if (deps.approvals.isSessionAllowed(deps.sessionKey, toolCall.name)) return undefined;
    const outcome = await deps.approvals.request({
      sessionKey: deps.sessionKey,
      windowLabel: deps.windowLabel(),
      toolName: toolCall.name,
      args,
      signal,
    });
    return outcome.allowed ? undefined : { block: true, reason: outcome.reason };
  };
}
