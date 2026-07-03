import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Agent } from "../src/agents/agent.js";
import type { VexConfig } from "../src/types/index.js";

const createAgentMock = vi.hoisted(() => vi.fn());
const createMemoryManagerMock = vi.hoisted(() => vi.fn());

vi.mock("../src/agents/agent.js", () => ({
  createAgent: createAgentMock,
}));

vi.mock("../src/memory/index.js", () => ({
  createMemoryManager: createMemoryManagerMock,
}));

vi.mock("../src/utils/logger.js", () => ({
  getChildLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { UserRuntimeManager } from "../src/agents/user-runtime.js";

function config(webAuthEnabled: boolean): VexConfig {
  return {
    providers: {},
    channels: {},
    agent: { defaultModel: "deepseek-chat", defaultProvider: "deepseek" },
    server: { port: 3000 },
    logging: { level: "info" },
    sessions: { type: "file", directory: "/tmp/vex-sessions" },
    memory: { enabled: true, directory: "/tmp/vex-memory" },
    webAuth: { enabled: webAuthEnabled },
  };
}

function agent(id: string): Agent {
  return {
    id,
    shutdown: vi.fn(),
  } as unknown as Agent;
}

describe("UserRuntimeManager", () => {
  beforeEach(() => {
    createAgentMock.mockReset();
    createMemoryManagerMock.mockReset();
  });

  it("returns the legacy agent when web auth is disabled", async () => {
    const legacyAgent = agent("legacy");
    const manager = new UserRuntimeManager({
      config: config(false),
      globalAgent: legacyAgent,
    });

    const resolved = await manager.getAgent("user-a");

    expect(resolved).toBe(legacyAgent);
    expect(createAgentMock).not.toHaveBeenCalled();
  });

  it("creates one scoped agent per authenticated user", async () => {
    const firstAgent = agent("user-a-agent");
    const secondAgent = agent("user-b-agent");
    createAgentMock.mockResolvedValueOnce(firstAgent).mockResolvedValueOnce(secondAgent);
    createMemoryManagerMock.mockReturnValue({ close: vi.fn() });
    const manager = new UserRuntimeManager({
      config: config(true),
      globalAgent: agent("legacy"),
    });

    const first = await manager.getAgent("user-a");
    const firstAgain = await manager.getAgent("user-a");
    const second = await manager.getAgent("user-b");

    expect(first).toBe(firstAgent);
    expect(firstAgain).toBe(firstAgent);
    expect(second).toBe(secondAgent);
    expect(createAgentMock).toHaveBeenCalledTimes(2);
    expect(createAgentMock.mock.calls[0]?.[0]).toMatchObject({
      sessions: { directory: "/tmp/vex-sessions/users/user-a" },
      memory: { directory: "/tmp/vex-memory/users/user-a" },
    });
    expect(createAgentMock.mock.calls[1]?.[0]).toMatchObject({
      sessions: { directory: "/tmp/vex-sessions/users/user-b" },
      memory: { directory: "/tmp/vex-memory/users/user-b" },
    });
  });

  it("builds a single runtime for concurrent first-touch requests", async () => {
    const scopedAgent = agent("user-a-agent");
    let resolveCreate: (value: Agent) => void = () => {};
    // Hold createAgent open so all concurrent callers hit the async gap at once.
    createAgentMock.mockReturnValueOnce(
      new Promise<Agent>((resolve) => {
        resolveCreate = resolve;
      }),
    );
    createMemoryManagerMock.mockReturnValue({ close: vi.fn() });
    const manager = new UserRuntimeManager({
      config: config(true),
      globalAgent: agent("legacy"),
    });

    const inFlight = Promise.all([
      manager.getAgent("user-a"),
      manager.getAgent("user-a"),
      manager.getAgent("user-a"),
    ]);
    resolveCreate(scopedAgent);
    const [a, b, c] = await inFlight;

    expect(createAgentMock).toHaveBeenCalledTimes(1);
    expect(a).toBe(scopedAgent);
    expect(b).toBe(scopedAgent);
    expect(c).toBe(scopedAgent);
  });

  it("evicts a failed build so a later call retries", async () => {
    const goodAgent = agent("good-agent");
    createAgentMock
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(goodAgent);
    createMemoryManagerMock.mockReturnValue({ close: vi.fn() });
    const manager = new UserRuntimeManager({
      config: config(true),
      globalAgent: agent("legacy"),
    });

    await expect(manager.getAgent("user-a")).rejects.toThrow("boom");
    const retried = await manager.getAgent("user-a");

    expect(retried).toBe(goodAgent);
    expect(createAgentMock).toHaveBeenCalledTimes(2);
  });

  it("evicts idle runtimes past the TTL and tears them down", async () => {
    const idleAgent = agent("idle-agent");
    const freshAgent = agent("fresh-agent");
    const close = vi.fn();
    createAgentMock.mockResolvedValueOnce(idleAgent).mockResolvedValueOnce(freshAgent);
    createMemoryManagerMock.mockReturnValue({ close });
    const now = vi.spyOn(Date, "now");

    now.mockReturnValue(1_000);
    const manager = new UserRuntimeManager({
      config: config(true),
      globalAgent: agent("legacy"),
      idleTtlMs: 60_000,
    });

    await manager.getAgent("user-a");
    // Advance well past the idle TTL, then touch a *different* user to trigger a sweep.
    now.mockReturnValue(1_000 + 120_000);
    createMemoryManagerMock.mockReturnValue({ close: vi.fn() });
    await manager.getAgent("user-b");
    await Promise.resolve();

    expect(idleAgent.shutdown).toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);

    // user-a is gone, so touching it again rebuilds rather than serving the evicted one.
    createAgentMock.mockResolvedValueOnce(agent("rebuilt-agent"));
    now.mockReturnValue(1_000 + 130_000);
    await manager.getAgent("user-a");
    expect(createAgentMock).toHaveBeenCalledTimes(3);
    now.mockRestore();
  });

  it("evicts the least-recently-used runtime when over the cap", async () => {
    const agents = [agent("a"), agent("b"), agent("c")];
    const closes = [vi.fn(), vi.fn(), vi.fn()];
    createAgentMock
      .mockResolvedValueOnce(agents[0])
      .mockResolvedValueOnce(agents[1])
      .mockResolvedValueOnce(agents[2]);
    createMemoryManagerMock
      .mockReturnValueOnce({ close: closes[0] })
      .mockReturnValueOnce({ close: closes[1] })
      .mockReturnValueOnce({ close: closes[2] });
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1);

    const manager = new UserRuntimeManager({
      config: config(true),
      globalAgent: agent("legacy"),
      maxRuntimes: 2,
      idleTtlMs: 0,
    });

    now.mockReturnValue(10);
    await manager.getAgent("user-a");
    now.mockReturnValue(20);
    await manager.getAgent("user-b");
    // Re-touch user-a so user-b becomes least-recently-used.
    now.mockReturnValue(30);
    await manager.getAgent("user-a");
    // Adding user-c overflows the cap of 2 -> evicts user-b (LRU).
    now.mockReturnValue(40);
    await manager.getAgent("user-c");
    await Promise.resolve();

    expect(agents[1].shutdown).toHaveBeenCalled();
    expect(closes[1]).toHaveBeenCalledTimes(1);
    expect(agents[0].shutdown).not.toHaveBeenCalled();
    expect(agents[2].shutdown).not.toHaveBeenCalled();
    now.mockRestore();
  });

  it("drops a cached user runtime when reset", async () => {
    const firstAgent = agent("first-agent");
    const secondAgent = agent("second-agent");
    const close = vi.fn();
    createAgentMock.mockResolvedValueOnce(firstAgent).mockResolvedValueOnce(secondAgent);
    createMemoryManagerMock.mockReturnValue({ close });
    const manager = new UserRuntimeManager({
      config: config(true),
      globalAgent: agent("legacy"),
    });

    await manager.getAgent("user-a");
    await manager.reset("user-a");
    const next = await manager.getAgent("user-a");

    expect(firstAgent.shutdown).toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    expect(next).toBe(secondAgent);
  });
});
