/**
 * Agent tests — processMessage orchestrates persona, pipeline, and the
 * per-Agent AgentRuntime.
 *
 * Architecture doc (§3): "An Agent instance owns its Persona, Tools, Skills,
 * Memory, and Pipeline. No process-global state bleeding across instances."
 */

import { describe, it, expect, vi } from "vitest";
import { Agent } from "../src/agent/Agent.js";
import type { AgentPluginService } from "../src/agent/Agent.js";
import { DEFAULT_IDENTITY } from "../src/agent/SystemPromptAssembler.js";
import { Pipeline } from "../src/agent/Pipeline.js";
import { Persona } from "../src/agent/persona/Persona.js";
import { createPersonaConfig } from "../src/agent/persona/PersonaConfig.js";
import { PersonaStorage } from "../src/agent/persona/PersonaStorage.js";
import type { AgentRuntime, AgentRuntimeReply } from "../src/agent/AgentRuntime.js";
import type { InboundMessageContext } from "../src/channels/ChannelAdapter.js";
import * as hooks from "../src/hooks/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function dummyConfig(userId = "u1", channelId = "webchat") {
  return {
    userId,
    channelId,
    providers: {},
    agent: { defaultModel: "gpt-4", defaultProvider: "openai", temperature: 0.7, maxTokens: 2048 },
    server: { port: 3000, host: "127.0.0.1" },
    logging: { level: "info" as const },
  };
}

/** Build a fake AgentRuntime that records chat() calls and returns a
 *  canned reply. Mirrors the real AgentRuntime's public surface. */
