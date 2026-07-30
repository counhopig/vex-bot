/**
 * Skills module — type definitions.
 *
 * SKILL.md format: YAML frontmatter + Markdown body.
 * 3-tier loading: bundled → user → workspace (highest override priority).
 */

export interface SkillEligibility {
  os?: string[];
  binaries?: string[];
  envVars?: string[];
}

export interface SkillFrontmatter {
  name: string;
  title?: string;
  description?: string;
  version?: string;
  author?: string;
  enabled?: boolean;
  eligibility?: SkillEligibility;
  tags?: string[];
  priority?: number;
}

export type SkillSource = "bundled" | "user" | "workspace";

export interface SkillEntry {
  frontmatter: SkillFrontmatter;
  content: string;
  filePath: string;
  source: SkillSource;
}

export interface SkillsConfig {
  enabled?: boolean;
  userDir?: string;
  workspaceDir?: string;
  disabled?: string[];
  only?: string[];
}
