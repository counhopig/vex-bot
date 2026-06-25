/**
 * SKILL.md file parser
 * Parses YAML frontmatter and markdown content
 */

import { readFile } from 'fs/promises';
import { basename, dirname } from 'path';
import { parse as parseYaml } from 'yaml';
import type { SkillEntry, SkillFrontmatter, SkillSource } from './types.js';

/**
 * Parse SKILL.md file content
 */
export function parseSkillContent(
  content: string,
  filePath: string,
  source: SkillSource
): SkillEntry | null {
  const trimmedContent = content.trim();

  // Check if frontmatter is present
  if (!trimmedContent.startsWith('---')) {
    // No frontmatter, use filename as skill name
    const name = basename(dirname(filePath));
    return {
      frontmatter: { name },
      content: trimmedContent,
      filePath,
      source,
    };
  }

  // Find frontmatter end position
  const endIndex = trimmedContent.indexOf('---', 3);
  if (endIndex === -1) {
    // Frontmatter format error
    console.warn(`Invalid frontmatter in ${filePath}`);
    return null;
  }

  // Parse frontmatter
  const yamlContent = trimmedContent.slice(3, endIndex).trim();
  let parsed: Record<string, unknown>;
  try {
    parsed = parseYaml(yamlContent) ?? {};
  } catch {
    console.warn(`Failed to parse YAML frontmatter in ${filePath}`);
    return null;
  }

  // Build frontmatter object
  const frontmatter: SkillFrontmatter = {
    name: (parsed.name as string) || basename(dirname(filePath)),
    title: parsed.title as string | undefined,
    description: parsed.description as string | undefined,
    version: parsed.version as string | undefined,
    author: parsed.author as string | undefined,
    enabled: parsed.enabled !== false, // Enabled by default
    tags: parsed.tags as string[] | undefined,
    priority: parsed.priority as number | undefined,
  };

  // Parse eligibility (prefer explicit declaration)
  if (parsed.eligibility && typeof parsed.eligibility === 'object') {
    frontmatter.eligibility = parsed.eligibility as SkillFrontmatter['eligibility'];
  } else {
    // Try parsing top-level eligibility fields
    if (parsed.os || parsed.binaries || parsed.envVars) {
      frontmatter.eligibility = {
        os: parsed.os as string[] | undefined,
        binaries: parsed.binaries as string[] | undefined,
        envVars: parsed.envVars as string[] | undefined,
      };
    }
  }

  // Compatible with moltbot format: metadata.openclaw.requires → eligibility
  if (!frontmatter.eligibility) {
    const metadata = parsed.metadata as Record<string, unknown> | undefined;
    const openclaw = metadata?.openclaw as Record<string, unknown> | undefined;
    const requires = openclaw?.requires as Record<string, unknown> | undefined;
    if (requires) {
      frontmatter.eligibility = {
        binaries: requires.bins as string[] | undefined,
        envVars: requires.env as string[] | undefined,
      };
    }
  }

  // Extract markdown content
  const markdownContent = trimmedContent.slice(endIndex + 3).trim();

  return {
    frontmatter,
    content: markdownContent,
    filePath,
    source,
  };
}

/**
 * Parse a skill from file path
 */
export async function parseSkillFile(
  filePath: string,
  source: SkillSource
): Promise<SkillEntry | null> {
  try {
    const content = await readFile(filePath, 'utf-8');
    return parseSkillContent(content, filePath, source);
  } catch (error) {
    console.error(`Failed to parse skill file ${filePath}:`, error);
    return null;
  }
}
