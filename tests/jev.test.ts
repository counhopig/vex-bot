import { expect, it, vi } from "vitest";
import { Jev } from "../src/providers/jev.js";

it("uses the official typed API and keeps the key out of the payload", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ answers: { next_tool: { type: "choice", choice: "web_fetch", confidence: 0.95 } } }));
  const jev = new Jev({ apiKey: "secret-key" }, request);
  expect(await jev.route({ request: "read this link" }, [{ name: "web_fetch", description: "Read web pages" }])).toEqual({ tool: "web_fetch", confidence: 0.95 });
  const [url, init] = request.mock.calls[0]!;
  expect(url).toBe("https://api.typesafe.ai/v1/systemone");
  expect(init?.headers).toMatchObject({ Authorization: "Bearer secret-key" });
  expect(init?.body).not.toContain("secret-key");
  expect(JSON.parse(init!.body as string)).toMatchObject({ model: "jev-latest", questions: { next_tool: { type: "choice", criteria: { web_fetch: "Read web pages" } } } });
});
it("validates evidence probabilities and rejects invalid responses", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ answers: { unsupported: { type: "noul", noul: 0.96 } } })).mockResolvedValueOnce(Response.json({ answers: { unsupported: { type: "noul", noul: 2 } } }));
  const jev = new Jev({ apiKey: "key" }, request);
  expect(await jev.unsupported({ reply: "failed" })).toBe(0.96);
  await expect(jev.unsupported({})).rejects.toThrow("invalid evidence");
});
it("rejects unknown tools and never exposes API error bodies", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ answers: { next_tool: { type: "choice", choice: "unknown", confidence: 1 } } })).mockResolvedValueOnce(new Response("secret-key", { status: 401 }));
  const jev = new Jev({ apiKey: "secret-key" }, request);
  await expect(jev.route({}, [])).rejects.toThrow("invalid tool route");
  await expect(jev.unsupported({})).rejects.toThrow("TypeSafe evaluation failed");
});
it("cancels a request on owner interruption", async () => {
  const controller = new AbortController();
  const request: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    controller.abort(new Error("owner stopped"));
  });
  await expect(new Jev({ apiKey: "key" }, request).unsupported({}, controller.signal)).rejects.toThrow("owner stopped");
});
it("bounds API calls with a timeout", async () => {
  const request: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(new Error("timed out")), { once: true });
  });
  await expect(new Jev({ apiKey: "key", timeoutMs: 20 }, request).unsupported({})).rejects.toThrow("TypeSafe evaluation failed");
});

it("keeps general tool routing advisory", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ answers: {
    next_tool: { type: "choice", choice: "wiki_ingest", confidence: 0.98 },
  } }));
  const logged = vi.fn();
  const state = { request: "check https://example.com", urls: ["https://example.com"] };
  const result = await new Jev({ apiKey: "secret-key" }, request, logged).route(state, [{ name: "wiki_ingest", description: "Archive source" }]);
  expect(result).toEqual({ tool: "wiki_ingest", confidence: 0.98 });
  const body = JSON.parse(request.mock.calls[0]![1]!.body as string);
  expect(body.questions.archive_shared_links).toBeUndefined();
  expect(JSON.stringify(logged.mock.calls)).not.toContain("secret-key");
  expect(logged).toHaveBeenCalledWith(expect.objectContaining({ question: "next_tool", tool: "wiki_ingest" }));
});

it("classifies each bounded owner URL with a typed intent and ignores untrusted returned URLs", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ answers: {
    link_0: { type: "choice", choice: "archive", confidence: 0.95 },
    link_1: { type: "choice", choice: "read", confidence: 0.9 },
  } }));
  const jev = new Jev({ apiKey: "key" }, request);
  const input = `please check https://one.example and do not save https://two.example ${"x".repeat(5000)}`;
  expect(await jev.classifyLinks(input, ["https://one.example", "https://two.example"])).toEqual([
    { url: "https://one.example", intent: "archive", confidence: 0.95 },
    { url: "https://two.example", intent: "read", confidence: 0.9 },
  ]);
  const body = JSON.parse(request.mock.calls[0]![1]!.body as string);
  expect(body.state.ownerInput).toHaveLength(4000);
  expect(body.state.urls).toEqual(["https://one.example", "https://two.example"]);
  expect(JSON.stringify(body)).not.toContain("secret-key");
});

