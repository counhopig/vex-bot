/**
 * PersonaConfig — opt-in persona configuration.
 *
 * Architecture doc (§3, Design Decision 3):
 *   "If persona section is absent from config, persona is disabled.
 *    The agent uses a minimal default identity."
 *
 * Hardcoded Chinese defaults (小忆, 温柔少女, 毒舌) from the old codebase
 * are intentionally absent — Persona must be explicitly opted into.
 */

export interface PersonaConfig {
  personaName: string;
  personaBasePrompt: string;
  personaReplyStyle: string;
  timeAwarenessEnabled: boolean;
  emotionEnabled: boolean;
  emotionDecayPerHour: number;
  emotionRecoveryPerReply: number;
  profileEnabled: boolean;
  memoryEnabled: boolean;
  memoryMaxTurns: number;
}

/**
 * Create a PersonaConfig from raw (user-supplied) config data.
 * Returns null when config is absent (opt-in).
 */
export function createPersonaConfig(
  raw: Record<string, unknown> | undefined | null,
): PersonaConfig | null {
  if (!raw) return null;

  return {
    personaName:
      typeof raw.persona_name === "string" ? raw.persona_name : "Assistant",
    personaBasePrompt:
      typeof raw.persona_base_prompt === "string"
        ? raw.persona_base_prompt
        : "You are a helpful, friendly AI assistant.",
    personaReplyStyle:
      typeof raw.persona_reply_style === "string"
        ? raw.persona_reply_style
        : "Be concise, natural, and helpful. Use plain language.",
    timeAwarenessEnabled:
      typeof raw.time_awareness_enabled === "boolean"
        ? raw.time_awareness_enabled
        : true,
    emotionEnabled:
      typeof raw.emotion_enabled === "boolean"
        ? raw.emotion_enabled
        : true,
    emotionDecayPerHour:
      typeof raw.emotion_decay_per_hour === "number"
        ? raw.emotion_decay_per_hour
        : 2.0,
    emotionRecoveryPerReply:
      typeof raw.emotion_recovery_per_reply === "number"
        ? raw.emotion_recovery_per_reply
        : 3.0,
    profileEnabled:
      typeof raw.profile_enabled === "boolean"
        ? raw.profile_enabled
        : true,
    memoryEnabled:
      typeof raw.memory_enabled === "boolean"
        ? raw.memory_enabled
        : true,
    memoryMaxTurns:
      typeof raw.memory_max_turns === "number"
        ? raw.memory_max_turns
        : 10,
  };
}
