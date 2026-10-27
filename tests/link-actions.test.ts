import { expect, it } from "vitest";
import { Type } from "typebox";
import type { AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, fauxAssistantMessage, type Api, type Model, type ToolResultMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { LinkActionController, type LinkActionOptions } from "../src/links/actions.js";
import type { LinkIntent } from "../src/links/intent.js";

const model = {
  id: "test", name: "test", api: "openai-completions", provider: "openai", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 2048, maxTokens: 1024,
} as Model<Api>;

const controller = (options: Partial<Omit<LinkActionOptions, "routes">> = {}) =>
  new LinkActionController({ routes: { archive: "wiki_ingest", read: "web_fetch" }, confidence: 0.8, ...options });

const tool = (name: string): AgentTool<any> => ({
  name, label: name, description: name, parameters: Type.Object({ url: Type.String() }),
  execute: async () => ({ content: [], details: {} }),
});
const intents = (intent: LinkIntent["intent"]) => async (_input: string, urls: string[]) => urls.map((url): LinkIntent => ({ url, intent, confidence: 0.99 }));
const empty = { messages: [] } as unknown as TranscriptContext;
const unused: StreamFn = async () => { throw new Error("the model should not run yet"); };
const reply = (text: string): StreamFn => async () => {
  const message = fauxAssistantMessage(text);
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "done", reason: "stop", message });
  stream.end(message);
  return stream;
};
const result = (toolCallId: string, toolName: string, extra: Partial<ToolResultMessage> = {}) =>
  ({ role: "toolResult", toolCallId, toolName, content: [{ type: "text", text: "ok" }], isError: false, timestamp: 1, details: {}, ...extra }) as ToolResultMessage;
const gateCall = (name: string, args: unknown) => ({ toolCall: { type: "toolCall", id: `${name}-call`, name, arguments: args }, args }) as never;
const ownerGate = async () => ({ block: true, reason: "owner gate" });

it("deduplicates repeated URLs and ends a link where CJK text follows it", () => {
  const runtime = controller();
  expect(runtime.addOwnerRequest("1", "https://example.com/a https://example.com/a").actions.map((action) => action.url)).toEqual(["https://example.com/a"]);
  expect(runtime.addOwnerRequest("2", "https://mp.weixin.qq.com/s/abc帮我存一下，还有https://b.example/x（看看）").actions.map((action) => action.url))
    .toEqual(["https://mp.weixin.qq.com/s/abc", "https://b.example/x"]);
});

it("runs a classified archive as the turn's first step and settles it only from its own result", async () => {
  const runtime = controller({ classify: intents("archive") });
  const request = runtime.addOwnerRequest("1", "save https://example.com/a");
  const first = await (await runtime.wrapStream(unused, () => [tool("wiki_ingest")])(model, empty, {})).result();
  const call = first.content.find((part) => part.type === "toolCall");
  if (!call || call.type !== "toolCall") throw new Error("expected the runtime archive call");
  expect(call).toMatchObject({ name: "wiki_ingest", arguments: { url: "https://example.com/a" } });
  runtime.toolResults([first, result(call.id, "date")]);
  expect(request.actions[0]?.state).toBe("running");
  runtime.toolResults([first, result(call.id, "wiki_ingest")]);
  expect(request.actions[0]?.state).toBe("done");
  // With the action done, the model writes the reply.
  expect((await (await runtime.wrapStream(reply("archived"), () => [tool("wiki_ingest")])(model, empty, {})).result()).content).toMatchObject([{ text: "archived" }]);
});

it("leaves a link to the model when no confident intent is available", async () => {
  const runtime = controller({ classify: async () => { throw new Error("Jev offline"); } });
  const request = runtime.addOwnerRequest("1", "what about https://example.com/a");
  // The model-side classification answers with prose, so nothing is confirmed.
  const output = await runtime.wrapStream(reply("archived"), () => [tool("wiki_ingest")], reply("not json"))(model, empty, {});
  expect((await output.result()).content).toMatchObject([{ text: "archived" }]);
  expect(request.actions[0]).toMatchObject({ intent: "defer", confirmed: false, state: "cancelled" });
  expect(await runtime.beforeToolCall(gateCall("wiki_ingest", { url: "https://example.com/a" }), undefined, ownerGate)).toMatchObject({ reason: "owner gate" });
});

