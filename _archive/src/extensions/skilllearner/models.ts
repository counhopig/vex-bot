/**
 * Skill Learner data models
 */

/** Learning session state */
export type LearningState = "idle" | "listening" | "confirming";

/** A captured message in a learning session */
export interface LearningMessage {
  readonly role: "user";
  readonly content: string;
}

/** A learning session */
export interface LearningSession {
  readonly sessionId: string;
  readonly userId: string;
  readonly groupId: string;
  readonly startedAt: number;
  readonly messages: LearningMessage[];
  readonly summary: string;
  readonly proposedName: string;
  readonly proposedType: string;
  readonly state: LearningState;
  [key: string]: unknown;
}

/** Skill type */
export type SkillType = "workflow" | "knowledge" | "tool" | "prompt";

/** A learned skill */
export interface LearnedSkill {
  readonly skillId: string;
  readonly name: string;
  readonly displayName: string;
  readonly skillType: SkillType;
  readonly description: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly createdBy: string;
  readonly sourceSession: string;
  readonly tags: readonly string[];
  readonly skillMdContent: string;
  readonly additionalFiles: Readonly<Record<string, string>>;
  readonly usageCount: number;
}

/** Runtime learning configuration */
export interface LearningConfig {
  readonly autoTriggerKeywords: readonly string[];
  readonly maxLearningTurns: number;
  readonly enableAutoLearn: boolean;
  readonly enableProactiveSuggest: boolean;
  readonly proactiveThreshold: number;
}
