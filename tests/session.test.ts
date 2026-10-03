import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt, type FauxProviderHandle } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionEvent } from "../src/core/events.js";
import { Session, type SessionOptions } from "../src/core/session.js";
import { readJsonl } from "../src/store/jsonl.js";
import { createFaux, fauxStreamFn, lastUserText } from "./helpers/faux.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

let dir: string;
let faux: FauxProviderHandle;
let events: SessionEvent[];

beforeEach(async () => {
  dir = await makeTmpDir();
  events = [];
});
afterEach(async () => {
  await removeTmpDir(dir);
});

const EchoParams = Type.Object({ text: Type.String() });
const echoTool: AgentTool<typeof EchoParams> = {
  name: "echo",
  label: "Echo",
  description: "echo",
  parameters: EchoParams,
  execute: async (_id, { text }) => ({ content: [{ type: "text", text: `echo:${text}` }], details: {} }),
};

function open(overrides: Partial<SessionOptions> = {}): Promise<Session> {
  return Session.open({
    key: "web:1",
    transcriptPath: join(dir, "t.jsonl"),
    model: faux.getModel(),
    tools: [echoTool],
    streamFn: fauxStreamFn(faux),
    getApiKey: () => "test-key",
    buildSystemPrompt: async () => "SYSTEM",
    emit: (event) => events.push(event),
    retry: { attempts: 3, baseDelayMs: 1 },
    ...overrides,
  });
}

const kinds = () => events.filter((e) => e.kind !== "text_delta").map((e) => e.kind);

