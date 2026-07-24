/**
 * Persona internal types.
 */

export interface EmotionState {
  energy: number;   // 0–100
  mood: number;     // 0–100
}

export interface PersonaState {
  emotion: EmotionState;
  history: string[];
  profile: Record<string, string>;
}
