/**
 * Pipeline tests — per-Agent interceptors, observers, prompt injectors.
 *
 * Architecture doc (§8): The Pipeline is NOT process-global. Each Agent
 * has its own Pipeline instance.
 */

import { describe, it, expect, vi } from "vitest";
import { Pipeline } from "../src/agent/Pipeline.js";
import type { InboundMessageContext } from "../src/channels/ChannelAdapter.js";

function mockCtx(): InboundMessageContext {
  return {
    channelId: "webchat",
    messageId: "m1",
    chatId: "c1",
    chatType: "direct",
    senderId: "u1",
    content: "hello",
    timestamp: 1000,
  };
}

describe("Pipeline", () => {
  // -- interceptors --------------------------------------------------------

  it("interceptor returns null -> no short-circuit", async () => {
    const p = new Pipeline();
    p.registerInterceptor(async () => null);
    expect(await p.runInterceptors(mockCtx())).toBeNull();
  });

  it("interceptor returns string -> short-circuit with that string", async () => {
    const p = new Pipeline();
    p.registerInterceptor(async () => "blocked");
    expect(await p.runInterceptors(mockCtx())).toBe("blocked");
  });

  it("first interceptor that returns a string wins", async () => {
    const p = new Pipeline();
    p.registerInterceptor(async () => null);
    p.registerInterceptor(async () => "short-circuit");
    p.registerInterceptor(async () => "never-reached");
    expect(await p.runInterceptors(mockCtx())).toBe("short-circuit");
  });

  // -- observers -----------------------------------------------------------

  it("all observers are called after processing", async () => {
    const p = new Pipeline();
    const fn1 = vi.fn().mockResolvedValue(undefined);
    const fn2 = vi.fn().mockResolvedValue(undefined);
    p.registerObserver(fn1);
    p.registerObserver(fn2);

    const ctx = mockCtx();
    await p.runObservers(ctx, "reply text");

    expect(fn1).toHaveBeenCalledWith(ctx, "reply text");
    expect(fn2).toHaveBeenCalledWith(ctx, "reply text");
  });

  it("observer errors do not prevent other observers from running", async () => {
    const p = new Pipeline();
    const fn1 = vi.fn().mockRejectedValue(new Error("oops"));
    const fn2 = vi.fn().mockResolvedValue(undefined);
    p.registerObserver(fn1);
    p.registerObserver(fn2);

    await p.runObservers(mockCtx(), "text");

    expect(fn2).toHaveBeenCalled();
  });

  // -- prompt injectors ----------------------------------------------------

  it("gatherPromptInjections collects all injection texts", async () => {
    const p = new Pipeline();
    p.registerPromptInjector(async () => "Injection A");
    p.registerPromptInjector(async () => "Injection B");

    const injections = await p.gatherPromptInjections(mockCtx());
    expect(injections).toEqual(["Injection A", "Injection B"]);
  });

  it("returns empty array when no injectors registered", async () => {
    const p = new Pipeline();
    expect(await p.gatherPromptInjections(mockCtx())).toEqual([]);
  });
});
