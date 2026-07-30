/**
 * SkillInjector — builds the skills section of the system prompt.
 *
 * Split from the archive's SkillsRegistry.buildPrompt() so the registry
 * stays a pure data container and prompt assembly is a separate concern.
 */

import type { SkillRegistry } from "./SkillRegistry.js";

/** Build a prompt block from all registered skills. Returns "" when empty. */
export function buildPrompt(registry: SkillRegistry): string {
  const skills = registry.getAll();
  if (skills.length === 0) return "";

  const sections: string[] = [];
  sections.push("# Available Skills\n");
  sections.push(
    "The following skills provide you with specialized knowledge and instructions:\n",
  );

  for (const skill of skills) {
    const { frontmatter, content } = skill;
    const title = frontmatter.title || frontmatter.name;
    const description = frontmatter.description
      ? ` - ${frontmatter.description}`
      : "";

    sections.push(`## Skill: ${title}${description}\n`);

    if (content) {
      sections.push(content);
    }

    sections.push("");
  }

  sections.push("---\n");
  sections.push("Find new skills: https://clawhub.ai\n");

  return sections.join("\n");
}