function fakeRuntime(reply: AgentRuntimeReply = { content: "Hello back", provider: "openai", model: "gpt-4" }) {
  const chat = vi.fn().mockResolvedValue(reply);
  const shutdown = vi.fn().mockResolvedValue(undefined);
  const runtime = { chat, shutdown } as unknown as AgentRuntime;
  return { runtime, chat, shutdown };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Agent", () => {
  // -- no persona (bare tool executor) -------------------------------------

  it("processMessage uses DEFAULT_IDENTITY when persona is null", async () => {
    const pipeline = new Pipeline();
    const { runtime, chat } = fakeRuntime();
    const agent = new Agent("u1", dummyConfig(), { pipeline, persona: null, runtime });

    await agent.processMessage(mockCtx());

    // Extract the system prompt passed to runtime.chat
    const systemPrompt = chat.mock.calls[0]![0] as string;
    expect(systemPrompt).toContain(DEFAULT_IDENTITY);
    expect(systemPrompt).not.toContain("小忆");
  });

  // -- with persona --------------------------------------------------------

  it("processMessage includes persona buildPrompt when persona is set", async () => {
    const pipeline = new Pipeline();
    const { runtime, chat } = fakeRuntime();
    const config = createPersonaConfig({ persona_name: "PandaBot", persona_base_prompt: "你是一个 PandaBot。" });
    const persona = new Persona(config!, new PersonaStorage());

    const agent = new Agent("u1", dummyConfig(), { pipeline, persona, runtime });
    await agent.processMessage(mockCtx());

    const systemPrompt = chat.mock.calls[0]![0] as string;
    expect(systemPrompt).toContain("PandaBot");
    expect(systemPrompt).toContain("你是一个 PandaBot。");
  });

  // -- persona owns identity, no competing DEFAULT_IDENTITY -----------------

  it("does NOT include DEFAULT_IDENTITY when persona is set (no competing identity)", async () => {
    const pipeline = new Pipeline();
    const { runtime, chat } = fakeRuntime();
    const config = createPersonaConfig({ persona_name: "PandaBot", persona_base_prompt: "你是一个 PandaBot。" });
    const persona = new Persona(config!, new PersonaStorage());

    const agent = new Agent("u1", dummyConfig(), { pipeline, persona, runtime });
    await agent.processMessage(mockCtx());

    const systemPrompt = chat.mock.calls[0]![0] as string;
    expect(systemPrompt).not.toContain(DEFAULT_IDENTITY);
    expect(systemPrompt).toContain("PandaBot");
  });

  // -- skills section ------------------------------------------------------

  it("injects the skills section into the system prompt when skillsPrompt is provided", async () => {
    const pipeline = new Pipeline();
    const { runtime, chat } = fakeRuntime();
    const agent = new Agent("u1", dummyConfig(), {
      pipeline,
      persona: null,
      runtime,
      skillsPrompt: "# Available Skills\n\n## Skill: Greeting\n\nSay hi.",
    });

    await agent.processMessage(mockCtx());

    const systemPrompt = chat.mock.calls[0]![0] as string;
    expect(systemPrompt).toContain("【技能模板】");
    expect(systemPrompt).toContain("# Available Skills");
    expect(systemPrompt).toContain("Skill: Greeting");
  });

  it("omits the skills section when skillsPrompt is undefined", async () => {
    const pipeline = new Pipeline();
    const { runtime, chat } = fakeRuntime();
    const agent = new Agent("u1", dummyConfig(), { pipeline, persona: null, runtime });

    await agent.processMessage(mockCtx());

    const systemPrompt = chat.mock.calls[0]![0] as string;
    expect(systemPrompt).not.toContain("【技能模板】");
    expect(systemPrompt).not.toContain("Available Skills");
  });

  // -- interceptor short-circuit -------------------------------------------

  it("processMessage short-circuits when pipeline interceptor returns a string", async () => {
    const pipeline = new Pipeline();
    pipeline.registerInterceptor(async () => "intercepted!");
    const { runtime, chat } = fakeRuntime();
    const persona = new Persona(createPersonaConfig({ persona_name: "B", persona_base_prompt: "." })!, new PersonaStorage());

    const agent = new Agent("u1", dummyConfig(), { pipeline, persona, runtime });
    const response = await agent.processMessage(mockCtx());

    expect(response.content).toBe("intercepted!");
    expect(chat).not.toHaveBeenCalled();
  });

  // -- full flow -----------------------------------------------------------

  it("processMessage calls runtime.chat with system prompt and ctx", async () => {
    const pipeline = new Pipeline();
    const { runtime, chat } = fakeRuntime({ content: "Hi there", provider: "openai", model: "gpt-4" });
    const persona = new Persona(createPersonaConfig({ persona_name: "B", persona_base_prompt: "." })!, new PersonaStorage());

    const agent = new Agent("u1", dummyConfig(), { pipeline, persona, runtime });
    const ctx = mockCtx();
    await agent.processMessage(ctx);

    expect(chat).toHaveBeenCalledOnce();
    const [systemPrompt, passedCtx] = chat.mock.calls[0]!;
    expect(passedCtx).toBe(ctx);
    expect(systemPrompt).toContain("B"); // persona identity in prompt
  });

  it("propagates the reply's provider, model, and usage to AgentResponse", async () => {
    const pipeline = new Pipeline();
    const { runtime } = fakeRuntime({
      content: "ok",
      provider: "deepseek",
      model: "deepseek-chat",
      usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18 },
    });
    const agent = new Agent("u1", dummyConfig(), { pipeline, persona: null, runtime });
    const response = await agent.processMessage(mockCtx());

    expect(response).toEqual({
      content: "ok",
      provider: "deepseek",
      model: "deepseek-chat",
      usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18 },
    });
  });

  // -- observers run -------------------------------------------------------

  it("processMessage runs pipeline observers after chat", async () => {
    const pipeline = new Pipeline();
    const observer = vi.fn().mockResolvedValue(undefined);
    pipeline.registerObserver(observer);
    const { runtime } = fakeRuntime({ content: "response" });

    const agent = new Agent("u1", dummyConfig(), { pipeline, persona: null, runtime });
    const ctx = mockCtx();
    await agent.processMessage(ctx);

    expect(observer).toHaveBeenCalledWith(ctx, "response");
  });

  // -- error propagation ---------------------------------------------------

  it("propagates errors from runtime.chat", async () => {
    const pipeline = new Pipeline();
    const { runtime } = fakeRuntime();
    (runtime.chat as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("LLM error"));

    const agent = new Agent("u1", dummyConfig(), { pipeline, persona: null, runtime });

    await expect(agent.processMessage(mockCtx())).rejects.toThrow("LLM error");
  });

  // -- shutdown ------------------------------------------------------------

  it("shutdown forwards to runtime.shutdown", async () => {
    const pipeline = new Pipeline();
    const { runtime, shutdown } = fakeRuntime();
    const agent = new Agent("u1", dummyConfig(), { pipeline, persona: null, runtime });

    await agent.shutdown();

    expect(shutdown).toHaveBeenCalledOnce();
  });

  it("shutdown tears down the plugin service before the runtime", async () => {
    const pipeline = new Pipeline();
    const { runtime, shutdown: runtimeShutdown } = fakeRuntime();
    const pluginShutdown = vi.fn().mockResolvedValue(undefined);
    const agent = new Agent("u1", dummyConfig(), {
      pipeline,
      persona: null,
      runtime,
      pluginService: { shutdown: pluginShutdown } as AgentPluginService,
    });

    await agent.shutdown();

    expect(pluginShutdown).toHaveBeenCalledTimes(1);
    expect(runtimeShutdown).toHaveBeenCalledTimes(1);
  });

  // -- hook wiring: emitAgentStart + emitAgentEnd around runtime.chat ---

  it("emits agent_start before runtime.chat and agent_end after", async () => {
    const start = vi.spyOn(hooks, "emitAgentStart").mockImplementation(() => {});
    const end = vi.spyOn(hooks, "emitAgentEnd").mockImplementation(() => {});
    const pipeline = new Pipeline();
    const { runtime } = fakeRuntime({ content: "done", provider: "openai", model: "gpt-4" });

    const agent = new Agent("u1", dummyConfig(), { pipeline, persona: null, runtime });
    await agent.processMessage(mockCtx());

    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ provider: "openai", model: "gpt-4" }),
    );
    expect(end).toHaveBeenCalledTimes(1);
    expect(end.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-4",
        response: "done",
      }),
    );
    expect(end.mock.calls[0]?.[0].durationMs).toBeGreaterThanOrEqual(0);
    start.mockRestore();
    end.mockRestore();
  });

  it("emits agent_end even when runtime.chat throws (response empty, duration set)", async () => {
    const start = vi.spyOn(hooks, "emitAgentStart").mockImplementation(() => {});
    const end = vi.spyOn(hooks, "emitAgentEnd").mockImplementation(() => {});
    const pipeline = new Pipeline();
    const { runtime } = fakeRuntime();
    (runtime.chat as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("LLM down"));

    const agent = new Agent("u1", dummyConfig(), { pipeline, persona: null, runtime });
    await expect(agent.processMessage(mockCtx())).rejects.toThrow("LLM down");

    expect(start).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
    expect(end.mock.calls[0]?.[0].response).toBe("");
    start.mockRestore();
    end.mockRestore();
  });
});
