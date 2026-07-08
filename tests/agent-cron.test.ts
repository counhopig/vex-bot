import { describe, it, expect, vi } from "vitest";

vi.mock("../src/utils/logger.js", () => ({
  getChildLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { createAgentCronExecutor } from "../src/agents/agent.js";
import type { Agent } from "../src/agents/agent.js";

describe("createAgentCronExecutor", () => {
  it("routes a cron job through the given agent's processMessage", async () => {
    const processMessage = vi.fn().mockResolvedValue({
      content: "done",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      provider: "deepseek",
      model: "m",
    });
    const exec = createAgentCronExecutor({ processMessage } as unknown as Agent);

    const result = await exec({ message: "run the report" });

    expect(processMessage).toHaveBeenCalledTimes(1);
    expect(processMessage.mock.calls[0]![0]).toMatchObject({
      content: "run the report",
      senderId: "cron-system",
    });
    expect(result).toEqual({ success: true, output: "done" });
  });

  it("reports failure without throwing when the agent errors", async () => {
    const processMessage = vi.fn().mockRejectedValue(new Error("boom"));
    const exec = createAgentCronExecutor({ processMessage } as unknown as Agent);

    const result = await exec({ message: "x" });

    expect(result).toMatchObject({ success: false, output: "", error: "boom" });
  });
});
