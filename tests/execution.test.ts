import { expect, it } from "vitest";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model, TranscriptContext } from "@earendil-works/pi-ai";
import { RequestActionOrchestrator } from "../src/core/execution.js";
import type { LinkIntent } from "../src/policy/judge.js";

const model = {
  id: "test", name: "test", api: "openai-completions", provider: "openai", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 2048, maxTokens: 1024,
} as Model<Api>;

const ingest: AgentTool<any> = {
  name: "wiki_ingest", label: "Ingest", description: "Archive", parameters: Type.Object({ url: Type.String() }),
  execute: async () => ({ content: [], details: {} }),
};

it("deduplicates repeated URLs within one request and keeps later requests distinct", () => {
  const runtime = new RequestActionOrchestrator({ classify: async () => [], confidence: 0.8 });
  const first = runtime.addOwnerRequest("request-1", "https://example.com/a https://example.com/a");
  const second = runtime.addOwnerRequest("request-2", "https://example.com/a");
  expect(first.actions.map((action) => action.url)).toEqual(["https://example.com/a"]);
  expect(first.actions[0]?.id).not.toBe(second.actions[0]?.id);
  expect(first.actions[0]?.requestId).toBe("request-1");
});

it("does not settle a link action from an unrelated tool result", async () => {
  const url = "https://example.com/a";
  const runtime = new RequestActionOrchestrator({
    classify: async (_input, urls) => urls.map((candidate): LinkIntent => ({ url: candidate, intent: "archive", confidence: 0.99 })),
    confidence: 0.8,
  });
  const request = runtime.addOwnerRequest("request-1", `summarize ${url}`);
  const output = await runtime.wrap(async () => { throw new Error("main model should not run yet"); }, () => [ingest])(model, { messages: [] } as unknown as TranscriptContext, {});
  const callMessage = await output.result();
  const call = callMessage.content.find((part) => part.type === "toolCall");
  expect(call?.type).toBe("toolCall");
  expect(request.actions[0]?.state).toBe("running");
  if (!call || call.type !== "toolCall") throw new Error("expected the controller ingestion call");

  const unrelated = {
    role: "toolResult", toolCallId: call.id, toolName: "date", content: [{ type: "text", text: "today" }], isError: false, timestamp: Date.now(), details: {},
  } as unknown as TranscriptContext["messages"][number];
  runtime.settle([callMessage, unrelated]);
  expect(request.actions[0]?.state).toBe("running");
});

it("rejects fabricated deferred outcome calls", async () => {
  const runtime = new RequestActionOrchestrator({ classify: async () => [], confidence: 0.8 });
  const tool = runtime.outcomeTool();
  await expect(tool.execute("forged", { actionId: "unknown", url: "https://example.com/a", status: "deferred", message: "not issued" })).rejects.toThrow("not issued by the runtime");
});

it("clears request actions when an active Session run settles", () => {
  const runtime = new RequestActionOrchestrator({ classify: async () => [], confidence: 0.8 });
  runtime.addOwnerRequest("request-1", "https://example.com/a");
  runtime.finishRun();
  expect(runtime.requests).toEqual([]);
});
