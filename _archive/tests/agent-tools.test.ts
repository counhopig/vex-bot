import { describe, expect, it, vi, afterEach } from "vitest";
import { Type } from "@sinclair/typebox";
import { Agent } from "../src/agents/agent.js";
import { clearTools, registerTool } from "../src/tools/registry.js";
import { createToolResult } from "../src/tools/types.js";
import type { AgentRuntime } from "../src/agents/runtime.js";

vi.mock("../src/utils/logger.js", () => ({
  getChildLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe("Agent tool integration", () => {
  afterEach(() => {
    clearTools();
  });

  it("registers plugin/global registry tools into the runtime tool pool", () => {
    registerTool({
      name: "plugin_runtime_tool",
      label: "Plugin Runtime Tool",
      description: "Registered through the plugin/global tool registry",
      parameters: Type.Object({}),
      execute: async () => createToolResult("ok"),
    });
    const registered: string[] = [];
    const runtime = {
      registerCustomTool: vi.fn((tool: { name: string }) => {
        registered.push(tool.name);
      }),
    } as unknown as AgentRuntime;

    new Agent(runtime, {
      model: "test-model",
      enableTools: true,
      enableFunctionCalling: true,
    });

    expect(registered).toContain("plugin_runtime_tool");
    expect(registered).toContain("weather");
    expect(registered.filter((name) => name === "plugin_runtime_tool")).toHaveLength(1);
  });
});
