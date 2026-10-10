import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

const OutcomeParams = Type.Object({
  actionId: Type.String(),
  url: Type.String(),
  status: Type.Union([Type.Literal("deferred"), Type.Literal("awaiting-review"), Type.Literal("blocked")]),
  message: Type.String(),
});

/** A harmless pi tool used to put authorized controller outcomes in the ordinary tool stream. */
export function createRequestActionOutcomeTool(
  authorize: (args: { actionId: string; url: string; status: "deferred" | "awaiting-review" | "blocked"; message: string }) => boolean,
  onOutcome?: (message: string) => Promise<void>,
): AgentTool<typeof OutcomeParams> {
  return {
    name: "request_action_outcome",
    label: "Report link action outcome",
    description: "Records the runtime outcome for a link action. This tool has no external side effects.",
    parameters: OutcomeParams,
    execute: async (_id, args) => {
      if (!authorize(args)) throw new Error("This request action outcome was not issued by the runtime.");
      await onOutcome?.(args.message);
      return { content: [{ type: "text", text: args.message }], details: { actionId: args.actionId, url: args.url, status: args.status } };
    },
  };
}
