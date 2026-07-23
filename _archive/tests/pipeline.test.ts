import { describe, it, expect, vi, afterEach } from "vitest";
import { registerMessageInterceptor, runMessageInterceptors, clearPipeline } from "../src/pipeline/index.js";
import type { InboundMessageContext } from "../src/types/index.js";

vi.mock("../src/utils/logger.js", () => ({
  getChildLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

function ctx(): InboundMessageContext {
  return {
    channelId: "webchat",
    chatId: "chat",
    chatType: "private",
    senderId: "sender",
    messageId: "msg",
    content: "hi",
  } as InboundMessageContext;
}

describe("pipeline message interceptor timeout", () => {
  afterEach(() => {
    clearPipeline();
    vi.useRealTimers();
  });

  it("does not hang on an interceptor that never resolves", async () => {
    vi.useFakeTimers();
    registerMessageInterceptor("hang", () => new Promise<null>(() => {}));

    let settled = false;
    const p = runMessageInterceptors(ctx()).then((r) => {
      settled = true;
      return r;
    });

    await vi.advanceTimersByTimeAsync(30_000);
    const result = await p;

    expect(settled).toBe(true);
    // A timed-out interceptor is treated as "passed" so the message continues.
    expect(result).toBeNull();
  });

  it("still returns a fast interceptor's short-circuit result", async () => {
    registerMessageInterceptor("fast", async () => "handled");
    const result = await runMessageInterceptors(ctx());
    expect(result).toBe("handled");
  });
});
