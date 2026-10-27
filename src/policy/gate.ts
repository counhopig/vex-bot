import type { BeforeToolCallContext, BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import type { ApprovalManager } from "./approvals.js";
import type { ToolPolicy } from "./policy.js";

const UNATTENDED_REASON = (tool: string) =>
  `The owner is not present for this run, so ${tool}, which needs the owner's approval, is unavailable. Continue with the tools that need no approval, or report what could not be done.`;

export function createToolGate(deps: {
  policy: ToolPolicy;
  approvals: ApprovalManager;
  sessionKey: string;
  windowLabel: () => string;
  /** True while the session runs without the owner, who then cannot answer an approval. */
  unattended?: () => boolean;
}): (ctx: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined> {
  return async ({ toolCall, args }, signal) => {
    const decision = deps.policy.decide(toolCall.name, args);
    if (decision === "allow") return undefined;
    if (decision === "deny") return { block: true, reason: `The tool ${toolCall.name} is disabled.` };
    if (deps.approvals.isSessionAllowed(deps.sessionKey, toolCall.name, args)) return undefined;
    if (deps.unattended?.()) return { block: true, reason: UNATTENDED_REASON(toolCall.name) };
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
