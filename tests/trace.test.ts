import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Session } from "../src/core/session.js";
import { createDelegateTool } from "../src/tools/delegate.js";
import { TraceStore } from "../src/trace/store.js";
import type { TraceEvent } from "../src/trace/types.js";
import { createFaux, fauxStreamFn } from "./helpers/faux.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

let dir: string;
beforeEach(async () => { dir = await makeTmpDir(); });
afterEach(async () => { await removeTmpDir(dir); });

const DAY = 86_400_000;

const EchoParams = Type.Object({ text: Type.String() });
const echo: AgentTool<typeof EchoParams> = {
  name: "echo", label: "Echo", description: "echo", parameters: EchoParams,
  execute: async (_id, { text }) => ({ content: [{ type: "text", text: `echo:${text}` }], details: { length: text.length } }),
};
const broken: AgentTool<typeof EchoParams> = {
  name: "broken", label: "Broken", description: "fails", parameters: EchoParams,
  execute: async () => { throw new Error("tool exploded"); },
};

async function openStore(options: Partial<ConstructorParameters<typeof TraceStore>[0]> = {}): Promise<TraceStore> {
  const store = new TraceStore({ dir: join(dir, "traces"), ...options });
  await store.open();
  return store;
}

const types = (events: TraceEvent[]) => events.map((event) => event.type);

