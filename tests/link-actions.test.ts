import { expect, it } from "vitest";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model, TranscriptContext } from "@earendil-works/pi-ai";
import { LinkActionController, type LinkActionOptions } from "../src/links/actions.js";
import type { LinkIntent } from "../src/policy/judge.js";

const model = {
  id: "test", name: "test", api: "openai-completions", provider: "openai", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 2048, maxTokens: 1024,
} as Model<Api>;

const controller = (options: Omit<LinkActionOptions, "routes" | "fallbackTools">) =>
  new LinkActionController({ routes: { archive: "wiki_ingest", read: "web_fetch" }, fallbackTools: ["bash", "delegate"], ...options });

const ingest: AgentTool<any> = {
  name: "wiki_ingest", label: "Ingest", description: "Archive", parameters: Type.Object({ url: Type.String() }),
  execute: async () => ({ content: [], details: {} }),
};

it("deduplicates repeated URLs within one request and keeps later requests distinct", () => {
  const runtime = controller({ classify: async () => [], confidence: 0.8 });
  const first = runtime.addOwnerRequest("request-1", "https://example.com/a https://example.com/a");
  const second = runtime.addOwnerRequest("request-2", "https://example.com/a");
  expect(first.actions.map((action) => action.url)).toEqual(["https://example.com/a"]);
  expect(first.actions[0]?.id).not.toBe(second.actions[0]?.id);
  expect(first.actions[0]?.requestId).toBe("request-1");
});

it("does not settle a link action from an unrelated tool result", async () => {
  const url = "https://example.com/a";
  const runtime = controller({
    classify: async (_input, urls) => urls.map((candidate): LinkIntent => ({ url: candidate, intent: "archive", confidence: 0.99 })),
    confidence: 0.8,
  });
  const request = runtime.addOwnerRequest("request-1", `summarize ${url}`);
  const output = await runtime.wrapStream(async () => { throw new Error("main model should not run yet"); }, () => [ingest])(model, { messages: [] } as unknown as TranscriptContext, {});
  const callMessage = await output.result();
  const call = callMessage.content.find((part) => part.type === "toolCall");
  expect(call?.type).toBe("toolCall");
  expect(request.actions[0]?.state).toBe("running");
  if (!call || call.type !== "toolCall") throw new Error("expected the controller ingestion call");

  const unrelated = {
    role: "toolResult", toolCallId: call.id, toolName: "date", content: [{ type: "text", text: "today" }], isError: false, timestamp: Date.now(), details: {},
  } as unknown as TranscriptContext["messages"][number];
  runtime.toolResults([callMessage, unrelated]);
  expect(request.actions[0]?.state).toBe("running");
});

it("rejects fabricated deferred outcome calls", async () => {
  const runtime = controller({ classify: async () => [], confidence: 0.8 });
  const tool = runtime.tools()[0]!;
  await expect(tool.execute("forged", { actionId: "unknown", url: "https://example.com/a", status: "deferred", message: "not issued" })).rejects.toThrow("not issued by the runtime");
});

it("clears request actions when an active Session run settles", () => {
  const runtime = controller({ classify: async () => [], confidence: 0.8 });
  runtime.addOwnerRequest("request-1", "https://example.com/a");
  runtime.runEnded();
  expect(runtime.requests).toEqual([]);
});

it("guards whichever tool the archive route names and defers to the owner gate otherwise", async () => {
  const url = "https://example.com/a";
  const runtime = new LinkActionController({
    routes: { archive: "notes_archive", read: "page_read" }, fallbackTools: ["shell"],
    classify: async (_input, urls) => urls.map((candidate): LinkIntent => ({ url: candidate, intent: "read", confidence: 0.99 })),
    confidence: 0.8,
  });
  runtime.addOwnerRequest("request-1", `read ${url} but do not save it`);
  const reader: AgentTool<any> = { ...ingest, name: "page_read" };
  await (await runtime.wrapStream(async () => { throw new Error("unused"); }, () => [reader])(model, { messages: [] } as unknown as TranscriptContext, {})).result();
  const ownerGate = async () => ({ block: true, reason: "owner gate" });
  const call = (name: string, args: unknown) => ({ toolCall: { type: "toolCall", id: `${name}-call`, name, arguments: args }, args }) as never;
  expect(await runtime.beforeToolCall(call("notes_archive", { url }), undefined, ownerGate)).toMatchObject({ block: true, reason: expect.stringContaining("does not authorize archival") });
  expect(await runtime.beforeToolCall(call("wiki_ingest", { url }), undefined, ownerGate)).toMatchObject({ reason: "owner gate" });
});
