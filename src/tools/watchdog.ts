import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

/** What a watchdog run decided: whether the owner should hear about it, and the message if so. */
export interface WatchdogOutcome { notify?: boolean; message?: string }

const ReportParams = Type.Object({
  notify: Type.Boolean({ description: "True when the owner should know about or act on these problems" }),
  message: Type.Optional(Type.String({ minLength: 1, description: "The message for the owner; required when notify is true" })),
});

/** The watchdog run's one way to report. */
export function createWatchdogReportTool(outcome: WatchdogOutcome): AgentTool<typeof ReportParams> {
  return {
    name: "watchdog_report",
    label: "Report watchdog result",
    description: "Reports the result of the watchdog check exactly once: notify=false when nothing needs the owner, or notify=true with the message to send them.",
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
