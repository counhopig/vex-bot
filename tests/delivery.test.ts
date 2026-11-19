import { describe, expect, it, vi } from "vitest";
import { createOwnerDelivery } from "../src/core/delivery.js";
import type { Session } from "../src/core/session.js";

function fakeSession(): Session {
  return {
    enqueueAssistant: vi.fn().mockResolvedValue(undefined),
    injectAssistant: vi.fn().mockResolvedValue(undefined),
  } as unknown as Session;
}

describe("createOwnerDelivery", () => {
  it("queues a runtime notice on the WeChat session", async () => {
    const session = fakeSession();
    const delivery = createOwnerDelivery({ wechatSession: async () => session });
    await delivery.notify("wiki: run failed");
    expect(session.enqueueAssistant).toHaveBeenCalledWith("wiki: run failed");
  });

  it("injects into the idle transcript with the caller's signal", async () => {
    const session = fakeSession();
    const signal = new AbortController().signal;
    const delivery = createOwnerDelivery({ wechatSession: async () => session });
    await delivery.inject("heartbeat result", signal);
    expect(session.injectAssistant).toHaveBeenCalledWith("heartbeat result", signal);
  });

  it("injects without a signal when the caller passes none", async () => {
    const session = fakeSession();
    const delivery = createOwnerDelivery({ wechatSession: async () => session });
    await delivery.inject("watchdog report");
    expect(session.injectAssistant).toHaveBeenCalledWith("watchdog report", undefined);
  });

  it("propagates session resolution failures to the caller", async () => {
    const delivery = createOwnerDelivery({ wechatSession: async () => { throw new Error("wechat unavailable"); } });
    await expect(delivery.notify("text")).rejects.toThrow("wechat unavailable");
  });
});