import { createAssistantMessageEventStream, fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { withEvidenceBoundary } from "../src/context/evidence.js";
import { CONTEXT_BUDGET_ERROR, estimateProviderInput, withContextBudget } from "../src/context/budget.js";
import { createFaux, fauxStreamFn } from "./helpers/faux.js";

it("keeps prospective or negated tool narration and suppresses mixed unsupported claims", async () => {
  const faux = createFaux();
  faux.setResponses([
    fauxAssistantMessage("I'll read https://example.test/a now. It is not published."),
    fauxAssistantMessage("I'll read https://example.test/a now. It was saved and pushed."),
    fauxAssistantMessage("I'll read https://example.test/a now. It was saved and pushed."),
  ]);
  const boundary = withEvidenceBoundary(fauxStreamFn(faux));
  const context = { messages: [{ role: "user" as const, content: "Read https://example.test/a", timestamp: Date.now() }] } as TranscriptContext;
  const first = await boundary(faux.getModel(), context, undefined);
  expect((await first.result()).content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "text", text: expect.stringContaining("I'll read") })]));
  const second = await boundary(faux.getModel(), context, undefined);
  const checked = await second.result();
  expect(checked.content).toHaveLength(1);
  expect(checked.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("could not verify") });
});

it("guards completed Chinese claims even when the request has no English operation keyword", async () => {
  const faux = createFaux();
  faux.setResponses([fauxAssistantMessage("已更新并已运行。"), fauxAssistantMessage("没有可验证的执行回执，无法确认已更新或运行。")]);
  const boundary = withEvidenceBoundary(fauxStreamFn(faux));
  const context = { messages: [{ role: "user" as const, content: "你好", timestamp: Date.now() }] } as TranscriptContext;
  const first = await boundary(faux.getModel(), context, undefined);
  expect((await first.result()).content[0]).toMatchObject({ type: "text", text: expect.stringContaining("could not verify") });
});

it("retains supported pre-tool narration alongside an unexecuted call", async () => {
  const faux = createFaux();
  faux.setResponses([fauxAssistantMessage([{ type: "text", text: "I'll read it now." }, fauxToolCall("web_fetch", { url: "https://example.test/a" })], { stopReason: "toolUse" })]);
  const boundary = withEvidenceBoundary(fauxStreamFn(faux));
  const context = { messages: [{ role: "user" as const, content: "Read https://example.test/a", timestamp: Date.now() }] } as TranscriptContext;
  const stream = await boundary(faux.getModel(), context, undefined);
  const message = await stream.result();
  expect(message.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "text", text: "I'll read it now." }), expect.objectContaining({ type: "toolCall", name: "web_fetch" })]));
});

it("removes partial prose from provider error and abort results", async () => {
  const faux = createFaux();
  faux.setResponses([
    fauxAssistantMessage("Saved and pushed before failure.", { stopReason: "error", errorMessage: "partial saved claim" }),
    fauxAssistantMessage("Saved and pushed before cancellation.", { stopReason: "aborted", errorMessage: "partial aborted claim" }),
  ]);
  const boundary = withEvidenceBoundary(fauxStreamFn(faux));
  const context = { messages: [{ role: "user" as const, content: "Save https://example.test/a", timestamp: Date.now() }] } as TranscriptContext;
  const errors: string[] = [];
  for (let index = 0; index < 2; index++) {
    const guarded = await boundary(faux.getModel(), context, undefined);
    const message = await guarded.result();
    errors.push(JSON.stringify(message));
  }
  expect(errors.join(" ")).not.toContain("Saved and pushed");
  expect(errors.join(" ")).not.toContain("partial saved claim");
  expect(errors.join(" ")).not.toContain("partial aborted claim");
});

it("rejects a routed request when the added routing instruction exhausts its budget", async () => {
  const faux = createFaux();
  const provider = vi.fn(fauxStreamFn(faux));
  const context = { messages: [{ role: "user" as const, content: "Use the available tool for this request.", timestamp: 1 }] } as TranscriptContext;
  const base = estimateProviderInput(context);
  const model = { ...faux.getModel(), contextWindow: base + 101, maxTokens: 100 };
  const boundary = withEvidenceBoundary(withContextBudget(provider), {
    judge: { route: async () => ({ tool: "echo", confidence: 0.99 }), unsupported: async () => 0 }, tools: () => [],
  });
  await expect(boundary(model, context, undefined)).rejects.toMatchObject({ code: "VEX_CONTEXT_BUDGET" });
  expect(provider).not.toHaveBeenCalled();
});

it("checks the corrective request again and does not restart an oversized correction", async () => {
  const faux = createFaux();
  faux.setResponses([fauxAssistantMessage("I saved it.")]);
  const provider = vi.fn(fauxStreamFn(faux));
  const context = { messages: [{ role: "user" as const, content: "Please handle this request.", timestamp: 1 }] } as TranscriptContext;
  const base = estimateProviderInput(context);
  const model = { ...faux.getModel(), contextWindow: base + 120, maxTokens: 100 };
  const boundary = withEvidenceBoundary(withContextBudget(provider), {
    judge: { route: async () => ({ tool: null, confidence: 0 }), unsupported: async () => 1 }, tools: () => [],
  });
  const result = await boundary(model, context, undefined);
  expect(provider).toHaveBeenCalledTimes(1);
  const message = await result.result();
  expect(message.stopReason).toBe("error");
  expect(message.errorMessage).toBe(CONTEXT_BUDGET_ERROR);
  expect(message.usage.input).toBeGreaterThan(0);
  expect(message.usage).toMatchObject({ output: 3, totalTokens: message.usage.input + 3 });
});