it("refuses a model archive the owner declined and passes other calls to the owner gate", async () => {
  const runtime = new LinkActionController({ routes: { archive: "notes_archive", read: "page_read" }, confidence: 0.8, classify: intents("read") });
  runtime.addOwnerRequest("1", "read https://example.com/a but do not save it");
  await (await runtime.wrapStream(unused, () => [tool("page_read")])(model, empty, {})).result();
  expect(await runtime.beforeToolCall(gateCall("notes_archive", { url: "https://example.com/a" }), undefined, ownerGate)).toMatchObject({ block: true, reason: expect.stringContaining("not to archive") });
  expect(await runtime.beforeToolCall(gateCall("wiki_ingest", { url: "https://example.com/a" }), undefined, ownerGate)).toMatchObject({ reason: "owner gate" });
});

it("tells the owner only what no wiki run reports: a refusal or an archive that never ran", async () => {
  const notices: string[] = [];
  const settle = async (extra: Partial<ToolResultMessage>) => {
    const runtime = controller({ classify: intents("archive"), onOutcome: async (message) => { notices.push(message); } });
    runtime.addOwnerRequest("1", "save https://example.com/a");
    const first = await (await runtime.wrapStream(unused, () => [tool("wiki_ingest")])(model, empty, {})).result();
    const call = first.content.find((part) => part.type === "toolCall");
    if (!call || call.type !== "toolCall") throw new Error("expected the runtime archive call");
    runtime.toolResults([first, result(call.id, "wiki_ingest", extra)]);
  };
  await settle({ details: { receipt: { status: "completed", sourceAvailable: true } } });
  expect(notices).toEqual([]);
  await settle({ details: { receipt: { status: "bootstrap-pending" } } });
  await settle({ isError: true, content: [{ type: "text", text: "The tool wiki_ingest is disabled." }] });
  expect(notices).toEqual([
    "Archival is awaiting bootstrap review for https://example.com/a.",
    "The archive action for https://example.com/a did not run: The tool wiki_ingest is disabled.",
  ]);
});

it("tells a model retrying a refused archive that it failed, not that it succeeded", async () => {
  const outcome = async (extra: Partial<ToolResultMessage>) => {
    const runtime = controller({ classify: intents("archive") });
    runtime.addOwnerRequest("1", "save https://example.com/a");
    const first = await (await runtime.wrapStream(unused, () => [tool("wiki_ingest")])(model, empty, {})).result();
    const call = first.content.find((part) => part.type === "toolCall");
    if (!call || call.type !== "toolCall") throw new Error("expected the runtime archive call");
    runtime.toolResults([first, result(call.id, "wiki_ingest", extra)]);
    return runtime.beforeToolCall(gateCall("wiki_ingest", { url: "https://example.com/a" }), undefined, ownerGate);
  };
  expect(await outcome({ isError: true, content: [{ type: "text", text: "The owner denied this wiki_ingest call." }] }))
    .toMatchObject({ block: true, reason: expect.stringContaining("refused or failed") });
  expect(await outcome({ details: { receipt: { status: "failed-read" } } })).toMatchObject({ reason: expect.stringContaining("refused or failed") });
  expect(await outcome({ details: { receipt: { status: "completed", sourceAvailable: true } } })).toMatchObject({ reason: expect.stringContaining("already archived") });
});

it("clears request actions when the run settles, keeping queued requests", () => {
  const runtime = controller();
  runtime.addOwnerRequest("1", "https://example.com/a");
  runtime.addOwnerRequest("2", "https://example.com/b");
  runtime.runEnded(new Set(["2"]));
  expect(runtime.requests.map((request) => request.id)).toEqual(["2"]);
});
