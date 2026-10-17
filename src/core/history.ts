import { open } from "node:fs/promises";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { scanJsonlLines } from "../store/jsonl.js";
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
  private count: number;
  private bytes = 0;

  /** `start` is the absolute index of the first item added, for windows that begin mid-transcript. */
  constructor(private readonly limit = HISTORY_PAGE_SIZE, private readonly before = Infinity, start = 0) {
    this.count = start;
  }

  get items(): number { return this.count; }

  /** Number of history items a message adds, matching `add`. */
  static itemCount(message: AgentMessage): number {
    if (message.role === "user") return 1;
    if (message.role !== "assistant") return 0;
    const text = message.content.some((part) => part.type === "text" && part.text);
    return (text || message.stopReason === "aborted" ? 1 : 0) + message.content.filter((part) => part.type === "toolCall").length;
  }

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

/**
 * Pages the complete transcript on disk. Byte offsets of every `every`-th item are indexed
 * incrementally, so a page reads from the nearest checkpoint instead of the start of the file.
 */
export class TranscriptHistory {
  private checkpoints: { item: number; offset: number }[] = [];
  private indexed = { offset: 0, items: 0 };
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string, private readonly every = 1000) {}

  page(before: number): Promise<{ items: HistoryItem[]; nextBefore?: number }> {
    const run = this.queue.then(() => this.read(before));
    this.queue = run.catch(() => {});
    return run;
  }

  private async read(before: number): Promise<{ items: HistoryItem[]; nextBefore?: number }> {
    await this.extend();
    const first = Math.max(0, before - HISTORY_PAGE_SIZE);
    const from = this.checkpoints.findLast((checkpoint) => checkpoint.item <= first) ?? { item: 0, offset: 0 };
    const window = new HistoryWindow(undefined, before, from.item);
    for await (const { record } of scanJsonlLines(this.path, from.offset)) {
      if (!isTranscriptMessage(record)) continue;
      // Results that follow the boundary still settle tool items inside the page.
      if (window.items >= before && record.role !== "toolResult") break;
      window.add(record);
    }
    return window.page();
  }

  private async extend(): Promise<void> {
    if (!(await this.continues())) {
      this.checkpoints = [];
      this.indexed = { offset: 0, items: 0 };
    }
    for await (const { record, start, end, complete } of scanJsonlLines(this.path, this.indexed.offset)) {
      if (!complete) break;
      if (isTranscriptMessage(record)) {
        if (this.indexed.items - (this.checkpoints.at(-1)?.item ?? 0) >= this.every) this.checkpoints.push({ item: this.indexed.items, offset: start });
        this.indexed.items += HistoryWindow.itemCount(record);
      }
      this.indexed.offset = end;
    }
  }

  /** The indexed prefix still ends at a line boundary within the file; a rewrite resets the index. */
  private async continues(): Promise<boolean> {
    if (this.indexed.offset === 0) return true;
    let handle;
    try { handle = await open(this.path, "r"); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
    try {
      if ((await handle.stat()).size < this.indexed.offset) return false;
      const last = Buffer.alloc(1);
      await handle.read(last, 0, 1, this.indexed.offset - 1);
      return last[0] === 10;
    } finally { await handle.close(); }
  }
}
