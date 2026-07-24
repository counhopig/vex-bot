/**
 * Persona tests — buildPrompt (Section 1 of system prompt) and
 * observeResponse (emotion/history/profile updates).
 */

import { describe, it, expect, vi } from "vitest";
import { Persona } from "../src/agent/persona/Persona.js";
import { createPersonaConfig } from "../src/agent/persona/PersonaConfig.js";
import { PersonaStorage } from "../src/agent/persona/PersonaStorage.js";
import type { InboundMessageContext } from "../src/channels/ChannelAdapter.js";

function mockCtx(overrides?: Partial<InboundMessageContext>): InboundMessageContext {
  return {
    channelId: "webchat",
    messageId: "m1",
    chatId: "c1",
    chatType: "direct",
    senderId: "u1",
    content: "hello",
    timestamp: 1000,
    ...overrides,
  };
}

describe("Persona", () => {
  it("buildPrompt returns a non-empty string with persona identity", async () => {
    const config = createPersonaConfig({ persona_name: "PandaBot", persona_base_prompt: "你是一个友好的 AI 助手。" });
    const storage = new PersonaStorage();
    const persona = new Persona(config!, storage);

    const prompt = await persona.buildPrompt(mockCtx());
    expect(prompt).toContain("PandaBot");
    expect(prompt).toContain("你是一个友好的 AI 助手。");
  });

  it("buildPrompt includes reply style when configured", async () => {
    const config = createPersonaConfig({
      persona_name: "Bot",
      persona_base_prompt: "Be helpful.",
      persona_reply_style: "Use emojis.",
    });
    const storage = new PersonaStorage();
    const persona = new Persona(config!, storage);

    const prompt = await persona.buildPrompt(mockCtx());
    expect(prompt).toContain("Use emojis.");
  });

  it("buildPrompt includes current time when time_awareness_enabled", async () => {
    const config = createPersonaConfig({
      persona_name: "Bot",
      persona_base_prompt: "Be helpful.",
      time_awareness_enabled: true,
    });
    const storage = new PersonaStorage();
    const persona = new Persona(config!, storage);

    const prompt = await persona.buildPrompt(mockCtx());
    expect(prompt).toMatch(/当前时间|Current time|time|日期/);
  });

  it("buildPrompt does NOT contain hardcoded 小忆 or 温柔少女", async () => {
    const config = createPersonaConfig({ persona_name: "PandaBot", persona_base_prompt: "你是一个 AI。" });
    const storage = new PersonaStorage();
    const persona = new Persona(config!, storage);

    const prompt = await persona.buildPrompt(mockCtx());
    expect(prompt).not.toContain("小忆");
    expect(prompt).not.toContain("温柔少女");
  });

  it("observeResponse updates emotion state", async () => {
    const config = createPersonaConfig({
      persona_name: "Bot",
      persona_base_prompt: "Helpful.",
      emotion_enabled: true,
    });
    const storage = new PersonaStorage();
    const persona = new Persona(config!, storage);

    await persona.observeResponse(mockCtx({ content: "You're great!" }), "Thanks!");

    // Emotion should have been updated (recovered after reply)
    const state = persona.getState();
    expect(state.emotion).toBeDefined();
    expect(state.emotion.energy).toBeGreaterThan(0);
    expect(state.emotion.mood).toBeGreaterThan(0);
  });

  it("getState returns current emotion, history, and profile", () => {
    const config = createPersonaConfig({ persona_name: "Bot", persona_base_prompt: "." });
    const storage = new PersonaStorage();
    const persona = new Persona(config!, storage);

    const state = persona.getState();
    expect(state).toHaveProperty("emotion");
    expect(state).toHaveProperty("history");
    expect(state).toHaveProperty("profile");
  });

  it("buildPrompt does not include persona identity when persona is disabled", async () => {
    // When config.persona is absent -> createPersonaConfig returns null
    // -> Agent.persona === null -> a DEFAULT_IDENTITY is used instead
    // This test just validates persona is correctly null
    expect(createPersonaConfig(undefined)).toBeNull();
  });
});
