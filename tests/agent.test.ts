/**
 * Agent tests — processMessage orchestrates persona, pipeline, and chat.
 *
 * Architecture doc (§3): "An Agent instance owns its Persona, Tools, Skills,
 * Memory, and Pipeline. No process-global state bleeding across instances."
 */

import { describe, it, expect, vi } from "vitest";
import { Agent, DEFAULT_IDENTITY } from "../src/agent/Agent.js";
import { Pipeline } from "../src/agent/Pipeline.js";
import { Persona } from "../src/agent/persona/Persona.js";
import { createPersonaConfig } from "../src/agent/persona/PersonaConfig.js";
import { PersonaStorage } from "../src/agent/persona/PersonaStorage.js";
import type { InboundMessageContext } from "../src/channels/ChannelAdapter.js";

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

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Agent", () => {
  // -- no persona (bare tool executor) -------------------------------------

  it("processMessage uses DEFAULT_IDENTITY when persona is null", async () => {
    const pipeline = new Pipeline();
    const chat = vi.fn().mockResolvedValue({ content: "Hello back" });
    const agent = new Agent("u1", dummyConfig(), { pipeline, persona: null, chat });

    await agent.processMessage(mockCtx());

    // Extract the system prompt passed to chat
    const systemPrompt = chat.mock.calls[0]![0];
    expect(systemPrompt).toContain(DEFAULT_IDENTITY);
    expect(systemPrompt).not.toContain("小忆");
  });

  // -- with persona --------------------------------------------------------

  it("processMessage includes persona buildPrompt when persona is set", async () => {
    const pipeline = new Pipeline();
    const chat = vi.fn().mockResolvedValue({ content: "ok" });
    const config = createPersonaConfig({ persona_name: "PandaBot", persona_base_prompt: "你是一个 PandaBot。" });
    const persona = new Persona(config!, new PersonaStorage());

    const agent = new Agent("u1", dummyConfig(), { pipeline, persona, chat });
    await agent.processMessage(mockCtx());

    const systemPrompt = chat.mock.calls[0]![0];
    expect(systemPrompt).toContain("PandaBot");
    expect(systemPrompt).toContain("你是一个 PandaBot。");
  });

  // -- persona owns identity, no competing DEFAULT_IDENTITY -----------------

  it("does NOT include DEFAULT_IDENTITY when persona is set (no competing identity)", async () => {
    const pipeline = new Pipeline();
    const chat = vi.fn().mockResolvedValue({ content: "ok" });
    const config = createPersonaConfig({ persona_name: "PandaBot", persona_base_prompt: "你是一个 PandaBot。" });
    const persona = new Persona(config!, new PersonaStorage());

    const agent = new Agent("u1", dummyConfig(), { pipeline, persona, chat });
    await agent.processMessage(mockCtx());

    const systemPrompt = chat.mock.calls[0]![0];
    // DEFAULT_IDENTITY must never appear when persona owns the identity
    expect(systemPrompt).not.toContain(DEFAULT_IDENTITY);
    // Only the persona's identity should be present
    expect(systemPrompt).toContain("PandaBot");
  });

  // -- interceptor short-circuit -------------------------------------------

  it("processMessage short-circuits when pipeline interceptor returns a string", async () => {
    const pipeline = new Pipeline();
    pipeline.registerInterceptor(async () => "intercepted!");
    const chat = vi.fn();
    const persona = new Persona(createPersonaConfig({ persona_name: "B", persona_base_prompt: "." })!, new PersonaStorage());

    const agent = new Agent("u1", dummyConfig(), { pipeline, persona, chat });
    const response = await agent.processMessage(mockCtx());

    expect(response.content).toBe("intercepted!");
    expect(chat).not.toHaveBeenCalled();
  });

  // -- full flow -----------------------------------------------------------

  it("processMessage calls chat with system prompt and user message", async () => {
    const pipeline = new Pipeline();
    const chat = vi.fn().mockResolvedValue({ content: "Hi there" });
    const persona = new Persona(createPersonaConfig({ persona_name: "B", persona_base_prompt: "." })!, new PersonaStorage());

    const agent = new Agent("u1", dummyConfig(), { pipeline, persona, chat });
    await agent.processMessage(mockCtx());

    expect(chat).toHaveBeenCalledOnce();
    const [systemPrompt, messages] = chat.mock.calls[0]!;
    expect(messages).toEqual([{ role: "user", content: "hello" }]);
    expect(systemPrompt).toContain("B"); // persona identity in prompt
  });

  // -- observers run -------------------------------------------------------

  it("processMessage runs pipeline observers after chat", async () => {
    const pipeline = new Pipeline();
    const observer = vi.fn().mockResolvedValue(undefined);
    pipeline.registerObserver(observer);
    const chat = vi.fn().mockResolvedValue({ content: "response" });

    const agent = new Agent("u1", dummyConfig(), { pipeline, persona: null, chat });
    const ctx = mockCtx();
    await agent.processMessage(ctx);

    expect(observer).toHaveBeenCalledWith(ctx, "response");
  });

  // -- error propagation ---------------------------------------------------

  it("propagates errors from chat", async () => {
    const pipeline = new Pipeline();
    const chat = vi.fn().mockRejectedValue(new Error("LLM error"));
    const agent = new Agent("u1", dummyConfig(), { pipeline, persona: null, chat });

    await expect(agent.processMessage(mockCtx())).rejects.toThrow("LLM error");
  });

  // -- shutdown ------------------------------------------------------------

  it("shutdown resolves without error", async () => {
    const pipeline = new Pipeline();
    const chat = vi.fn();
    const agent = new Agent("u1", dummyConfig(), { pipeline, persona: null, chat });
    await expect(agent.shutdown()).resolves.toBeUndefined();
  });
});
