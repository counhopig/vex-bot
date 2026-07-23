/**
 * Skills registry
 * Manages loaded skills, builds prompt
 */

import type { SkillEntry, SkillsConfig, SkillsRegistry } from './types.js';
import { loadAllSkills } from './loader.js';

/**
 * Create a skills registry instance
 */
export function createSkillsRegistry(config?: SkillsConfig): SkillsRegistry {
  let skills: SkillEntry[] = [];
  let loaded = false;

  return {
    getAll(): SkillEntry[] {
      return [...skills];
    },

    get(name: string): SkillEntry | undefined {
      return skills.find(s => s.frontmatter.name === name);
    },

    getEligible(): SkillEntry[] {
      // loadAllSkills has already filtered ineligible skills
      return [...skills];
    },

    buildPrompt(): string {
      if (skills.length === 0) return '';

      const sections: string[] = [];
      sections.push('# Available Skills\n');
      sections.push('The following skills provide you with specialized knowledge and instructions:\n');

      for (const skill of skills) {
        const { frontmatter, content } = skill;
        const title = frontmatter.title || frontmatter.name;
        const description = frontmatter.description
          ? ` - ${frontmatter.description}`
          : '';

        sections.push(`## Skill: ${title}${description}\n`);

        if (content) {
          sections.push(content);
        }

        sections.push(''); // Blank line separator
      }

      sections.push('---\n');
      sections.push('Find new skills: https://clawhub.ai\n');

      return sections.join('\n');
    },

    async reload(): Promise<void> {
      skills = await loadAllSkills(config);
      loaded = true;
    },
  };
}

/**
 * Initialize and load skills
 */
export async function initSkills(
  config?: SkillsConfig
): Promise<SkillsRegistry> {
  const registry = createSkillsRegistry(config);
  await registry.reload();
  return registry;
}
