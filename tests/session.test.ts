import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt, type AssistantMessage, type FauxProviderHandle, type ToolResultMessage } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEvent } from "../src/core/events.js";
import { Session, type SessionOptions } from "../src/core/session.js";
import type { LinkIntent } from "../src/policy/judge.js";
import { LinkActionController, type LinkActionOptions } from "../src/links/actions.js";
import type { TurnControllerFactory } from "../src/core/turnController.js";
import { createRequestActionOutcomeTool } from "../src/tools/requestOutcome.js";
import { estimateProviderInput } from "../src/context/budget.js";
import type { Wiki } from "../src/vault/wiki/service.js";
import { createWikiInteractiveTools } from "../src/vault/wiki/tools.js";
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

/** The daemon's link-action controller with its routes, for sessions under test. */
function linkActions(options: Omit<LinkActionOptions, "routes" | "fallbackTools">): TurnControllerFactory {
  return (host) => new LinkActionController({
    routes: { archive: "wiki_ingest", read: "web_fetch" }, fallbackTools: ["bash", "delegate"],
    onOutcome: (message) => host.enqueueAssistant(message), onUsage: (usage) => host.recordUsage(usage), ...options,
  });
}

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
    const oversized = { ...echoTool, description: "schema declaration ".repeat(500) } as AgentTool<any>;
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
    expect(session.successfulReply).toBe("I could not verify that the requested operation was performed, so I cannot report it as complete.");
    expect(session.history().items.filter((item) => item.kind === "tool" && item.toolName === "web_fetch")).toHaveLength(1);
    await session.dispose();
  });

  it("charges actual fallback classification usage once when the owner request is rejected by its budget", async () => {
    faux = createFaux();
    const url = "https://example.test/article";
    let classifierUsage: AssistantMessage["usage"] | undefined;
    const classifierResponse = (context: Parameters<typeof lastUserText>[0]) => {
      const input = lastUserText(context);
      return input.includes("Classify each supplied URL")
        ? fauxAssistantMessage(JSON.stringify({ actions: [{ url, intent: "defer", confidence: 0.99 }] }))
        : fauxAssistantMessage("The link action was deferred.");
    };
    faux.setResponses(Array.from({ length: 10 }, () => classifierResponse));
    const baseModel = faux.getModel();
    const model = { ...baseModel, contextWindow: 5_000, maxTokens: 1_000 };
    const requestText = `Please read ${url}`;
    const outcomeTool = createRequestActionOutcomeTool(() => true);
    const fixedInput = estimateProviderInput({ messages: [{ role: "user", content: requestText, timestamp: 0 }], tools: [outcomeTool] });
    const systemPrompt = `SYSTEM ${"x".repeat(3_430 - fixedInput)}`;
    const upstream = fauxStreamFn(faux);
    const provider = vi.fn(async (...args: Parameters<typeof upstream>) => {
      const stream = await upstream(...args);
      if (lastUserText(args[1]).includes("Classify each supplied URL")) {
        void stream.result().then((message) => { classifierUsage = message.usage; });
      }
      return stream;
    });
    const route = vi.fn(async () => ({ tool: "echo", confidence: 0.99 }));
    const session = await Session.open({
      key: "web:classification-budget", transcriptPath: join(dir, "classification-budget.jsonl"), model, tools: [], streamFn: provider,
      getApiKey: () => undefined, buildSystemPrompt: async () => systemPrompt,
      controller: linkActions({ confidence: 0.8, classify: async () => { throw new Error("classification service unavailable"); } }),
      evidence: judged({ confidence: 0.8, warn: () => {}, judge: { route, unsupported: async () => 0 } }),
      emit: (event) => events.push(event), retry: { attempts: 1, baseDelayMs: 1 },
    });
    session.send(requestText);
    await session.whenIdle();
    expect(faux.state.callCount).toBe(1);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(route).not.toHaveBeenCalled();
    expect(session.completionOutcome.failureReason).toContain("VEX_CONTEXT_BUDGET:");
    const records = await readJsonl<{ type?: string; usage?: AssistantMessage["usage"] }>(join(dir, "classification-budget.jsonl"));
    const usageRecords = records.filter((record) => record.type === "provider_usage");
    expect(usageRecords).toHaveLength(1);
    expect(classifierUsage).toBeDefined();
    expect(usageRecords[0]?.usage).toEqual(classifierUsage);
    expect(usageRecords[0]?.usage?.totalTokens).toBe(classifierUsage!.totalTokens);
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

  it("archives a shared link through one normal pi tool call even when the main model only summarizes", async () => {
    const url = "https://example.com/article";
    let ingests = 0;
    const ingest: AgentTool<any> = {
      name: "wiki_ingest", label: "Ingest", description: "Archive a source", parameters: Type.Object({ url: Type.String() }),
      execute: async (_id, rawArgs) => { ingests++; expect((rawArgs as { url: string }).url).toBe(url); return { content: [{ type: "text", text: JSON.stringify({ status: "completed" }) }], details: { receipt: { status: "completed", sourceAvailable: true } } }; },
    };
    faux = createFaux();
    faux.setResponses([(context) => {
      const owner = context.messages.find((message) => message.role === "user");
      expect(owner && "vexRequestId" in owner && typeof owner.vexRequestId === "string").toBe(true);
      expect(context.messages.some((message) => message.role === "toolResult" && message.toolName === "wiki_ingest")).toBe(true);
      return fauxAssistantMessage("A short summary.");
    }]);
    const s = await open({ tools: [ingest], controller: linkActions({ confidence: 0.8, classify: async (_input, urls) => urls.map((url): LinkIntent => ({ url, intent: "archive", confidence: 0.99 })) }) });
    s.send(`summarize ${url}`);
    await s.whenIdle();
    expect(ingests).toBe(1);
    expect(s.successfulReply).toBe("A short summary.");
    const userRecord = (await readJsonl<Record<string, unknown>>(join(dir, "t.jsonl"))).find((record) => record.role === "user");
    expect(userRecord?.vexRequestId).toEqual(expect.any(String));
    await s.dispose();
  });

  it("treats an actual ingestion policy denial as terminal and blocks a model retry", async () => {
    let ingests = 0;
    let shellCalls = 0;
    const url = "https://example.com/denied";
    const ingest: AgentTool<any> = { name: "wiki_ingest", label: "Ingest", description: "Archive", parameters: Type.Object({ url: Type.String() }), execute: async () => { ingests++; return { content: [], details: {} }; } };
    const bash: AgentTool<any> = { name: "bash", label: "Shell", description: "Run commands", parameters: Type.Object({ command: Type.String() }), execute: async () => { shellCalls++; return { content: [], details: {} }; } };
    faux = createFaux();
    faux.setResponses([
      (context) => {
        expect(JSON.stringify(context.messages)).toContain("owner denied the action");
        return fauxAssistantMessage(fauxToolCall("bash", { command: `echo ${url}` }), { stopReason: "toolUse" });
      },
      fauxAssistantMessage("The action was denied."),
    ]);
    const s = await open({ tools: [ingest, bash], beforeToolCall: async (context) => context.toolCall.name === "wiki_ingest" ? { block: true, reason: "owner denied the action" } : undefined,
      controller: linkActions({ confidence: 0.8, classify: async (_input, urls) => urls.map((candidate): LinkIntent => ({ url: candidate, intent: "archive", confidence: 0.99 })) }),
      evidence: judged({ confidence: 0.8, warn: () => {}, judge: { route: async () => ({ tool: "bash", confidence: 0.99 }), unsupported: async () => 0 } }),
    });
    s.send(`summarize ${url}`);
    await s.whenIdle();
    expect(ingests).toBe(0);
    expect(shellCalls).toBe(0);
    expect(events).toContainEqual(expect.objectContaining({ kind: "assistant_message", text: expect.stringContaining("was blocked or denied"), injected: true }));
    await s.dispose();
  });

  it("blocks a model-selected duplicate ingestion after the runtime action completed", async () => {
    let ingests = 0;
    const url = "https://example.com/once";
    const ingest: AgentTool<any> = { name: "wiki_ingest", label: "Ingest", description: "Archive", parameters: Type.Object({ url: Type.String() }), execute: async () => { ingests++; return { content: [], details: { receipt: { status: "completed", sourceAvailable: true, rawPath: "raw/source.md", publication: "published", compiledPages: ["wiki/page.md"] } } }; } };
    faux = createFaux();
    faux.setResponses([fauxAssistantMessage(fauxToolCall("wiki_ingest", { url }), { stopReason: "toolUse" }), fauxAssistantMessage("Archived once.")]);
    const s = await open({ tools: [ingest], controller: linkActions({ confidence: 0.8, classify: async (_input, urls) => urls.map((candidate): LinkIntent => ({ url: candidate, intent: "archive", confidence: 0.99 })) }) });
    s.send(`summarize ${url}`);
    await s.whenIdle();
    expect(ingests).toBe(1);
    expect(JSON.stringify(await readJsonl(join(dir, "t.jsonl")))).toContain("already attempted archival");
    await s.dispose();
  });

  it("does not let an unrelated date result complete a link action", async () => {
    let ingests = 0;
    let dates = 0;
    const dateTool: AgentTool<any> = { name: "date", label: "Date", description: "Get date", parameters: Type.Object({}), execute: async () => { dates++; return { content: [{ type: "text", text: "today" }], details: {} }; } };
    const ingest: AgentTool<any> = { name: "wiki_ingest", label: "Ingest", description: "Archive", parameters: Type.Object({ url: Type.String() }), execute: async () => { ingests++; return { content: [{ type: "text", text: "saved" }], details: { receipt: { status: "completed", sourceAvailable: true } } }; } };
    faux = createFaux();
    faux.setResponses([fauxAssistantMessage(fauxToolCall("date", {}), { stopReason: "toolUse" }), fauxAssistantMessage("Done.")]);
    const s = await open({ tools: [dateTool, ingest], controller: linkActions({ confidence: 0.8, classify: async (_input, urls) => urls.map((url): LinkIntent => ({ url, intent: "archive", confidence: 0.99 })) }) });
    s.send("summarize https://example.com/a");
    await s.whenIdle();
    expect(ingests).toBe(1);
    expect(dates).toBe(1);
    await s.dispose();
  });

  it("settles two link actions independently and serially", async () => {
    const order: string[] = [];
    const ingest: AgentTool<any> = { name: "wiki_ingest", label: "Ingest", description: "Archive", parameters: Type.Object({ url: Type.String() }), execute: async (_id, rawArgs) => { order.push((rawArgs as { url: string }).url); return { content: [{ type: "text", text: "saved" }], details: { receipt: { status: "completed", sourceAvailable: true } } }; } };
    faux = createFaux();
    faux.setResponses([fauxAssistantMessage("Both links were summarized.")]);
    const s = await open({ tools: [ingest], controller: linkActions({ confidence: 0.8, classify: async (_input, urls) => urls.map((url): LinkIntent => ({ url, intent: "archive", confidence: 0.99 })) }) });
    s.send("summarize https://example.com/a and https://example.com/b");
    await s.whenIdle();
    expect(order).toEqual(["https://example.com/a", "https://example.com/b"]);
    await s.dispose();
  });

  it("reads an explicit no-save link request without archiving", async () => {
    let ingests = 0;
    let reads = 0;
    const ingest: AgentTool<any> = { name: "wiki_ingest", label: "Ingest", description: "Archive", parameters: Type.Object({ url: Type.String() }), execute: async () => { ingests++; return { content: [], details: {} }; } };
    const fetch: AgentTool<any> = { name: "web_fetch", label: "Fetch", description: "Read", parameters: Type.Object({ url: Type.String() }), execute: async (_id, rawArgs) => { reads++; expect((rawArgs as { url: string }).url).toBe("https://example.com/a"); return { content: [{ type: "text", text: "source" }], details: {} }; } };
    faux = createFaux();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("wiki_ingest", { url: "https://example.com/a" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Read without saving."),
    ]);
    const s = await open({ tools: [ingest, fetch], controller: linkActions({ confidence: 0.8, classify: async (_input, urls) => urls.map((url): LinkIntent => ({ url, intent: "read", confidence: 0.99 })) }) });
    s.send("check https://example.com/a and do not save it");
    await s.whenIdle();
    expect(reads).toBe(1);
    expect(ingests).toBe(0);
    await s.dispose();
  });

  it("uses one schema-validated model fallback, and reports uncertain intent as deferred", async () => {
    const url = "https://example.com/a";
    let ingests = 0;
    const ingest: AgentTool<any> = { name: "wiki_ingest", label: "Ingest", description: "Archive", parameters: Type.Object({ url: Type.String() }), execute: async () => { ingests++; return { content: [], details: {} }; } };
    faux = createFaux();
    faux.setResponses([
      fauxAssistantMessage(JSON.stringify({ actions: [{ url, intent: "archive", confidence: 0.99 }] })),
      fauxAssistantMessage("Summary."),
    ]);
    const s = await open({ tools: [ingest], controller: linkActions({ confidence: 0.8, classify: async () => { throw new Error("Jev unavailable"); } }) });
    s.send(`summarize ${url}`);
    await s.whenIdle();
    expect(ingests).toBe(1);
    await s.dispose();

    faux = createFaux();
    faux.setResponses([
      fauxAssistantMessage(JSON.stringify({ actions: [{ url, intent: "archive", confidence: 0.4 }] })),
      fauxAssistantMessage("The link was not archived."),
    ]);
    const uncertain = await open({ tools: [ingest], controller: linkActions({ confidence: 0.8, classify: async () => [] }) });
    uncertain.send(`summarize ${url}`);
    await uncertain.whenIdle();
    expect(ingests).toBe(1);
    expect(events).toContainEqual(expect.objectContaining({ kind: "assistant_message", text: expect.stringContaining("Archival was deferred"), injected: true }));
    await uncertain.dispose();

    faux = createFaux();
    faux.setResponses([
      fauxAssistantMessage(JSON.stringify({ actions: [{ url, intent: "archive", confidence: 0.99 }] }), { stopReason: "length" }),
      fauxAssistantMessage("The partial classification was ignored."),
    ]);
    const partial = await open({ tools: [ingest], controller: linkActions({ confidence: 0.8, classify: async () => { throw new Error("Jev unavailable"); } }) });
    partial.send(`summarize ${url}`);
    await partial.whenIdle();
    expect(ingests).toBe(1);
    expect(events).toContainEqual(expect.objectContaining({ kind: "assistant_message", text: expect.stringContaining("Archival was deferred"), injected: true }));
    await partial.dispose();
  });

  it("does not recreate completed historical link actions when restoring a Session", async () => {
    const url = "https://example.com/restored";
    let ingests = 0;
    const ingest: AgentTool<any> = { name: "wiki_ingest", label: "Ingest", description: "Archive", parameters: Type.Object({ url: Type.String() }), execute: async () => { ingests++; return { content: [], details: { receipt: { status: "completed", sourceAvailable: true } } }; } };
    const controller = linkActions({ confidence: 0.8, classify: async (_input: string, urls: string[]) => urls.map((candidate): LinkIntent => ({ url: candidate, intent: "archive", confidence: 0.99 })) });
    faux = createFaux();
    faux.setResponses([fauxAssistantMessage("Saved.")]);
    const first = await open({ tools: [ingest], controller });
    first.send(`summarize ${url}`);
    await first.whenIdle();
    await first.dispose();

    const callsBeforeRestore = faux.state.callCount;
    const restored = await open({ tools: [ingest], controller });
    await restored.whenIdle();
    expect(ingests).toBe(1);
    expect(faux.state.callCount).toBe(callsBeforeRestore);
    await restored.dispose();
  });

  it("retains the first action while steering adds a second owner request", async () => {
    let ready!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const ingested: string[] = [];
    const ingest: AgentTool<any> = { name: "wiki_ingest", label: "Ingest", description: "Archive", parameters: Type.Object({ url: Type.String() }), execute: async (_id, rawArgs) => { ingested.push((rawArgs as { url: string }).url); return { content: [], details: { receipt: { status: "completed", sourceAvailable: true } } }; } };
    faux = createFaux();
    faux.setResponses([async () => { ready(); await wait; return fauxAssistantMessage("First reply."); }, fauxAssistantMessage("Second reply.")]);
    const s = await open({ tools: [ingest], controller: linkActions({ confidence: 0.8, classify: async (_input, urls) => urls.map((url): LinkIntent => ({ url, intent: "archive", confidence: 0.99 })) }) });
    s.send("summarize https://example.com/a");
    await started;
    s.send("also summarize https://example.com/b");
    release();
    await s.whenIdle();
    expect(ingested).toEqual(["https://example.com/a", "https://example.com/b"]);
    await s.dispose();
  });

  it("lets explicit no-save steering cancel an earlier pending archive", async () => {
    let release!: () => void;
    let classificationStarted!: () => void;
    const started = new Promise<void>((resolve) => { classificationStarted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let ingests = 0;
    let reads = 0;
    const ingest: AgentTool<any> = { name: "wiki_ingest", label: "Ingest", description: "Archive", parameters: Type.Object({ url: Type.String() }), execute: async () => { ingests++; return { content: [], details: {} }; } };
    const fetch: AgentTool<any> = { name: "web_fetch", label: "Fetch", description: "Read", parameters: Type.Object({ url: Type.String() }), execute: async () => { reads++; return { content: [], details: {} }; } };
    faux = createFaux();
    faux.setResponses([fauxAssistantMessage("Read only.")]);
    const classify = async (input: string, urls: string[]): Promise<LinkIntent[]> => {
      if (input.startsWith("please summarize")) { classificationStarted(); await gate; return urls.map((url) => ({ url, intent: "archive" as const, confidence: 0.99 })); }
      return urls.map((url) => ({ url, intent: "read" as const, confidence: 0.99 }));
    };
    const s = await open({ tools: [ingest, fetch], controller: linkActions({ confidence: 0.8, classify }) });
    s.send("please summarize https://example.com/a");
    await started;
    s.send("for https://example.com/a, do not save it; just read");
    release();
    await s.whenIdle();
    expect(ingests).toBe(0);
    expect(reads).toBe(1);
    await s.dispose();
  });

  it("aborts active retrieval on stop and does not run later queued writes", async () => {
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    let writes = 0;
    const ingest: AgentTool<any> = { name: "wiki_ingest", label: "Ingest", description: "Archive", parameters: Type.Object({ url: Type.String() }), execute: async (_id, _args, signal) => {
      started();
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
      signal?.throwIfAborted();
      writes++;
      return { content: [], details: {} };
    } };
    faux = createFaux();
    faux.setResponses([fauxAssistantMessage("unused")]);
    const s = await open({ tools: [ingest], controller: linkActions({ confidence: 0.8, classify: async (_input, urls) => urls.map((url): LinkIntent => ({ url, intent: "archive", confidence: 0.99 })) }) });
    s.send("summarize https://example.com/a");
    await running;
    s.stop();
    await s.whenIdle();
    expect(writes).toBe(0);
    await s.dispose();
  });

  it("does not replay a completed archive after a provider retry", async () => {
    let ingests = 0;
    const ingest: AgentTool<any> = { name: "wiki_ingest", label: "Ingest", description: "Archive", parameters: Type.Object({ url: Type.String() }), execute: async () => { ingests++; return { content: [], details: { receipt: { status: "completed", sourceAvailable: true } } }; } };
    faux = createFaux();
    faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "temporary provider error" }), fauxAssistantMessage("Summary after retry.")]);
    const s = await open({ tools: [ingest], retry: { attempts: 1, baseDelayMs: 1 }, controller: linkActions({ confidence: 0.8, classify: async (_input, urls) => urls.map((url): LinkIntent => ({ url, intent: "archive", confidence: 0.99 })) }) });
    s.send("summarize https://example.com/a");
    await s.whenIdle();
    expect(ingests).toBe(1);
    expect(s.successfulReply).toBe("Summary after retry.");
    await s.dispose();
  });

  it("reports bootstrap-pending receipts as awaiting review", async () => {
    const ingest: AgentTool<any> = { name: "wiki_ingest", label: "Ingest", description: "Archive", parameters: Type.Object({ url: Type.String() }), execute: async () => ({ content: [{ type: "text", text: "awaiting review" }], details: { receipt: { status: "bootstrap-pending", sourceAvailable: false } } }) };
    faux = createFaux();
    faux.setResponses([fauxAssistantMessage("Summary only.")]);
    const s = await open({ tools: [ingest], controller: linkActions({ confidence: 0.8, classify: async (_input, urls) => urls.map((url): LinkIntent => ({ url, intent: "archive", confidence: 0.99 })) }) });
    s.send("summarize https://example.com/a");
    await s.whenIdle();
    expect(events).toContainEqual(expect.objectContaining({ kind: "assistant_message", text: expect.stringContaining("awaiting bootstrap review"), injected: true }));
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

  it("uses pending and raw-only Wiki receipts in the honest fallback", async () => {
    const url = "https://example.test/wiki";
    const run = async (receipt: Record<string, unknown>) => {
      faux = createFaux();
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("wiki_ingest", { url }), { stopReason: "toolUse" }),
        fauxAssistantMessage("It was saved and pushed."),
        fauxAssistantMessage("It was saved and pushed."),
      ]);
      const ingest: AgentTool<any> = { name: "wiki_ingest", label: "Ingest", description: "Archive", parameters: Type.Object({ url: Type.String() }), execute: async () => ({ content: [], details: { receipt } }) };
      const s = await open({ tools: [ingest] });
      s.send(`Save ${url}`);
      await s.whenIdle();
      const reply = s.successfulReply;
      await s.dispose();
      return reply;
    };
    const pending = await run({ version: 1, status: "bootstrap-pending", requestedUrl: url, sourceAvailable: false, rawPath: null, publication: "not-needed", compiledPages: [] });
    expect(pending).toContain("awaiting review");
    expect(pending).not.toContain("pushed");
    events = [];
    const rawOnly = await run({ version: 1, status: "completed", requestedUrl: url, sourceAvailable: true, rawPath: "raw/item.md", publication: "not-needed", compiledPages: [] });
    expect(rawOnly).toContain("source archived");
    expect(rawOnly).not.toContain("compiled");
    expect(rawOnly).not.toContain("published");
  });

  it("does not reuse an older same-URL publication receipt for a pending action", async () => {
    const url = "https://example.test/repeated";
    let runs = 0;
    const ingest: AgentTool<any> = { name: "wiki_ingest", label: "Ingest", description: "Archive", parameters: Type.Object({ url: Type.String() }), execute: async () => ({
      content: [], details: { receipt: runs++ === 0
        ? { version: 1, status: "completed", requestedUrl: url, sourceAvailable: true, rawPath: "raw/item.md", compiledPages: ["wiki/page.md"], publication: "published" }
        : { version: 1, status: "bootstrap-pending", requestedUrl: url, sourceAvailable: false, rawPath: null, compiledPages: [], publication: "not-needed" } },
    }) };
    faux = createFaux();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("wiki_ingest", { url }), { stopReason: "toolUse" }), fauxAssistantMessage("It was pushed."),
      fauxAssistantMessage(fauxToolCall("wiki_ingest", { url }), { stopReason: "toolUse" }), fauxAssistantMessage("It was pushed."), fauxAssistantMessage("It was pushed."),
    ]);
    const s = await open({ tools: [ingest] });
    s.send(`Publish ${url}`);
    await s.whenIdle();
    s.send(`Publish ${url}`);
    await s.whenIdle();
    expect(runs).toBe(2);
    expect(s.successfulReply).toContain("awaiting review");
    expect(s.successfulReply).not.toContain("published");
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
    expect(s.successfulReply).toContain("could not verify");
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

  it("keeps a Wiki receipt in tool results across transcript restoration and provider context", async () => {
    const receipt = { version: 1, requestedUrl: "https://example.com/a", canonicalUrl: "https://example.com/a", sourceAvailable: true, publication: "published" };
    const wiki = {
      status: async () => ({ bootstrap: "done", nextAttemptAt: null, lastBatchId: null }),
      run: async () => ({ batchId: "b1", commit: "c1", pages: ["wiki/a.md"], publication: "published" }),
    } as unknown as Wiki;
    const ingest = createWikiInteractiveTools(wiki, { sourceResolver: async (url) => ({ requestedUrl: url, canonicalUrl: url, title: "A", text: "Original", textKind: "article", truncated: false }) });
    faux = createFaux();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("wiki_ingest", { url: "https://example.com/a" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Saved."),
      (context) => {
        const result = context.messages.find((message) => message.role === "toolResult" && message.toolName === "wiki_ingest") as ToolResultMessage | undefined;
        expect(result?.content.map((part) => part.type === "text" ? part.text : "").join("")).toContain("https://example.com/a");
        return fauxAssistantMessage("Restored receipt.");
      },
    ]);
    const first = await open({ tools: ingest });
    first.send("archive https://example.com/a");
    await first.whenIdle();
    await first.dispose();
    const records = await readJsonl(join(dir, "t.jsonl"));
    expect(JSON.stringify(records)).toContain('"receipt":{"version":1,"status":"completed"');
    expect(JSON.stringify(records)).toContain('"rawPath":"raw/link-');

    const restored = await open({ tools: ingest });
    restored.send("what was archived?");
    await restored.whenIdle();
    expect(restored.successfulReply).toBe("Restored receipt.");
    expect(await readFile(join(dir, "t.jsonl"), "utf8")).toContain('"publication":"published"');
    await restored.dispose();
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
