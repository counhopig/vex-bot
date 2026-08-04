/**
 * Persona — the agent's identity.
 *
 * Architecture doc (§4): "Persona is NOT an extension. It is a first-class
 * component of Agent. If config.persona is absent or enabled: false, the
 * Agent operates as a bare tool executor with a minimal default identity."
 *
 * buildPrompt() → Section 1 of the system prompt (always prepended).
 * observeResponse() → updates emotion/history/profile after each turn.
 */

import type { PersonaConfig } from "./PersonaConfig.js";
import { PersonaStorage } from "./PersonaStorage.js";
import type { PersonaState } from "./models.js";
import type { InboundMessageContext } from "../../channels/ChannelAdapter.js";
import { buildPersonaPrompt } from "./PersonaBuilder.js";

export class Persona {
  readonly config: PersonaConfig;
  private readonly storage: PersonaStorage;

  constructor(config: PersonaConfig, storage?: PersonaStorage) {
    this.config = config;
    this.storage = storage ?? new PersonaStorage();
  }

  /** Section 1 of the system prompt. */
  async buildPrompt(ctx: InboundMessageContext): Promise<string> {
    return buildPersonaPrompt(this.config, this.storage, ctx);
  }

  /** Post-turn: update emotion, history. */
  async observeResponse(ctx: InboundMessageContext, replyText: string): Promise<void> {
    // Update emotion (recover after replying)
    if (this.config.emotionEnabled) {
      this.storage.updateEmotion({
        energy: this.config.emotionRecoveryPerReply,
        mood: this.config.emotionRecoveryPerReply * 0.5,
      });
    }

    // Add to conversation history
    const senderName = ctx.senderName ?? ctx.senderId;
    this.storage.addHistory(`${senderName}: ${ctx.content}`);
    this.storage.addHistory(`assistant: ${replyText}`);

    if (this.config.profileEnabled) {
      const name = extractExplicitName(ctx.content);
      if (name) this.storage.setProfileFact("姓名", name);
    }
  }

  /** Get current state (for inspection/serialization). */
  getState(): PersonaState {
    return this.storage.getState();
  }
}

/** Only accept explicit first-person declarations; never infer identity. */
function extractExplicitName(content: string): string | undefined {
  const text = content.trim();
  const patterns = [
    /^(?:我叫|我的名字(?:叫|是)|请叫我)\s*([\p{L}\p{N}_·.-]{1,40})[。！!，,\s]*$/u,
    /^my name is\s+([\p{L}\p{N}_·.-]{1,40})[.!\s]*$/iu,
  ];
  for (const pattern of patterns) {
    const value = pattern.exec(text)?.[1]?.trim();
    if (value) return value;
  }
  return undefined;
}
