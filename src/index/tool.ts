import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { MemoryIndex, MemoryResult } from "./memory.js";
import { tokenize } from "./tokenize.js";

const Params = Type.Object({ query: Type.String(), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })), scope: Type.Optional(Type.Union([Type.Literal("memory"), Type.Literal("sessions"), Type.Literal("all")])) });
const SNIPPET = 300;
function snippet(text: string, terms: string[]): string {
  if (text.length <= SNIPPET) return text;
  const lower = text.toLowerCase();
  const hit = terms.map((term) => lower.indexOf(term)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, Math.min(hit - SNIPPET / 3, text.length - SNIPPET));
  return `${start > 0 ? "…" : ""}${text.slice(start, start + SNIPPET)}${start + SNIPPET < text.length ? "…" : ""}`;
}

export function createMemorySearchTool(index: MemoryIndex): AgentTool<typeof Params> {
  return { name: "memory_search", label: "检索记忆", description: "检索记忆文件与历史对话，返回片段、来源、日期和会话。", parameters: Params,
    async execute(_id, { query, limit, scope }) {
      await index.sync();
      const terms = tokenize(query);
      const results: MemoryResult[] = index.search(query, limit, scope).map((r) => ({ ...r, text: snippet(r.text, terms) }));
      return { content: [{ type: "text", text: results.length ? JSON.stringify(results, null, 2) : "没有匹配的记忆" }], details: { results } };
    } };
}
