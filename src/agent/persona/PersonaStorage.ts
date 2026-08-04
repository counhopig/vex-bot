/**
 * PersonaStorage — per-Agent persona state with optional profile persistence.
 *
 * Holds emotion, conversation history, and profile facts for one Agent
 * instance. Profile facts can be persisted to a per-user JSON file; emotion
 * and recent history intentionally remain ephemeral.
 *
 * Architecture doc: PersonaStorage is per-Agent, not per-owner-keyed via a
 * process-global Map. When the Agent is destroyed, its storage is destroyed.
 */

import type { EmotionState, PersonaState } from "./models.js";
import { dirname } from "path";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { getChildLogger } from "../../utils/logger.js";

const logger = getChildLogger("persona-storage");

export class PersonaStorage {
  private emotion: EmotionState = { energy: 75, mood: 60 };
  private history: string[] = [];
  private profile: Record<string, string> = {};

  constructor(private readonly profileFile?: string) {
    if (!profileFile || !existsSync(profileFile)) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(profileFile, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        this.profile = Object.fromEntries(
          Object.entries(parsed).filter((entry): entry is [string, string] =>
            typeof entry[1] === "string"),
        );
      }
    } catch (error) {
      logger.warn({ error, profileFile }, "Failed to load persona profile");
    }
  }

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
    this.saveProfile();
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

  private saveProfile(): void {
    if (!this.profileFile) return;
    try {
      mkdirSync(dirname(this.profileFile), { recursive: true });
      const tempFile = `${this.profileFile}.tmp`;
      writeFileSync(tempFile, JSON.stringify(this.profile, null, 2), "utf8");
      renameSync(tempFile, this.profileFile);
    } catch (error) {
      logger.error({ error, profileFile: this.profileFile }, "Failed to save persona profile");
    }
  }
}
