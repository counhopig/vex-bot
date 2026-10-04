import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { Scheduler } from "../scheduler/index.js";

const Params = Type.Object({
  action: Type.Union([Type.Literal("create"), Type.Literal("list"), Type.Literal("delete")]),
  name: Type.Optional(Type.String()), id: Type.Optional(Type.String()),
  prompt: Type.Optional(Type.String()), target: Type.Optional(Type.String()),
  schedule: Type.Optional(Type.Union([Type.Object({ cron: Type.String() }), Type.Object({ every: Type.String() }), Type.Object({ once: Type.String() })])),
});
export function createScheduleTool(scheduler: Scheduler, source: string): AgentTool<typeof Params> {
  return { name: "schedule", label: "Scheduled tasks", description: "Creates, lists or deletes scheduled messages. Names are unique; the rule is cron, every (such as 30m) or once (an ISO time with a time zone). Delivered to the current conversation by default.", parameters: Params,
    async execute(_id, params) {
      let result: unknown;
      if (params.action === "list") result = scheduler.list();
      else if (params.action === "delete") { if (!params.id && !params.name) throw new Error("Deleting a task needs an id or a name"); result = { deleted: await scheduler.delete(params.id ?? params.name!) }; }
      else { if (!params.name || !params.prompt || !params.schedule) throw new Error("Creating a task needs name, prompt and schedule"); result = await scheduler.create({ name: params.name, prompt: params.prompt, schedule: params.schedule, target: params.target ?? source }); }
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
    },
  };
}
