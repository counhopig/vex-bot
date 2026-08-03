/**
 * Skill Learner data models.
 *
 * Ported from archive behavior spec; shapes preserved for compatibility
 * with the skills system (SKILL.md frontmatter + Markdown body).
 */

/** Learning session state */
export type LearningState = "idle" | "listening" | "confirming";

/** A captured message in a learning session */
export interface LearningMessage {
  role: "user";
  content: string;
}

/** A learning session */
export interface LearningSession {
  sessionId: string;
  userId: string;
  groupId: string;
  startedAt: number;
  messages: LearningMessage[];
  summary: string;
  proposedName: string;
  proposedType: string;
  state: LearningState;
}

/** Skill type */
export type SkillType = "workflow" | "knowledge" | "tool" | "prompt";

/** A learned skill */
export interface LearnedSkill {
  skillId: string;
  name: string;
  displayName: string;
  skillType: SkillType;
  description: string;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
  sourceSession: string;
  tags: readonly string[];
  skillMdContent: string;
  additionalFiles: Readonly<Record<string, string>>;
  usageCount: number;
}

/** Runtime learning configuration — mirrors SkillLearnerConfigInfo from web/types */
export interface LearningConfig {
  autoTriggerKeywords?: string[];
  maxLearningTurns?: number;
  enableAutoLearn?: boolean;
  enableProactiveSuggest?: boolean;
  proactiveThreshold?: number;
  autoDeployToSkills?: boolean;
}
