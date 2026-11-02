import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { BackgroundTasks } from "../tasks/index.js";

const Params = Type.Object({
  action: Type.Union([Type.Literal("start"), Type.Literal("list"), Type.Literal("stop")]),
  title: Type.Optional(Type.String({ minLength: 1, description: "A short name the owner will recognise; required for start" })),
  task: Type.Optional(Type.String({ minLength: 1, description: "A self-contained instruction with every detail the task needs; required for start" })),
  id: Type.Optional(Type.String({ description: "The task to stop" })),
});

export function createBackgroundTaskTool(tasks: BackgroundTasks, origin: string): AgentTool<typeof Params> {
  return {
    name: "background_task",
    label: "Background tasks",
    description: "Starts, lists or stops background tasks. A started task runs on its own with your tools and no conversation history, so the conversation stays free while it works; its result arrives later in this conversation as a message for you to pass on. Use it for work that takes many steps or minutes, such as research, batch file work or long commands; use delegate when you need the answer before replying.",
    parameters: Params,
    async execute(_id, params) {
      let result: unknown;
      if (params.action === "list") result = tasks.list();
      else if (params.action === "stop") {
        if (!params.id) throw new Error("Stopping a task needs its id");
        result = { stopped: tasks.stop(params.id) };
      } else {
        if (!params.title || !params.task) throw new Error("Starting a task needs title and task");
        const started = tasks.start({ origin, title: params.title, prompt: params.task });
        result = { ...started, note: "The task is running; its result will arrive in this conversation when it ends." };
      }
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
    },
  };
}
