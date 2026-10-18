import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, it } from "vitest";
import { HistoryWindow, TranscriptHistory } from "../src/core/history.js";
import { MAX_CONTEXT_MESSAGES, MessageWindow } from "../src/context/window.js";
import { Session } from "../src/core/session.js";
import { createFaux, fauxStreamFn } from "./helpers/faux.js";
import { evidence } from "./helpers/evidence.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

let dir: string;
beforeEach(async () => { dir = await makeTmpDir(); });
afterEach(async () => { await removeTmpDir(dir); });
const user = (content: string) => ({ role: "user" as const, content, timestamp: 1 });

it("bounds old turns without orphaning tool results, including notification-only histories", () => {
  const window = new MessageWindow();
  for (let i = 0; i < 600; i++) window.push(fauxAssistantMessage(`notice ${i}`));
  expect(window.messages).toHaveLength(MAX_CONTEXT_MESSAGES);
  expect(window.offset).toBe(88);
  window.push(user("new turn"));
  window.push(fauxAssistantMessage(fauxToolCall("read", { path: "file" }, { id: "call" }), { stopReason: "toolUse" }));
  window.push({ role: "toolResult", toolName: "read", toolCallId: "call", content: [{ type: "text", text: "x".repeat(9 * 1024 * 1024) }], isError: false, timestamp: 1 });
  expect(window.messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
  window.push(fauxAssistantMessage("done"));
  window.push(user("next turn"));
  expect(window.messages).toEqual([user("next turn")]);
});

it("keeps a paged tool's outcome even when its result follows the page boundary", () => {
  const history = new HistoryWindow(2, 2);
  history.add(user("question"));
  history.add(fauxAssistantMessage(fauxToolCall("read", { path: "file" }, { id: "call" }), { stopReason: "toolUse" }));
  history.add(fauxAssistantMessage("later response"));
  history.add({ role: "toolResult", toolName: "read", toolCallId: "call", content: [], isError: true, timestamp: 1 });
  expect(history.page().items).toMatchObject([{ kind: "user" }, { kind: "tool", toolCallId: "call", isError: true }]);
});

it("pages from indexed checkpoints with the same items as a full scan, after appends and rewrites", async () => {
  const turn = (i: number): unknown[] => [
    user(`question ${i}`),
    fauxAssistantMessage([{ type: "text", text: `answer ${i}` }, fauxToolCall("read", { path: `f${i}` }, { id: `call-${i}` })], { stopReason: "toolUse" }),
    { role: "toolResult", toolName: "read", toolCallId: `call-${i}`, content: [], isError: i % 3 === 0, timestamp: 1 },
    { type: "provider_usage", timestamp: 1 },
  ];
  const turns = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => turn(from + i)).flat();
  const jsonl = (records: unknown[]) => records.map((record) => JSON.stringify(record)).join("\n") + "\n";
  const reference = (records: unknown[], before: number) => {
    const window = new HistoryWindow(undefined, before);
    for (const record of records) if ((record as { role?: string }).role) window.add(record as AgentMessage);
    return window.page();
  };
  const path = join(dir, "paged.jsonl");
  const initial = turns(0, 120);
  await writeFile(path, jsonl(initial));
  const history = new TranscriptHistory(path, 7);
  for (const before of [0, 1, 2, 3, 50, 101, 250, 359, 360]) expect(await history.page(before)).toEqual(reference(initial, before));
  const appended = turns(120, 150);
  await appendFile(path, jsonl(appended));
  for (const before of [359, 400, 450]) expect(await history.page(before)).toEqual(reference([...initial, ...appended], before));
  const rewritten = turns(500, 520);
  await writeFile(path, jsonl(rewritten));
  for (const before of [10, 60]) expect(await history.page(before)).toEqual(reference(rewritten, before));
});

it("restores a bounded model window while paging the complete transcript without gaps", async () => {
  const messages: AgentMessage[] = [];
  for (let i = 0; i < 300; i++) messages.push(user(`question ${i}`), fauxAssistantMessage(`answer ${i}`));
  const path = join(dir, "session.jsonl");
  await writeFile(path, messages.map((message) => JSON.stringify(message)).join("\n") + "\n");
  const faux = createFaux();
  let providerMessages: unknown;
  faux.setResponses([(context) => { providerMessages = context.messages; return fauxAssistantMessage("new answer"); }]);
  const session = await Session.open({ evidence, key: "wechat", transcriptPath: path, model: faux.getModel(), tools: [], streamFn: fauxStreamFn(faux), getApiKey: () => undefined, buildSystemPrompt: async () => "SYSTEM", emit: () => {} });
  expect(session.history().items).toHaveLength(100);
  const first = await session.historyPage();
  expect(first.nextBefore).toBe(500);
  // New delivery must not shift the cursor into older pages.
  await session.injectAssistant("notification");
  let items = first.items;
  let before = first.nextBefore;
  while (before !== undefined) {
    const page = await session.historyPage(before);
    expect(page.items.length).toBeLessThanOrEqual(100);
    items = [...page.items, ...items];
    before = page.nextBefore;
  }
  expect(items.map((item) => item.kind === "tool" ? item.summary : item.text)).toEqual(messages.map((message) => message.role === "user" ? message.content : message.role === "assistant" ? message.content[0]!.type === "text" ? message.content[0]!.text : "" : ""));
  expect((await session.historyPage(0)).items).toEqual([]);
  session.send("latest question");
  await session.whenIdle();
  expect(JSON.stringify(providerMessages)).not.toContain('"content":"question 0"');
  expect(JSON.stringify(providerMessages)).toContain("question 299");
  expect((providerMessages as unknown[]).length).toBeLessThanOrEqual(MAX_CONTEXT_MESSAGES + 2);
  await session.dispose();
});
