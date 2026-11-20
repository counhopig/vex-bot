import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { attachTranscriptMeta, isNotice, noticeAssistantMessage, transcriptMeta, withRun } from "../src/core/transcript.js";

const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function userMessage(text: string): UserMessage {
  return { role: "user", content: text, timestamp: 1 };
}

describe("transcript metadata boundary", () => {
  it("round-trips attached source and request id", () => {
    const message = attachTranscriptMeta(userMessage("hello"), { source: "heartbeat", requestId: "r1" });
    expect(transcriptMeta(message)).toEqual({ source: "heartbeat", requestId: "r1" });
    expect(transcriptMeta(userMessage("plain"))).toEqual({});
  });

  it("attaches nothing when the meta is empty", () => {
    const message = attachTranscriptMeta(userMessage("hello"), {});
    expect(message).toEqual({ role: "user", content: "hello", timestamp: 1 });
  });

  it("marks and recognizes a runtime notice", () => {
    const notice = noticeAssistantMessage("Working on it", { api: "openai-completions", provider: "p", id: "m" });
    expect(isNotice(notice)).toBe(true);
    expect((notice as AssistantMessage).stopReason).toBe("stop");
    expect(isNotice({ role: "assistant", content: [{ type: "text", text: "x" }], api: "openai-completions", provider: "p", model: "m", usage: zeroUsage, stopReason: "stop", timestamp: 1 } as unknown as AgentMessage)).toBe(false);
  });

  it("stamps a run id and reads it back", () => {
    const message = withRun(userMessage("hello"), "run-1");
    expect(transcriptMeta(message).run).toBe("run-1");
    expect(withRun(userMessage("hello"), undefined)).toEqual(userMessage("hello"));
  });
});
