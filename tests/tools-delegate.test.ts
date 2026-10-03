import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDelegateTool, type DelegateOptions } from "../src/tools/delegate.js";
import { createFaux, fauxStreamFn } from "./helpers/faux.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

let workspace: string;
beforeEach(async () => { workspace = await makeTmpDir(); });
afterEach(async () => { await removeTmpDir(workspace); });

describe("delegate", () => {
  function setup(overrides: Partial<DelegateOptions> = {}) {
    const faux = createFaux();
    const execute = vi.fn(async (_id, _args, _signal, update) => {
      update?.({ content: [{ type: "text", text: "progress" }], details: {} });
      return { content: [{ type: "text" as const, text: "tool result" }], details: {} };
    });
    const echo: AgentTool = { name: "echo", label: "echo", description: "echo", parameters: Type.Object({}), execute };
    const tool = createDelegateTool({ workspace, model: faux.getModel(), streamFn: fauxStreamFn(faux), getApiKey: () => "test", tools: [echo], ...overrides });
    return { faux, tool, echo, execute };
  }

  it("starts fresh with only base, SOUL and task and returns only the final text", async () => {
    await writeFile(join(workspace, "SOUL.md"), "SOUL marker");
    await writeFile(join(workspace, "USER.md"), "private user marker");
    await writeFile(join(workspace, "MEMORY.md"), "private memory marker");
    const { faux, tool } = setup();
    faux.setResponses([(ctx) => {
      expect(ctx.messages.filter((message) => message.role !== "system")).toHaveLength(1);
      const prompt = getCurrentSystemPrompt(ctx.messages);
      expect(prompt).toContain("SOUL marker");
      expect(prompt).toContain("task marker");
      expect(prompt).not.toContain("private user marker");
      expect(prompt).not.toContain("private memory marker");
      return fauxAssistantMessage("final reply");
    }]);
    expect(await tool.execute("id", { task: "task marker" })).toMatchObject({ content: [{ text: "final reply" }] });
  });

  it("inherits approval and streams child tool progress", async () => {
    const gate = vi.fn(async () => undefined);
    const { faux, tool, execute } = setup({ beforeToolCall: gate });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("echo", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("final only"),
    ]);
    const update = vi.fn();
    expect(await tool.execute("id", { task: "go" }, undefined, update)).toMatchObject({ content: [{ text: "final only" }] });
    expect(gate).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(update.mock.calls.some(([result]) => result.details.type === "tool_execution_update")).toBe(true);
  });

  it("keeps blocked tools from running and returns the model's rejection response", async () => {
    const { faux, tool, execute } = setup({ beforeToolCall: async () => ({ block: true, reason: "denied" }) });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("echo", {}), { stopReason: "toolUse" }),
      (ctx) => {
        expect(ctx.messages.at(-1)).toMatchObject({ role: "toolResult", isError: true, content: [{ text: "denied" }] });
        return fauxAssistantMessage("denied reply");
      },
    ]);
    expect(await tool.execute("id", { task: "go" })).toMatchObject({ content: [{ text: "denied reply" }] });
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects unknown tools and explicit recursion", async () => {
    const { tool } = setup();
    await expect(tool.execute("id", { task: "go", tools: ["unknown"] })).rejects.toThrow("unknown");
    await expect(tool.execute("id", { task: "go", tools: ["delegate"] })).rejects.toThrow("delegate");
  });

  it("surfaces child tool errors to the child model", async () => {
    const { faux, echo } = setup();
    echo.execute = async () => { throw new Error("child tool failed"); };
    const tool = createDelegateTool({ workspace, model: faux.getModel(), streamFn: fauxStreamFn(faux), getApiKey: () => "test", tools: [echo] });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("echo", {}), { stopReason: "toolUse" }),
      (ctx) => {
        expect(ctx.messages.at(-1)).toMatchObject({ role: "toolResult", isError: true, content: [{ text: "child tool failed" }] });
        return fauxAssistantMessage("tool failed reply");
      },
    ]);
    expect(await tool.execute("id", { task: "go" })).toMatchObject({ content: [{ text: "tool failed reply" }] });
  });

  it("uses dynamic tool subsets and strips delegate by default", async () => {
    const { faux, echo } = setup();
    const recursive = { ...echo, name: "delegate" };
    const getTools = vi.fn(() => [echo, recursive]);
    const tool = createDelegateTool({ workspace, model: faux.getModel(), streamFn: fauxStreamFn(faux), getApiKey: () => "test", getTools });
    faux.setResponses([(ctx) => {
      const system = ctx.messages.find((message) => message.role === "system");
      expect(JSON.stringify(system)).not.toContain('"name":"delegate"');
      return fauxAssistantMessage("ok");
    }, fauxAssistantMessage("empty subset")]);
    await tool.execute("id", { task: "go" });
    await tool.execute("id2", { task: "go", tools: [] });
    expect(getTools).toHaveBeenCalledTimes(2);
  });

  it("surfaces model failures", async () => {
    const { faux, tool } = setup();
    faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider failed" })]);
    await expect(tool.execute("id", { task: "go" })).rejects.toThrow("provider failed");
  });

  it("propagates abort into a running child tool", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const { faux, echo } = setup();
    let childAborted = false;
    echo.execute = async (_id, _args, signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => { childAborted = true; reject(new Error("aborted")); }, { once: true });
      started();
    });
    const tool = createDelegateTool({ workspace, model: faux.getModel(), streamFn: fauxStreamFn(faux), getApiKey: () => "test", tools: [echo] });
    faux.setResponses([fauxAssistantMessage(fauxToolCall("echo", {}), { stopReason: "toolUse" })]);
    const run = tool.execute("id", { task: "go" }, controller.signal);
    await ready;
    controller.abort();
    await expect(run).rejects.toThrow();
    expect(childAborted).toBe(true);
  });
});
