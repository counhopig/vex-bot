import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { MemoryIndex } from "./memory.js";

const Params = Type.Object({ query: Type.String(), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })), scope: Type.Optional(Type.Union([Type.Literal("memory"), Type.Literal("sessions"), Type.Literal("all")])) });
export function createMemorySearchTool(index: MemoryIndex): AgentTool<typeof Params> {
  return { name: "memory_search", label: "检索记忆", description: "检索记忆文件与历史对话，返回片段、来源、日期和会话。", parameters: Params,
    async execute(_id, { query, limit, scope }) {
      await index.sync();
      const results = index.search(query, limit, scope);
      return { content: [{ type: "text", text: results.length ? JSON.stringify(results, null, 2) : "没有匹配的记忆" }], details: { results } };
    } };
}