describe("TraceStore", () => {
  it("writes one bounded, redacted file per run and keeps a summary of it", async () => {
    const store = await openStore({ secrets: () => ["sk-secret-value"] });
    const scope = store.scope("wechat");
    const run = scope.begin({ session: "wechat", source: "owner", model: "faux/m", text: "  hello\n  there  " });
    run.record({ type: "llm_start", id: "llm-1", model: "faux/m", context: { system: 10, tools: 5, conversation: 3, messages: 1, total: 18 }, system: "key sk-secret-value" });
    run.record({ type: "llm_end", id: "llm-1", ms: 120, ttftMs: 40, usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 0 }, stopReason: "toolUse", toolCalls: [{ id: "c1", name: "echo" }] });
    run.record({ type: "tool_start", id: "c1", name: "echo", args: "x".repeat(20_000) });
    run.record({ type: "tool_end", id: "c1", name: "echo", ms: 5, isError: true, result: "failed" });
    scope.finish("ok", { reply: "done" });
    await store.flush();

    const summary = (await store.list()).runs[0]!;
    expect(summary).toMatchObject({ session: "wechat", source: "owner", title: "hello there", outcome: "ok", llmCalls: 1, toolCalls: 1, toolErrors: 1, input: 130, output: 20 });
    const events = await store.read(summary.id);
    expect(types(events)).toEqual(["run_start", "llm_start", "llm_end", "tool_start", "tool_end", "run_end"]);
    expect(events[1]).toMatchObject({ system: "key [redacted]" });
    const args = (events[3] as Extract<TraceEvent, { type: "tool_start" }>).args;
    expect(args.length).toBeLessThan(8_300);
    expect(args).toContain("…[+11808 chars]");
    expect(scope.current).toBeUndefined();
  });

  it("restores summaries after a restart and marks runs that never ended as interrupted", async () => {
    const store = await openStore();
    store.scope("web:a").begin({ session: "web:a", source: "owner", model: "faux/m", text: "unfinished" });
    await store.flush();
    const reopened = await openStore();
    expect((await reopened.list()).runs).toEqual([expect.objectContaining({ title: "unfinished", outcome: "interrupted" })]);
  });

  it("drops runs older than the retention period with their files", async () => {
    let now = Date.UTC(2026, 9, 1);
    const store = await openStore({ now: () => now, retainDays: 2 });
    const scope = store.scope("wechat");
    scope.begin({ session: "wechat", source: "heartbeat", model: "faux/m", text: "old" });
    scope.finish("ok");
    await store.flush();
    now += 3 * DAY;
    const reopened = await openStore({ now: () => now, retainDays: 2 });
    const fresh = reopened.scope("wechat");
    fresh.begin({ session: "wechat", source: "owner", model: "faux/m", text: "new" });
    fresh.finish("ok");
    await reopened.flush();
    expect((await reopened.list()).runs.map((run) => run.title)).toEqual(["new"]);
    expect((await readdir(join(dir, "traces"))).filter((name) => name !== "index.jsonl")).toHaveLength(1);
    const index = await readFile(join(dir, "traces", "index.jsonl"), "utf8");
    expect(index).not.toContain("\"old\"");
  });

  it("pages runs newest first and searches their full traces", async () => {
    let now = 1_000_000;
    const store = await openStore({ now: () => now++ });
    for (let index = 0; index < 5; index++) {
      const scope = store.scope(`web:${index}`);
      const run = scope.begin({ session: `web:${index}`, source: "owner", model: "faux/m", text: `run ${index}` });
      if (index === 1) run.record({ type: "tool_start", id: "c", name: "web_search", args: "{\"query\":\"Needle\"}" });
      scope.finish("ok");
    }
    await store.flush();
    const first = await store.list({ limit: 2 });
    expect(first.runs.map((run) => run.title)).toEqual(["run 4", "run 3"]);
    const second = await store.list({ limit: 2, before: first.nextBefore });
    expect(second.runs.map((run) => run.title)).toEqual(["run 2", "run 1"]);
    expect((await store.list({ query: "needle" })).runs.map((run) => run.title)).toEqual(["run 1"]);
    await expect(store.read("../index")).rejects.toThrow("No such run");
  });

  it("stops storing payloads past the per-run limit but still ends the run", async () => {
    const store = await openStore();
    const scope = store.scope("wechat");
    const run = scope.begin({ session: "wechat", source: "owner", model: "faux/m", text: "big" });
    for (let index = 0; index < 300; index++) run.record({ type: "tool_end", id: `c${index}`, name: "read", ms: 1, isError: false, result: "y".repeat(16_384) });
    scope.finish("ok");
    await store.flush();
    const summary = (await store.list()).runs[0]!;
    const events = await store.read(summary.id);
    expect(types(events).filter((type) => type === "truncated")).toHaveLength(1);
    expect(types(events).at(-1)).toBe("run_end");
    expect(summary.toolCalls).toBe(300);
  });

  it("adds a late delivery report to the run that produced the reply", async () => {
    const store = await openStore();
    const seen: string[] = [];
    store.on((_summary, event) => seen.push(event.type));
    const scope = store.scope("wechat");
    scope.begin({ session: "wechat", source: "owner", model: "faux/m", text: "hi" });
    scope.finish("ok", { reply: "hello" });
    store.note("wechat", { type: "delivery", ok: false, error: "ret=-2" });
    await store.flush();
    const reopened = await openStore();
    const summary = (await reopened.list()).runs[0]!;
    expect(summary.delivered).toBe(false);
    expect(types(await reopened.read(summary.id))).toEqual(["run_start", "run_end", "delivery"]);
    expect(seen).toEqual(["run_start", "run_end", "delivery"]);
  });
});

