/**
 * PersonaConfig tests — opt-in Persona with no hardcoded defaults.
 *
 * Architecture doc (§3): "If persona section is absent from config, persona
 * is disabled. The agent uses a minimal default identity."
 * "Hardcoded defaults ('小忆', '温柔少女') hijack the agent when the user
 * never asked for a persona."
 */

import { describe, it, expect } from "vitest";
import { createPersonaConfig } from "../src/agent/persona/PersonaConfig.js";

describe("PersonaConfig", () => {
  it("returns null when config is undefined (opt-in)", () => {
    expect(createPersonaConfig(undefined)).toBeNull();
  });

  it("returns null when config is null (opt-in)", () => {
    expect(createPersonaConfig(null)).toBeNull();
  });

  it("returns a full PersonaConfig when raw config is provided", () => {
    const cfg = createPersonaConfig({ persona_name: "TestBot" });
    expect(cfg).not.toBeNull();
    expect(cfg!.personaName).toBe("TestBot");
  });

  it("provides sensible defaults for missing fields", () => {
    const cfg = createPersonaConfig({ persona_name: "MinBot" });
    expect(cfg!.personaName).toBe("MinBot");
    // Defaults for boolean features
    expect(cfg!.emotionEnabled).toBe(true);
    expect(cfg!.timeAwarenessEnabled).toBe(true);
    // Defaults for numeric fields
    expect(cfg!.emotionDecayPerHour).toBe(2.0);
    expect(cfg!.emotionRecoveryPerReply).toBe(3.0);
    // Default strings are not hardcoded identity — they are generic descriptions
    expect(cfg!.personaBasePrompt).toBeTruthy();
    expect(cfg!.personaReplyStyle).toBeTruthy();
  });

  it("does NOT contain hardcoded '小忆' or '温柔少女' defaults", () => {
    const cfg = createPersonaConfig({ persona_name: "TestBot" });
    expect(cfg!.personaBasePrompt).not.toContain("小忆");
    expect(cfg!.personaBasePrompt).not.toContain("温柔少女");
    expect(cfg!.personaBasePrompt).not.toContain("毒舌");
    expect(cfg!.personaName).not.toBe("小忆");
  });

  it("allows overriding every default field", () => {
    const cfg = createPersonaConfig({
      persona_name: "CustomBot",
      persona_base_prompt: "You are a custom bot",
      persona_reply_style: "Be concise",
      emotion_enabled: false,
      time_awareness_enabled: false,
      emotion_decay_per_hour: 5.0,
    });
    expect(cfg!.personaName).toBe("CustomBot");
    expect(cfg!.personaBasePrompt).toBe("You are a custom bot");
    expect(cfg!.personaReplyStyle).toBe("Be concise");
    expect(cfg!.emotionEnabled).toBe(false);
    expect(cfg!.timeAwarenessEnabled).toBe(false);
    expect(cfg!.emotionDecayPerHour).toBe(5.0);
  });
});
