/**
 * Skills module type definitions
 * Simplified implementation based on moltbot's Skills architecture
 */

/**
 * Skill eligibility - used to filter whether a skill is available
 */
export interface SkillEligibility {
  /** Supported operating systems */
  os?: string[];
  /** Required binary executable names */
  binaries?: string[];
  /** Required environment variable names */
  envVars?: string[];
}

/**
 * YAML frontmatter definition for SKILL.md files
 */
export interface SkillFrontmatter {
  /** Unique skill identifier */
  name: string;
  /** Skill display name */
  title?: string;
  /** Short skill description */
  description?: string;
  /** Skill version */
  version?: string;
  /** Skill author */
  author?: string;
  /** Whether this skill is enabled */
  enabled?: boolean;
  /** Eligibility conditions */
  eligibility?: SkillEligibility;
  /** Keyword tags for matching */
  tags?: string[];
  /** Priority - lower numbers are higher priority */
  priority?: number;
}

/**
 * Parsed skill entry
 */
export interface SkillEntry {
  /** Skill metadata */
  frontmatter: SkillFrontmatter;
  /** Skill content (markdown format prompt) */
  content: string;
  /** Skill file path */
  filePath: string;
  /** Skill source directory */
  source: SkillSource;
}

/**
 * Skill source type
 */
export type SkillSource = 'bundled' | 'user' | 'workspace';

/**
 * Skills configuration
 */
export interface SkillsConfig {
  /** Whether skills feature is enabled */
  enabled?: boolean;
  /** User skills directory path (default ~/.vex/skills) */
  userDir?: string;
  /** Workspace skills directory path (default ./.vex/skills) */
  workspaceDir?: string;
  /** List of disabled skill names */
  disabled?: string[];
  /** List of only-allowed skill names (if set, all others are disabled) */
  only?: string[];
}

/**
 * Skills registry interface
 */
export interface SkillsRegistry {
  /** Get all loaded skills */
  getAll(): SkillEntry[];
  /** Get a skill by name */
  get(name: string): SkillEntry | undefined;
  /** Get eligible skills */
  getEligible(): SkillEntry[];
  /** Build skills prompt */
  buildPrompt(): string;
  /** Reload skills */
  reload(): Promise<void>;
}
