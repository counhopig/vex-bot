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
