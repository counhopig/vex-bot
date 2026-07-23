import { EmotionState } from "../models.js";
import type { UserData } from "../storage.js";

/** Get emotion state from user data */
export function emotionGetEmotion(data: UserData, _userId: string): EmotionState {
  const emotionData = data.emotion;
  if (emotionData) {
    return EmotionState.fromDict(emotionData);
  }
  return new EmotionState();
}

/** Get a single dimension value from emotion state */
export function emotionGetEmotionValue(data: UserData, dimension: string): number {
  const emotion = emotionGetEmotion(data, "");
  switch (dimension) {
    case "energy":
      return emotion.energy;
    case "mood":
      return emotion.mood;
    case "socialNeed":
      return emotion.socialNeed;
    default:
      return 0;
  }
}

/** Merge updates into emotion data in-place */
export function emotionUpdateEmotion(
  data: UserData,
  _userId: string,
  updates: Record<string, unknown>,
): void {
  const existing = data.emotion ?? {};
  Object.assign(existing, updates);
  data.emotion = existing;
}