it("preserves only the canonical local budget marker through error sanitization", async () => {
  const faux = createFaux();
  faux.setResponses([
    fauxAssistantMessage("", { stopReason: "error", errorMessage: CONTEXT_BUDGET_ERROR }),
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider secret detail" }),
  ]);
  const boundary = withEvidenceBoundary(fauxStreamFn(faux));
  const context = { messages: [{ role: "user" as const, content: "hello", timestamp: 1 }] } as TranscriptContext;
  const local = await boundary(faux.getModel(), context, undefined);
  expect((await local.result()).errorMessage).toBe(CONTEXT_BUDGET_ERROR);
  const providerError = await boundary(faux.getModel(), context, undefined);
  expect((await providerError.result()).errorMessage).toBe("Provider generation failed before a checked reply was available.");
});

it("includes rejected and corrective provider usage in the checked fallback", async () => {
  const messages = [1, 2].map((output) => ({ ...fauxAssistantMessage("Saved."), usage: { input: output, output, cacheRead: 0, cacheWrite: 0, totalTokens: output * 2, cost: { input: output, output, cacheRead: 0, cacheWrite: 0, total: output * 2 } } }));
  let calls = 0;
  const streamFn = async () => {
    const message = messages[calls++]!;
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
    return stream;
  };
  const guarded = await withEvidenceBoundary(streamFn as never, { confidence: 0.8 });
  const context = { messages: [{ role: "user" as const, content: "Save https://example.test/a", timestamp: Date.now() }] } as TranscriptContext;
  const output = await guarded({} as never, context, undefined);
  const message = await output.result();
  expect(calls).toBe(2);
  expect(message.content).toMatchObject([{ type: "text", text: expect.stringContaining("could not verify") }]);
  expect(message.usage).toMatchObject({ input: 3, output: 3, totalTokens: 6, cost: { total: 6 } });
});

it("does not use a prior turn's receipt to support a new operation claim", async () => {
  const faux = createFaux();
  faux.setResponses([fauxAssistantMessage("Saved and pushed."), fauxAssistantMessage("Saved and pushed.")]);
  const evidence = vi.fn(async () => 0);
  const oldCall = fauxToolCall("wiki_ingest", { url: "https://example.test/old" }, { id: "old-call" });
  const priorReceipt = { version: 1, status: "completed", requestedUrl: "https://example.test/old", sourceAvailable: true, rawPath: "raw/old.md", publication: "published" };
  const context = { messages: [
    { role: "user" as const, content: "Archive https://example.test/old", timestamp: 1 },
    fauxAssistantMessage(oldCall, { stopReason: "toolUse" }),
    { role: "toolResult" as const, toolCallId: "old-call", toolName: "wiki_ingest", content: [{ type: "text" as const, text: JSON.stringify(priorReceipt) }], details: { receipt: priorReceipt }, isError: false, timestamp: 2 },
    { role: "user" as const, content: "Archive https://example.test/new", timestamp: 3 },
  ] } as TranscriptContext;
  const boundary = withEvidenceBoundary(fauxStreamFn(faux), { judge: { route: async () => ({ tool: null, confidence: 0 }), unsupported: evidence }, tools: () => [] });
  const output = await boundary(faux.getModel(), context, undefined);
  expect((await output.result()).content[0]).toMatchObject({ type: "text", text: expect.stringContaining("could not verify") });
  expect(JSON.stringify(evidence.mock.calls)).not.toContain("old-call");
  expect(JSON.stringify(evidence.mock.calls)).not.toContain("example.test/old");
});

it("returns consumed classification usage when routing rejects before the main provider call", async () => {
  const faux = createFaux();
  const provider = vi.fn(fauxStreamFn(faux));
  const usage = { input: 7, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 9, cost: { input: 7, output: 2, cacheRead: 0, cacheWrite: 0, total: 9 } };
  let returned = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const context = { messages: [{ role: "user" as const, content: "Archive https://example.test/new", timestamp: 1 }] } as TranscriptContext;
  const base = estimateProviderInput(context);
  const model = { ...faux.getModel(), contextWindow: base + 100, maxTokens: 99 };
  const boundary = withEvidenceBoundary(withContextBudget(provider), { takeUsage: () => usage, returnUsage: (value) => { returned = value; }, judge: { route: async () => ({ tool: "wiki_ingest", confidence: 0.99 }), unsupported: async () => 0 }, tools: () => [] });
  await expect(boundary(model, context, undefined)).rejects.toMatchObject({ code: "VEX_CONTEXT_BUDGET" });
  expect(provider).not.toHaveBeenCalled();
  expect(returned).toMatchObject({ input: 7, output: 2, totalTokens: 9, cost: { total: 9 } });
});
