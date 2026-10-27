import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

/** What a heartbeat run decided: whether the owner should hear about it, and the message if so. */
export interface HeartbeatOutcome { notify?: boolean; message?: string }

const ReportParams = Type.Object({
  notify: Type.Boolean({ description: "True when something in the checklist needs the owner's attention" }),
  message: Type.Optional(Type.String({ minLength: 1, description: "The message for the owner; required when notify is true" })),
});

/** The heartbeat run's one way to report: a typed decision instead of a magic reply string. */
export function createHeartbeatReportTool(outcome: HeartbeatOutcome): AgentTool<typeof ReportParams> {
  return {
    name: "heartbeat_report",
    label: "Report heartbeat result",
    description: "Reports the result of the heartbeat check exactly once: notify=false when there is nothing to tell the owner, or notify=true with the message to send them.",
    parameters: ReportParams,
    async execute(_id, { notify, message }) {
      if (notify && !message?.trim()) throw new Error("A message is required when notify is true.");
      outcome.notify = notify;
      if (notify) outcome.message = message!.trim();
      else delete outcome.message;
      return { content: [{ type: "text", text: notify ? "The message will be sent to the owner." : "Nothing will be sent to the owner." }], details: {} };
    },
  };
}

/**
 * The message a heartbeat run leaves for the owner, or null. The report tool decides; a run that never
 * called it falls back to its reply, which is silent only when it is HEARTBEAT_OK and nothing else, so a
 * reminder that happens to mention the token still reaches the owner.
 */
export function heartbeatMessage(outcome: HeartbeatOutcome, reply: string): string | null {
  if (outcome.notify !== undefined) return outcome.notify ? outcome.message ?? null : null;
  const text = reply.trim();
  return !text || /^[\s\p{P}]*HEARTBEAT_OK[\s\p{P}]*$/iu.test(text) ? null : text;
}