describe("Session", () => {
  it("streams a reply, persists the transcript and reports busy once", async () => {
    faux = createFaux();
    faux.setResponses([(ctx) => fauxAssistantMessage(`sys=${getCurrentSystemPrompt(ctx.messages)}`)]);
    const session = await open();
    session.send("你好");
    expect(session.busy).toBe(true);
    await session.whenIdle();
    expect(session.busy).toBe(false);
    expect(kinds()).toEqual(["busy", "user_message", "assistant_message", "busy"]);
    expect(events.filter((e) => e.kind === "text_delta").map((e) => e.delta).join("")).toBe("sys=SYSTEM");
    expect(events.at(-2)).toMatchObject({ kind: "assistant_message", text: "sys=SYSTEM", stopReason: "stop" });
    const saved = await readJsonl<{ role: string }>(join(dir, "t.jsonl"));
    expect(saved.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("queues injected heartbeat until the active run finishes and restores it as assistant history", async () => {
    faux = createFaux(100);
    faux.setResponses([fauxAssistantMessage("owner response ".repeat(5))]);
    const session = await open();
    session.send("owner request");
    const injecting = session.injectAssistant("heartbeat result");
    await injecting;
    const saved = await readJsonl<{ role: string; content: unknown }>(join(dir, "t.jsonl"));
    expect(saved.map(m => m.role)).toEqual(["user", "assistant", "assistant"]);
    expect(events.at(-1)).toMatchObject({ kind: "assistant_message", text: "heartbeat result", injected: true });
    expect(events.findIndex(e => e.kind === "busy" && !e.busy)).toBeLessThan(events.length - 1);
    const restored = await open();
    expect(restored.history().items.at(-1)).toMatchObject({ kind: "assistant", text: "heartbeat result" });
  });

  it("silences failed outreach while keeping owner errors visible", async () => {
    faux = createFaux();
    faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "offline" })]);
    const session = await open({ retry: { attempts: 0, baseDelayMs: 1 } });
    session.send("internal", "主动聊天");
    await session.whenIdle();
    expect(events.some(e => e.kind === "error")).toBe(false);
    expect(events.at(-1)).toMatchObject({ kind: "busy", busy: false, discardReply: true });
    expect(session.successfulReply).toBeUndefined();
    faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "offline" })]);
    session.send("owner");
    await session.whenIdle();
    expect(events.some(e => e.kind === "error")).toBe(true);
  });

  it("cancels heartbeat injection immediately while a permanent session is busy", async () => {
    faux = createFaux(1);
    faux.setResponses([fauxAssistantMessage("a very slow permanent reply")]);
    const session = await open();
    session.send("owner");
    const abort = new AbortController();
    const injection = session.injectAssistant("heartbeat", abort.signal);
    abort.abort();
    await expect(injection).rejects.toMatchObject({ name: "AbortError" });
    expect(session.busy).toBe(true);
    await session.dispose();
    expect(session.history().items.some(item => item.kind === "assistant" && item.text === "heartbeat")).toBe(false);
  });

  it("forwards delegated subtool progress through session events", async () => {
    faux = createFaux();
    const progressing: AgentTool<typeof EchoParams> = { ...echoTool, execute: async (_id, _args, _signal, onUpdate) => {
      onUpdate?.({ content: [], details: { type: "tool_execution_start", toolName: "read", args: { path: "MEMORY.md" } } });
      return { content: [{ type: "text" as const, text: "done" }], details: {} };
    } };
    faux.setResponses([fauxAssistantMessage(fauxToolCall("echo", { text: "x" }, { id: "progress" }), { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
    const session = await open({ tools: [progressing] });
    session.send("run"); await session.whenIdle();
    expect(events).toContainEqual({ kind: "tool_update", toolCallId: "progress", toolName: "echo", text: "\n开始 read：MEMORY.md\n" });
  });

  it("restores history from the transcript", async () => {
    faux = createFaux();
    faux.setResponses([
      fauxAssistantMessage("第一次"),
      (ctx) => fauxAssistantMessage(`看到 ${ctx.messages.filter((m) => m.role !== "system").length} 条消息`),
    ]);
    const first = await open();
    first.send("一");
    await first.whenIdle();

    const second = await open();
    expect(second.history().items).toMatchObject([
      { kind: "user", text: "一" },
      { kind: "assistant", text: "第一次" },
    ]);
    second.send("二");
    await second.whenIdle();
    expect(events.at(-2)).toMatchObject({ kind: "assistant_message", text: "看到 3 条消息" });
  });

  it("runs tools and reports them", async () => {
    faux = createFaux();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("echo", { text: "hi" }, { id: "call-1" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    const session = await open();
    session.send("go");
    await session.whenIdle();
    expect(kinds()).toEqual(["busy", "user_message", "tool_start", "tool_end", "assistant_message", "busy"]);
    expect(events.find((e) => e.kind === "tool_start")).toEqual({
      kind: "tool_start", toolCallId: "call-1", toolName: "echo", summary: '{"text":"hi"}',
    });
    expect(session.history().items).toEqual([
      expect.objectContaining({ kind: "user", text: "go" }),
      { kind: "tool", toolCallId: "call-1", toolName: "echo", summary: '{"text":"hi"}', isError: false },
      expect.objectContaining({ kind: "assistant", text: "done" }),
    ]);
  });

  it("feeds a blocked tool's reason back to the model", async () => {
    faux = createFaux();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("echo", { text: "x" }), { stopReason: "toolUse" }),
      (ctx) => {
        const result = ctx.messages.at(-1);
        const text = result?.role === "toolResult" ? result.content.map((c) => (c.type === "text" ? c.text : "")).join("") : "";
        return fauxAssistantMessage(`model saw: ${text}`);
      },
    ]);
    const session = await open({ beforeToolCall: async () => ({ block: true, reason: "主人拒绝了这次 echo 调用。" }) });
    session.send("go");
    await session.whenIdle();
    expect(events.find((e) => e.kind === "tool_end")).toMatchObject({ isError: true });
    expect(events.at(-2)).toMatchObject({ text: "model saw: 主人拒绝了这次 echo 调用。" });
  });

  it("injects a message sent while busy into the same run", async () => {
    faux = createFaux(20);
    faux.setResponses([
      fauxAssistantMessage("aaaa bbbb cccc dddd eeee"),
      (ctx) => fauxAssistantMessage(`回应：${lastUserText(ctx)}`),
    ]);
    const session = await open();
    session.send("一");
    await new Promise((r) => setTimeout(r, 100));
    session.send("二");
    await session.whenIdle();
    expect(kinds()).toEqual(["busy", "user_message", "assistant_message", "user_message", "assistant_message", "busy"]);
    expect(events.at(-2)).toMatchObject({ text: "回应：二" });
  });

  it("stops the current turn and drops queued messages", async () => {
    faux = createFaux(20);
    faux.setResponses([fauxAssistantMessage("long ".repeat(80)), fauxAssistantMessage("never")]);
    const session = await open();
    session.send("go");
    await new Promise((r) => setTimeout(r, 200));
    session.send("queued");
    session.stop();
    await session.whenIdle();
    const last = events.filter((e) => e.kind === "assistant_message").at(-1);
    expect(last).toMatchObject({ stopReason: "aborted" });
    expect(events.some((e) => e.kind === "user_message" && e.text === "queued")).toBe(false);
    expect(faux.getPendingResponseCount()).toBe(1);
  });

  it("retries a failed model call and keeps errors out of the transcript", async () => {
    faux = createFaux();
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" }),
      fauxAssistantMessage("ok"),
    ]);
    const session = await open();
    session.send("go");
    await session.whenIdle();
    expect(kinds()).toEqual(["busy", "user_message", "assistant_message", "busy"]);
    const saved = await readJsonl<{ role: string; stopReason?: string }>(join(dir, "t.jsonl"));
    expect(saved.map((m) => m.stopReason ?? m.role)).toEqual(["user", "stop"]);
  });

  it("reports the error after exhausting retries", async () => {
    faux = createFaux();
    const failure = fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" });
    faux.setResponses([failure, failure, failure, failure]);
    const session = await open();
    session.send("go");
    await session.whenIdle();
    expect(events).toContainEqual({ kind: "error", message: "模型调用失败：boom" });
    expect(faux.getPendingResponseCount()).toBe(0);
    expect(session.history().items.map((i) => i.kind)).toEqual(["user"]);
  });

  it("runs a message sent after stop as its own turn", async () => {
    faux = createFaux(20);
    faux.setResponses([fauxAssistantMessage("long ".repeat(80)), (ctx) => fauxAssistantMessage(`回应：${lastUserText(ctx)}`)]);
    const session = await open();
    session.send("go");
    await new Promise((r) => setTimeout(r, 200));
    session.stop();
    session.send("after");
    while (session.busy) await session.whenIdle();
    expect(events.filter((e) => e.kind === "assistant_message").at(-1)).toMatchObject({ text: "回应：after", stopReason: "stop" });
    expect(events.filter((e) => e.kind === "user_message").map((e) => (e as { text: string }).text)).toEqual(["go", "after"]);
  });

  it("does not wait out the retry backoff after stop", async () => {
    faux = createFaux();
    faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" }), fauxAssistantMessage("never")]);
    const session = await open({ retry: { attempts: 3, baseDelayMs: 5000 } });
    session.send("go");
    await new Promise((r) => setTimeout(r, 100));
    const started = Date.now();
    session.stop();
    await session.whenIdle();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(faux.getPendingResponseCount()).toBe(1);
  });
});
