import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { Scheduler } from "../scheduler/index.js";

const Params = Type.Object({
  action: Type.Union([Type.Literal("create"), Type.Literal("list"), Type.Literal("delete")]),
  name: Type.Optional(Type.String()), id: Type.Optional(Type.String()),
  prompt: Type.Optional(Type.String()), target: Type.Optional(Type.String()), enabled: Type.Optional(Type.Boolean()),
  schedule: Type.Optional(Type.Union([Type.Object({ cron: Type.String() }), Type.Object({ every: Type.String() }), Type.Object({ once: Type.String() })])),
});
export function createScheduleTool(scheduler: Scheduler, source: string): AgentTool<typeof Params> {
  return { name: "schedule", label: "定时任务", description: "创建、列出或删除定时投递。名称唯一；规则为 cron、every（如30m）、once（带时区的ISO时间）。默认投递到当前会话。", parameters: Params,
    async execute(_id, params) {
      let result: unknown;
      if (params.action === "list") result = scheduler.list();
      else if (params.action === "delete") { if (!params.id && !params.name) throw new Error("删除任务需要 id 或 name"); result = { deleted: await scheduler.delete(params.id ?? params.name!) }; }
      else { if (!params.name || !params.prompt || !params.schedule) throw new Error("创建任务需要 name、prompt 和 schedule"); result = await scheduler.create({ name: params.name, prompt: params.prompt, schedule: params.schedule, target: params.target ?? source, enabled: params.enabled }); }
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
    },
  };
}
