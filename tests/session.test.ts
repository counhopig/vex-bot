import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt, type FauxProviderHandle } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEvent } from "../src/core/events.js";
import { Session, type SessionOptions } from "../src/core/session.js";
import { estimateProviderInput } from "../src/context/budget.js";
import { readJsonl } from "../src/store/jsonl.js";
import { createFaux, fauxStreamFn, lastUserText } from "./helpers/faux.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";
import { evidence, judged } from "./helpers/evidence.js";

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
    evidence,
    ...overrides,
  });
}

const kinds = () => events.filter((e) => e.kind !== "text_delta").map((e) => e.kind);

describe("Session", () => {
  it("reports an oversized final request locally without calling or retrying the provider", async () => {
    const provider = vi.fn(fauxStreamFn(createFaux()));
    const model = { ...createFaux().getModel(), contextWindow: 500, maxTokens: 100 };
    const session = await Session.open({ evidence,
      key: "web:budget", transcriptPath: join(dir, "budget.jsonl"), model, tools: [], streamFn: provider,
      getApiKey: () => undefined, buildSystemPrompt: async () => "SYSTEM", emit: (event) => events.push(event), retry: { attempts: 3, baseDelayMs: 1 },
    });
    session.send("x".repeat(3000));
    await session.whenIdle();
    expect(provider).not.toHaveBeenCalled();
    expect(events.filter((event) => event.kind === "error").map((event) => event.kind === "error" ? event.message : "").join(" ")).toContain("VEX_CONTEXT_BUDGET:");
    expect(session.completionOutcome).toMatchObject({ successful: false, failureReason: expect.stringContaining("exceeding the 500-token model context") });
    await session.dispose();
  });

  it("rejects oversized tool declarations before the provider is called", async () => {
    const provider = vi.fn(fauxStreamFn(createFaux()));
    const model = { ...createFaux().getModel(), contextWindow: 4000, maxTokens: 100 };
    const oversized = { ...echoTool, description: "schema declaration ".repeat(2000) } as AgentTool<any>;
    const session = await Session.open({ evidence,
      key: "web:tool-budget", transcriptPath: join(dir, "tool-budget.jsonl"), model, tools: [oversized], streamFn: provider,
      getApiKey: () => undefined, buildSystemPrompt: async () => "SYSTEM", emit: (event) => events.push(event), retry: { attempts: 3, baseDelayMs: 1 },
    });
    session.send("hello");
    await session.whenIdle();
    expect(provider).not.toHaveBeenCalled();
    expect(events.filter((event) => event.kind === "error").map((event) => event.kind === "error" ? event.message : "").join(" ")).toContain("VEX_CONTEXT_BUDGET:");
    await session.dispose();
  });

  it("records first-generation usage when an oversized correction is rejected without retry", async () => {
    faux = createFaux();
    faux.setResponses([fauxAssistantMessage("I saved it.")]);
    const provider = vi.fn(fauxStreamFn(faux));
    const request = "Please save https://example.test/a.";
    const baseInput = estimateProviderInput({
      messages: [
        { role: "system", content: "SYSTEM", timestamp: 0 },
        { role: "user", content: request, timestamp: 0 },
      ],
      tools: [echoTool],
    });
    const model = { ...faux.getModel(), contextWindow: baseInput + 150, maxTokens: 100 };
    const session = await Session.open({
      key: "web:correction-budget", transcriptPath: join(dir, "correction-budget.jsonl"), model, tools: [echoTool], streamFn: provider,
      getApiKey: () => undefined, buildSystemPrompt: async () => "SYSTEM", emit: (event) => events.push(event),
      evidence: judged({ judge: { route: async () => ({ tool: null, confidence: 0 }), unsupported: async () => 1 }, confidence: 0.8, warn: () => {} }),
      retry: { attempts: 3, baseDelayMs: 1 },
    });
    session.send(request);
    await session.whenIdle();
    expect(provider).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event.kind === "error").map((event) => event.kind === "error" ? event.message : "").join(" ")).toContain("VEX_CONTEXT_BUDGET:");
    const records = await readJsonl<{ type?: string; usage?: { input: number; output: number; totalTokens: number } }>(join(dir, "correction-budget.jsonl"));
    const usage = records.find((record) => record.type === "provider_usage")?.usage;
    expect(usage?.input).toBeGreaterThan(0);
    expect(usage?.output).toBeGreaterThan(0);
    expect(usage!.totalTokens).toBeGreaterThan(usage!.input + usage!.output);
    await session.dispose();
  });

  it("routes to a tool and prevents an unattempted failure from reaching the owner or transcript", async () => {
    let calls = 0;
    faux = createFaux();
    faux.setResponses([
      () => { calls++; return fauxAssistantMessage("I could not read it: 2MB limit."); },
      (context) => {
        calls++;
        expect(getCurrentSystemPrompt(context.messages)).toContain("Tool routing: use echo");
        expect(getCurrentSystemPrompt(context.messages)).toContain("proposed reply was rejected");
        return fauxAssistantMessage(fauxToolCall("echo", { text: "article" }), { stopReason: "toolUse" });
      },
      () => { calls++; return fauxAssistantMessage("Article was read."); },
      () => { calls++; return fauxAssistantMessage("I could not verify that operation."); },
    ]);
    const s = await open({ evidence: judged({
      confidence: 0.8, warn: () => {},
      judge: { route: async () => ({ tool: "echo", confidence: 0.95 }), unsupported: async () => 0 },
    }) });
    s.send("check https://example.com/article");
    await s.whenIdle();
    expect(calls).toBe(4);
    expect(events.filter((e) => e.kind === "assistant_message")).not.toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("2MB") })]));
    expect(events.filter((e) => e.kind === "text_delta")).not.toEqual(expect.arrayContaining([expect.objectContaining({ delta: expect.stringContaining("2MB") })]));
    expect(JSON.stringify(await readJsonl(join(dir, "t.jsonl")))).not.toContain("2MB");
    expect(s.successfulReply).toContain("could not verify");
    await s.dispose();
  });

  it("does not reuse a previous Session run's real tool result for a new claim", async () => {
    faux = createFaux();
    const fetchTool: AgentTool<any> = {
      name: "web_fetch",
      label: "Fetch web page",
      description: "Fetch a web page",
      parameters: Type.Object({ url: Type.String() }),
      execute: async () => ({ content: [{ type: "text", text: "Original article body" }], details: {} }),
    };
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("web_fetch", { url: "https://example.test/article" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("I read https://example.test/article."),
      fauxAssistantMessage("I already read https://example.test/article."),
      fauxAssistantMessage("I cannot verify a new read in this turn."),
    ]);
    const session = await open({ tools: [fetchTool] });
    session.send("Read https://example.test/article");
    await session.whenIdle();
    expect(session.successfulReply).toContain("I read");
    session.send("Confirm you read https://example.test/article");
    await session.whenIdle();
    // The unsupported claim is withheld; the honest correction that follows is kept.
    expect(session.successfulReply).toBe("I cannot verify a new read in this turn.");
    expect(JSON.stringify(session.history().items)).not.toContain("I already read");
    expect(session.history().items.filter((item) => item.kind === "tool" && item.toolName === "web_fetch")).toHaveLength(1);
    await session.dispose();
  });

  it("queues injected notifications until an active tool turn settles", async () => {
    faux = createFaux();
    let accepted = false;
    const notifyTool: AgentTool<typeof EchoParams> = {
      ...echoTool,
      execute: async () => {
        await s.enqueueAssistant("Wiki update finished");
        accepted = true;
        return { content: [{ type: "text", text: "tool-result" }], details: {} };
      },
    };
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("echo", { text: "run" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("owner reply"),
    ]);
    const s = await open({ tools: [notifyTool] });
    s.send("start Wiki update");
    await s.whenIdle();
    expect(accepted).toBe(true);
    expect(s.busy).toBe(false);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "assistant_message", text: "owner reply" }),
      expect.objectContaining({ kind: "assistant_message", text: "Wiki update finished", injected: true }),
    ]));
    const records = await readJsonl(join(dir, "t.jsonl"));
    expect(records.findIndex((r) => JSON.stringify(r).includes("tool-result"))).toBeGreaterThan(-1);
    expect(records.findIndex((r) => JSON.stringify(r).includes("Wiki update finished"))).toBeGreaterThan(records.findIndex((r) => JSON.stringify(r).includes("owner reply")));
    await s.dispose();
  });

  it("serializes an idle notification ahead of a newly arriving owner turn", async () => {
    faux = createFaux();
    faux.setResponses([fauxAssistantMessage("owner reply")]);
    const s = await open();
    await s.enqueueAssistant("background update");
    s.send("owner request");
    await s.whenIdle();
    expect(events.findIndex((e) => e.kind === "assistant_message" && e.injected)).toBeLessThan(events.findIndex((e) => e.kind === "user_message"));
    expect(s.successfulReply).toBe("owner reply");
    await s.dispose();
  });

  it("drains notifications accepted by the run-end hook", async () => {
    faux = createFaux();
    faux.setResponses([fauxAssistantMessage("done")]);
    const s = await open({ onRunEnd: async () => { await s.enqueueAssistant("settlement update"); } });
    s.send("owner request");
    await s.whenIdle();
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "assistant_message", text: "settlement update", injected: true })]));
    await s.dispose();
  });

  it("clears queued notifications when a busy session is disposed", async () => {
    faux = createFaux(1);
    faux.setResponses([fauxAssistantMessage("a slow response")]);
    const s = await open();
    s.send("owner request");
    await s.enqueueAssistant("queued notification");
    await s.dispose();
    expect(events).not.toContainEqual(expect.objectContaining({ kind: "assistant_message", text: "queued notification", injected: true }));
  });

  it("drains a notification queued after a previous stop", async () => {
    faux = createFaux(1);
    faux.setResponses([fauxAssistantMessage("a slow response")]);
    const s = await open();
    s.send("owner request");
    s.stop();
    await s.whenIdle();
    await s.enqueueAssistant("after-stop notification");
    await s.whenIdle();
    expect(events).toContainEqual(expect.objectContaining({ kind: "assistant_message", text: "after-stop notification", injected: true }));
    await s.dispose();
  });

  it("checks claims against actual tool results before releasing a final reply", async () => {
    faux = createFaux();
    let judgments = 0;
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("echo", { text: "article" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Reading failed with a size limit."),
      fauxAssistantMessage("Read successfully."),
    ]);
    const s = await open({ evidence: judged({ confidence: 0.8, warn: () => {}, judge: {
      route: async () => ({ tool: null, confidence: 1 }),
      unsupported: async (state) => { expect(JSON.stringify(state)).toContain("echo:article"); judgments++; return 0.99; },
    } }) });
    s.send("read this article");
    await s.whenIdle();
    expect(judgments).toBe(2);
    expect(s.successfulReply).toContain("could not verify");
    expect(JSON.stringify(events)).not.toContain("size limit");
    await s.dispose();
  });

  it("suppresses unsupported prose beside a valid tool call while preserving the call", async () => {
    faux = createFaux();
    const read: AgentTool<any> = { name: "web_fetch", label: "Read", description: "Read a page", parameters: Type.Object({ url: Type.String() }), execute: async () => ({
      content: [{ type: "text", text: "read receipt" }], details: { receipt: { version: 1, requestedUrl: "https://example.test/a", sourceAvailable: true, excerpt: "short source" } },
    }) };
    faux.setResponses([
      fauxAssistantMessage([{ type: "text", text: "Saved and pushed." }, fauxToolCall("web_fetch", { url: "https://example.test/a" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("I read the page."),
    ]);
    const s = await open({ tools: [read] });
    s.send("Read https://example.test/a");
    await s.whenIdle();
    expect(s.successfulReply).toBe("I read the page.");
    expect(JSON.stringify(events)).not.toContain("Saved and pushed");
    expect(events).toContainEqual(expect.objectContaining({ kind: "tool_start", toolName: "web_fetch" }));
    await s.dispose();
  });

  it("uses matched execution evidence nested in a delegate receipt", async () => {
    const url = "https://example.test/child";
    faux = createFaux();
    faux.setResponses([fauxAssistantMessage(fauxToolCall("delegate", { task: `Read ${url}` }), { stopReason: "toolUse" }), fauxAssistantMessage("I read the page.")]);
    const delegate: AgentTool<any> = { name: "delegate", label: "Delegate", description: "Delegate", parameters: Type.Object({ task: Type.String() }), execute: async () => ({
      content: [{ type: "text", text: "child receipt" }], details: { receipt: { version: 1, evidence: [{ tool: "web_fetch", callId: "child-read", arguments: JSON.stringify({ url }), error: false, result: "read", receipt: { version: 1, requestedUrl: url, sourceAvailable: true } }], checkedReply: "I read it." } },
    }) };
    const s = await open({ tools: [delegate] });
    s.send(`Read ${url}`);
    await s.whenIdle();
    expect(s.successfulReply).toBe("I read the page.");
    await s.dispose();
  });

  it("does not treat delegate narration as read evidence", async () => {
    const url = "https://example.test/child";
    faux = createFaux();
    faux.setResponses([fauxAssistantMessage(fauxToolCall("delegate", { task: `Read ${url}` }), { stopReason: "toolUse" }), fauxAssistantMessage("I read the page."), fauxAssistantMessage("I cannot confirm a read.")]);
    const delegate: AgentTool<any> = { name: "delegate", label: "Delegate", description: "Delegate", parameters: Type.Object({ task: Type.String() }), execute: async () => ({ content: [{ type: "text", text: "child narration" }], details: { receipt: { version: 1, evidence: [], checkedReply: "I read it." } } }) };
    const s = await open({ tools: [delegate] });
    s.send(`Read ${url}`);
    await s.whenIdle();
    expect(s.successfulReply).toBe("I cannot confirm a read.");
    expect(JSON.stringify(s.history().items)).not.toContain("I read the page.");
    await s.dispose();
  });

  it("falls back to normal execution when the routing service is unavailable", async () => {
    faux = createFaux();
    faux.setResponses([fauxAssistantMessage("hello")]);
    const warnings: unknown[] = [];
    const s = await open({ evidence: judged({ confidence: 0.8, warn: (error) => warnings.push(error), judge: {
      route: async () => { throw new Error("TypeSafe unavailable"); }, unsupported: async () => 0,
    } }) });
    s.send("hello");
    await s.whenIdle();
    expect(s.successfulReply).toBe("hello");
    expect(warnings).toHaveLength(1);
    await s.dispose();
  });

  it("redacts configured secrets from every Jev evaluation", async () => {
    faux = createFaux();
    faux.setResponses([fauxAssistantMessage("Hello.")]);
    const captured: string[] = [];
    const s = await open({
      tools: [{ ...echoTool, description: "Tool credential TOPSECRET" } as AgentTool<any>],
      evidence: judged({ secrets: () => ["TOPSECRET", "jev-secret"], confidence: 0.8, warn: () => {}, judge: {
        route: async (state, tools) => { captured.push(JSON.stringify(state), JSON.stringify(tools)); return { tool: null, confidence: 1 }; },
        unsupported: async (state) => { captured.push(JSON.stringify(state)); return 0; },
      } }),
    });
    s.send("Hi TOPSECRET");
    await s.whenIdle();
    expect(captured.join(" ")).not.toContain("TOPSECRET");
    expect(captured.join(" ")).not.toContain("jev-secret");
    await s.dispose();
  });

  it("uses the local receipt guard when the evidence judge is unavailable", async () => {
    faux = createFaux();
    faux.setResponses([fauxAssistantMessage("I read https://example.test/a."), fauxAssistantMessage("I read https://example.test/a.")]);
    const warnings: unknown[] = [];
    const s = await open({ evidence: judged({ confidence: 0.8, warn: (error) => warnings.push(error), judge: {
      route: async () => ({ tool: null, confidence: 1 }),
      unsupported: async () => { throw new Error("checker unavailable"); },
    } }) });
    s.send("Read https://example.test/a");
    await s.whenIdle();
    expect(warnings).toHaveLength(2);
    expect(s.successfulReply).toContain("could not verify");
    expect(events.some((event) => event.kind === "error")).toBe(false);
    await s.dispose();
  });

  it("does not force uncertain tool routes", async () => {
    faux = createFaux();
    faux.setResponses([fauxAssistantMessage("hello")]);
    const s = await open({ evidence: judged({ confidence: 0.8, warn: () => {}, judge: {
      route: async () => ({ tool: "echo", confidence: 0.1 }), unsupported: async () => 0,
    } }) });
    s.send("hello");
    await s.whenIdle();
    expect(s.successfulReply).toBe("hello");
    expect(faux.state.callCount).toBe(1);
    await s.dispose();
  });

  it("bounds evidence repair to one attempt", async () => {
    let calls = 0;
    faux = createFaux();
    faux.setResponses([() => { calls++; return fauxAssistantMessage("I ran the command."); }, () => { calls++; return fauxAssistantMessage("I ran the command."); }]);
    const s = await open({ evidence: judged({
      confidence: 0.8, warn: () => {},
      judge: { route: async () => ({ tool: "echo", confidence: 1 }), unsupported: async () => 1 },
    }) });
    s.send("run echo");
    await s.whenIdle();
    expect(calls).toBe(2);
    expect(s.successfulReply).toContain("could not verify");
    expect(JSON.stringify(events)).not.toContain("could not be verified");
    await s.dispose();
  });

  it("preserves approval denials when tool routing is enabled", async () => {
    faux = createFaux();
    let calls = 0;
    faux.setResponses([() => { calls++; return fauxAssistantMessage(fauxToolCall("echo", { text: "article" }), { stopReason: "toolUse" }); }, () => { calls++; return fauxAssistantMessage("The owner denied the operation."); }]);
    const s = await open({
      beforeToolCall: async () => ({ block: true, reason: "owner denied" }),
      evidence: judged({ confidence: 0.8, warn: () => {}, judge: {
        route: async () => ({ tool: "echo", confidence: 1 }),
        unsupported: async (state) => { expect(JSON.stringify(state)).toContain("owner denied"); return 0; },
      } }),
    });
    s.send("read link");
    await s.whenIdle();
    expect(s.successfulReply).toBe("The owner denied the operation.");
    await s.dispose();
  });

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

  it("runs a message sent during onRunEnd as its own persisted turn", async () => {
    faux = createFaux();
    faux.setResponses([fauxAssistantMessage("first reply"), (ctx) => fauxAssistantMessage(`re:${lastUserText(ctx)}`)]);
    let ended = 0;
    let session!: Session;
    session = await open({ onRunEnd: async () => { if (++ended === 1) session.send("second"); } });
    session.send("first");
    await session.whenIdle();
    await session.whenIdle();
    expect(events.filter((e) => e.kind === "user_message").map((e) => (e as { text: string }).text)).toEqual(["first", "second"]);
    expect(events.filter((e) => e.kind === "assistant_message").map((e) => (e as { text: string }).text)).toEqual(["first reply", "re:second"]);
    expect((await readJsonl<{ role: string }>(join(dir, "t.jsonl"))).map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(ended).toBe(2);
  });

  it("silences failed outreach while keeping owner errors visible", async () => {
    faux = createFaux();
    faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "offline" })]);
    const session = await open({ retry: { attempts: 0, baseDelayMs: 1 } });
    session.send("internal", "proactive chat");
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
    expect(events).toContainEqual({ kind: "tool_update", toolCallId: "progress", toolName: "echo", text: "\nStarted read: MEMORY.md\n" });
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
    const session = await open({ beforeToolCall: async () => ({ block: true, reason: "The owner denied this echo call." }) });
    session.send("go");
    await session.whenIdle();
    expect(events.find((e) => e.kind === "tool_end")).toMatchObject({ isError: true });
    expect(events.at(-2)).toMatchObject({ text: "model saw: The owner denied this echo call." });
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
    expect(events).toContainEqual({ kind: "error", message: "Model call failed: Provider generation failed before a checked reply was available." });
    expect(faux.getPendingResponseCount()).toBe(0);
    expect(session.history().items.map((i) => i.kind)).toEqual(["user"]);
    expect(await readFile(join(dir, "t.jsonl"), "utf8")).toContain('"type":"provider_usage"');
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
