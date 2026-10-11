import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { summarizeArgs } from "../tools/summary.js";
import type { HistoryItem } from "./events.js";

export const HISTORY_PAGE_SIZE = 100;

export function isTranscriptMessage(value: unknown): value is AgentMessage {
  if (!value || typeof value !== "object") return false;
  const role = (value as { role?: unknown }).role;
  return role === "user" || role === "assistant" || role === "toolResult";
}

/** Rendered history only: image bytes and full tool output never enter the browser history cache. */
export class HistoryWindow {
  private entries: { index: number; item: HistoryItem; bytes: number }[] = [];
  private tools = new Map<string, Extract<HistoryItem, { kind: "tool" }>>();
  private count = 0;
  private bytes = 0;

  constructor(private readonly limit = HISTORY_PAGE_SIZE, private readonly before = Infinity) {}

  add(message: AgentMessage): void {
    if (message.role === "user") {
      const text = typeof message.content === "string" ? message.content : message.content.map((part) => part.type === "text" ? part.text : "[image]").join("");
      this.push({ kind: "user", text, timestamp: message.timestamp, source: (message as { vexSource?: string }).vexSource });
    } else if (message.role === "assistant") {
      const text = message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
      if (text || message.stopReason === "aborted") this.push({ kind: "assistant", text, stopReason: message.stopReason, timestamp: message.timestamp });
      for (const part of message.content) {
        if (part.type === "toolCall") this.push({ kind: "tool", toolCallId: part.id, toolName: part.name, summary: summarizeArgs(part.name, part.arguments) });
      }
    } else if (message.role === "toolResult") {
      const item = this.tools.get(message.toolCallId);
      if (item) item.isError = message.isError;
    }
  }

  private push(item: HistoryItem): void {
    const index = this.count++;
    if (index >= this.before) return;
    const bytes = Buffer.byteLength(JSON.stringify(item), "utf8");
    this.entries.push({ index, item, bytes });
    this.bytes += bytes;
    if (item.kind === "tool") this.tools.set(item.toolCallId, item);
    // Always return at least one complete item, even if that item exceeds the page byte budget.
    while (this.entries.length > this.limit || (this.bytes > 1024 * 1024 && this.entries.length > 1)) {
      const removed = this.entries.shift()!;
      this.bytes -= removed.bytes;
      if (removed.item.kind === "tool" && this.tools.get(removed.item.toolCallId) === removed.item) this.tools.delete(removed.item.toolCallId);
    }
  }

  page(): { items: HistoryItem[]; nextBefore?: number } {
    const first = this.entries[0]?.index;
    return { items: this.entries.map(({ item }) => ({ ...item })), ...(first !== undefined && first > 0 ? { nextBefore: first } : {}) };
  }
}
