/**
 * Cron executor tests — systemEvent is a no-op, agentTurn dispatches
 * via the injected dispatcher (no direct Agent import).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { CronJob, CronExecutionResult } from "../src/cron/types.js";
import type { DispatchOutboundMessage } from "../src/dispatcher/Dispatcher.js";
import type { InboundMessageContext } from "../src/channels/ChannelAdapter.js";

function makeJob(payload: CronJob["payload"], ownerId?: string): CronJob {
  return {
    id: "test-job",
    name: "test-job",
    enabled: true,
    schedule: { kind: "at", atMs: 1000 },
    payload,
    createdAtMs: 1,
    updatedAtMs: 1,
    state: {},
    ownerId,
  };
}

describe("createCronExecutor", () => {
  let createCronExecutor: typeof import("../src/cron/executor.js").createCronExecutor;
  let defaultDispatcher:
    | ((ctx: InboundMessageContext) => Promise<DispatchOutboundMessage | void>);

  beforeAll(async () => {
    ({ createCronExecutor } = await import("../src/cron/executor.js"));
  });

  beforeEach(() => {
    defaultDispatcher = vi.fn(async () => undefined);
  });

  it("systemEvent returns ok without dispatching", async () => {
    const exec = createCronExecutor({ dispatch: defaultDispatcher });
    const result: CronExecutionResult = await exec.executeJob(
      makeJob({ kind: "systemEvent", message: "tick" }),
    );
    expect(result.status).toBe("ok");
    expect(defaultDispatcher).not.toHaveBeenCalled();
  });

  it("agentTurn dispatches via the injected dispatcher", async () => {
    const exec = createCronExecutor({ dispatch: defaultDispatcher });
    const result = await exec.executeJob(
      makeJob({ kind: "agentTurn", message: "hello" }),
    );
    expect(result.status).toBe("ok");
    expect(defaultDispatcher).toHaveBeenCalledTimes(1);
  });

  it("agentTurn passes ownerId as webUserId on the synthetic message", async () => {
    const calls: InboundMessageContext[] = [];
    const trackingDispatcher = vi.fn(async (ctx: InboundMessageContext) => {
      calls.push(ctx);
    });
    const exec = createCronExecutor({ dispatch: trackingDispatcher });
    await exec.executeJob(
      makeJob({ kind: "agentTurn", message: "hi" }, "user-42"),
    );
    expect(calls[0]?.webUserId).toBe("user-42");
    expect(calls[0]?.senderId).toBe("cron-system");
    expect(calls[0]?.channelId).toBe("webchat");
    expect(calls[0]?.content).toBe("hi");
  });

  it("agentTurn without ownerId falls back to senderId-derived userId", async () => {
    const calls: InboundMessageContext[] = [];
    const exec = createCronExecutor({
      dispatch: vi.fn(async (ctx) => {
        calls.push(ctx);
      }) as any,
    });
    await exec.executeJob(
      makeJob({ kind: "agentTurn", message: "no owner" }),
    );
    // No ownerId set — dispatcher will resolve userId from senderId
    // via Dispatcher.resolveUserId (senderId here is "cron-system").
    expect(calls[0]?.webUserId).toBeUndefined();
    expect(calls[0]?.senderId).toBe("cron-system");
  });

  it("returns error status when dispatcher throws", async () => {
    const failingDispatcher = vi.fn(async () => {
      throw new Error("dispatch failed");
    });
    const exec = createCronExecutor({ dispatch: failingDispatcher as any });
    const result = await exec.executeJob(
      makeJob({ kind: "agentTurn", message: "boom" }),
    );
    expect(result.status).toBe("error");
    expect(result.error).toBe("dispatch failed");
  });
});