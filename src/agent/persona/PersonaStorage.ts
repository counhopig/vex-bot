/**
 * PersonaStorage — per-Agent in-memory persona state.
 *
 * Holds emotion, conversation history, and profile facts for one Agent
 * instance. Not persisted to disk (the old PersonaStorage in archive did
 * persist to JSON; that is a separate concern that can be added later).
 *
 * Architecture doc: PersonaStorage is per-Agent, not per-owner-keyed via a
 * process-global Map. When the Agent is destroyed, its storage is destroyed.
 */

import type { EmotionState, PersonaState } from "./models.js";

export class PersonaStorage {
  private emotion: EmotionState = { energy: 75, mood: 60 };
  private history: string[] = [];
  private profile: Record<string, string> = {};

  getEmotion(): EmotionState {
    return { ...this.emotion };
  }

  updateEmotion(delta: Partial<EmotionState>): void {
    if (delta.energy !== undefined) {
      this.emotion.energy = Math.max(0, Math.min(100, this.emotion.energy + delta.energy));
    }
    if (delta.mood !== undefined) {
      this.emotion.mood = Math.max(0, Math.min(100, this.emotion.mood + delta.mood));
    }
  }

  addHistory(entry: string): void {
    this.history.push(entry);
    // Keep last 50 turns
    if (this.history.length > 50) {
      this.history = this.history.slice(-50);
    }
  }

  getHistory(): string[] {
    return [...this.history];
  }

  setProfileFact(key: string, value: string): void {
    this.profile[key] = value;
  }

  getProfile(): Record<string, string> {
    return { ...this.profile };
  }

  getState(): PersonaState {
    return {
      emotion: this.getEmotion(),
      history: this.getHistory(),
      profile: this.getProfile(),
    };
  }
}
