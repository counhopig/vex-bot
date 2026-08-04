/**
 * Persona tests — buildPrompt (Section 1 of system prompt) and
 * observeResponse (emotion/history/profile updates).
 */

import { describe, it, expect, vi } from "vitest";
import { Persona } from "../src/agent/persona/Persona.js";
import { createPersonaConfig } from "../src/agent/persona/PersonaConfig.js";
import { PersonaStorage } from "../src/agent/persona/PersonaStorage.js";
import type { InboundMessageContext } from "../src/channels/ChannelAdapter.js";
import { join } from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";

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

  it.each([
    [2, "深夜"],
    [6, "早晨"],
    [10, "上午"],
    [12, "中午"],
    [16, "下午"],
    [18, "傍晚"],
    [22, "夜间"],
  ])("classifies local hour %i as %s", async (hour, expectedPeriod) => {
    const config = createPersonaConfig({
      persona_name: "Bot",
      persona_base_prompt: "Be helpful.",
      time_awareness_enabled: true,
    });
    const persona = new Persona(config!, new PersonaStorage());
    const timestamp = new Date(2026, 7, 3, hour, 23).getTime();

    const prompt = await persona.buildPrompt(mockCtx({ timestamp }));

    expect(prompt).toContain(`当前时段: ${expectedPeriod}`);
    expect(prompt).toContain("回复中的早晚、问候和作息描述必须与“当前时段”一致");
    expect(prompt).toMatch(/时区: .+ \(UTC[+-]\d{2}:\d{2}\)/);
  });

  it("classifies 18:23 as evening rather than late night", async () => {
    const config = createPersonaConfig({
      persona_name: "PandaBot",
      persona_base_prompt: "Be helpful.",
      time_awareness_enabled: true,
    });
    const persona = new Persona(config!, new PersonaStorage());
    const timestamp = new Date(2026, 7, 3, 18, 23).getTime();

    const prompt = await persona.buildPrompt(mockCtx({ timestamp }));

    expect(prompt).toContain("当前时段: 傍晚");
    expect(prompt).not.toContain("当前时段: 深夜");
  });

  it("normalizes Weixin Unix-second timestamps before deriving local time", async () => {
    const config = createPersonaConfig({
      persona_name: "PandaBot",
      persona_base_prompt: "Be helpful.",
      time_awareness_enabled: true,
    });
    const persona = new Persona(config!, new PersonaStorage());
    const timestampSeconds = Math.floor(new Date(2026, 7, 4, 12, 3).getTime() / 1000);

    const prompt = await persona.buildPrompt(mockCtx({
      channelId: "weixin",
      timestamp: timestampSeconds,
    }));

    expect(prompt).toContain("2026-08-04 12:03");
    expect(prompt).toContain("当前时段: 中午");
    expect(prompt).not.toContain("1970-");
    expect(prompt).not.toContain("当前时段: 深夜");
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

  it("persists an explicitly declared name and injects it after rebuild", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vex-persona-profile-"));
    const profileFile = join(directory, "profile.json");
    const config = createPersonaConfig({ persona_name: "Bot", persona_base_prompt: "." });
    try {
      const first = new Persona(config!, new PersonaStorage(profileFile));
      await first.observeResponse(mockCtx({ content: "我叫 Counhopig" }), "你好");

      const rebuilt = new Persona(config!, new PersonaStorage(profileFile));
      const prompt = await rebuilt.buildPrompt(mockCtx({ content: "我是谁" }));

      expect(prompt).toContain("【用户画像】");
      expect(prompt).toContain("[姓名] Counhopig");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not infer a name from questions or third-person statements", async () => {
    const config = createPersonaConfig({ persona_name: "Bot", persona_base_prompt: "." });
    const persona = new Persona(config!, new PersonaStorage());

    await persona.observeResponse(mockCtx({ content: "我是谁" }), "不知道");
    await persona.observeResponse(mockCtx({ content: "他叫 Counhopig" }), "好的");

    expect(persona.getState().profile).toEqual({});
  });

  it("buildPrompt does not include persona identity when persona is disabled", async () => {
    // When config.persona is absent -> createPersonaConfig returns null
    // -> Agent.persona === null -> a DEFAULT_IDENTITY is used instead
    // This test just validates persona is correctly null
    expect(createPersonaConfig(undefined)).toBeNull();
  });
});
