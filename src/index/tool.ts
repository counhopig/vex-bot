import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { MemoryIndex, MemoryResult } from "./memory.js";
import { tokenize } from "./tokenize.js";

const Params = Type.Object({ query: Type.String(), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })), scope: Type.Optional(Type.Union([Type.Literal("memory"), Type.Literal("sessions"), Type.Literal("all")])) });
const SNIPPET = 300;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;
function snippet(text: string, terms: string[]): string {
  if (text.length <= SNIPPET) return text;
  const lower = text.toLowerCase();
  const hit = terms.map((term) => lower.indexOf(term)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
  let start = Math.max(0, Math.min(hit - SNIPPET / 3, text.length - SNIPPET));
  let end = Math.min(text.length, start + SNIPPET);
  if (start > 0 && isLowSurrogate(text.charCodeAt(start))) start++;
  if (end < text.length && isLowSurrogate(text.charCodeAt(end))) end--;
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

export function createMemorySearchTool(index: MemoryIndex): AgentTool<typeof Params> {
  return { name: "memory_search", label: "Search memory", description: "Searches memory files and past conversations and returns snippets with their source, date and session.", parameters: Params,
    async execute(_id, { query, limit, scope }) {
      await index.sync();
      const terms = tokenize(query);
      const results: MemoryResult[] = index.search(query, limit, scope).map((r) => ({ ...r, text: snippet(r.text, terms) }));
      return { content: [{ type: "text", text: results.length ? JSON.stringify(results, null, 2) : "No matching memories" }], details: { results } };
    } };
}