describe("run traces from sessions", () => {
  async function runSession(responses: Parameters<ReturnType<typeof createFaux>["setResponses"]>[0], tools: AgentTool<any>[] = [echo]) {
    const store = await openStore();
    const faux = createFaux();
    faux.setResponses(responses);
    const session = await Session.open({
      key: "web:1", transcriptPath: join(dir, "t.jsonl"), model: faux.getModel(), tools, streamFn: fauxStreamFn(faux),
      getApiKey: () => "test-key", buildSystemPrompt: async () => "SYSTEM", emit: () => {}, retry: { attempts: 3, baseDelayMs: 1 },
      trace: store.scope("web:1"),
    });
    session.send("please echo");
    await session.whenIdle();
    await session.dispose();
    await store.flush();
    const summary = (await store.list()).runs[0]!;
    return { summary, events: await store.read(summary.id) };
  }

  it("records model calls, tool calls and the outcome in order", async () => {
    const { summary, events } = await runSession([
      fauxAssistantMessage([fauxThinking("I should echo"), fauxToolCall("echo", { text: "hi" }, { id: "call-1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("echoed")]),
    ]);
    expect(types(events)).toEqual(["run_start", "llm_start", "llm_end", "tool_start", "tool_end", "llm_start", "llm_end", "run_end"]);
    const [start, firstStart, firstEnd, toolStart, toolEnd, secondStart, secondEnd, end] = events as any[];
    expect(start).toMatchObject({ session: "web:1", source: "owner", text: "please echo" });
    expect(firstStart.system).toBe("SYSTEM");
    expect(firstStart.context).toMatchObject({ messages: 1, system: expect.any(Number), total: expect.any(Number) });
    expect(firstEnd).toMatchObject({ stopReason: "toolUse", thinking: "I should echo", toolCalls: [{ id: "call-1", name: "echo" }] });
    expect(toolStart).toMatchObject({ id: "call-1", name: "echo", args: "{\"text\":\"hi\"}" });
    expect(toolEnd).toMatchObject({ id: "call-1", isError: false, result: "echo:hi", details: "{\"length\":2}" });
    expect(secondStart.system).toBeUndefined();
    expect(secondEnd).toMatchObject({ stopReason: "stop", text: "echoed" });
    expect(end).toMatchObject({ outcome: "ok", reply: "echoed" });
    expect(summary).toMatchObject({ outcome: "ok", llmCalls: 2, toolCalls: 1, toolErrors: 0 });
  });

  it("records provider errors, retries and failed tools", async () => {
    const { summary, events } = await runSession([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "529 overloaded" }),
      fauxAssistantMessage([fauxToolCall("broken", { text: "x" }, { id: "call-2" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("could not do it"),
    ], [broken]);
    expect(types(events)).toEqual(["run_start", "llm_start", "llm_end", "retry", "llm_start", "llm_end", "tool_start", "tool_end", "llm_start", "llm_end", "run_end"]);
    expect(events[2]).toMatchObject({ stopReason: "error", error: "529 overloaded" });
    expect(events[3]).toMatchObject({ attempt: 1, delayMs: 10 });
    expect(events[7]).toMatchObject({ isError: true, result: expect.stringContaining("tool exploded") });
    expect(summary).toMatchObject({ outcome: "ok", toolErrors: 1, llmCalls: 3 });
  });

  it("records a run that fails after its retries as an error", async () => {
    const failure = fauxAssistantMessage("", { stopReason: "error", errorMessage: "offline" });
    const { summary, events } = await runSession([failure, failure, failure, failure]);
    expect(events.flatMap((event) => event.type === "retry" ? [event.delayMs] : [])).toEqual([1, 2, 4]);
    expect(summary).toMatchObject({ outcome: "error", error: expect.any(String) });
    expect(events.at(-1)).toMatchObject({ type: "run_end", outcome: "error" });
  });

  it("nests a delegated sub-agent's steps under its delegate call", async () => {
    const store = await openStore();
    const run = store.scope("wechat").begin({ session: "wechat", source: "owner", model: "faux/m", text: "delegate it" });
    const faux = createFaux();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("echo", { text: "child" }, { id: "child-call" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("child done"),
    ]);
    const tool = createDelegateTool({ workspace: dir, model: faux.getModel(), streamFn: fauxStreamFn(faux), getApiKey: () => "k", tools: [echo], trace: () => run });
    await writeFile(join(dir, "SOUL.md"), "soul");
    await tool.execute("delegate-call", { task: "do it" });
    await store.flush();
    const events = await store.read(run.id);
    const nested = events.filter((event) => event.type !== "run_start");
    expect(types(nested)).toEqual(["llm_start", "llm_end", "tool_start", "tool_end", "llm_start", "llm_end"]);
    for (const event of nested) expect(event).toMatchObject({ parent: "delegate-call" });
  });
});
