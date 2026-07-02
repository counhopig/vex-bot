/**
 * Skills loader
 * Loads SKILL.md files from different directories
 */

import { readdir, stat, access } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { glob } from 'glob';
import type { SkillEntry, SkillSource, SkillsConfig } from './types.js';
import { parseSkillFile } from './parser.js';
import { expandHomePath } from '../utils/path.js';

/**
 * Check if a directory exists
 */
async function directoryExists(path: string): Promise<boolean> {
  try {
    const stats = await stat(path);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Check if a binary executable exists
 */
async function binaryExists(name: string): Promise<boolean> {
  // Only allow valid executable names, prevent shell metacharacter injection from SKILL.md
  if (!/^[A-Za-z0-9._+-]+$/.test(name)) {
    return false;
  }
  const { execFileSync } = await import('child_process');
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  try {
    execFileSync(lookup, [name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether a skill meets eligibility conditions
 */
async function checkEligibility(skill: SkillEntry): Promise<boolean> {
  const { eligibility } = skill.frontmatter;
  if (!eligibility) return true;

  // Check operating system
  if (eligibility.os && eligibility.os.length > 0) {
    const currentOS = process.platform;
    const osMap: Record<string, string[]> = {
      darwin: ['darwin', 'macos', 'mac'],
      linux: ['linux'],
      win32: ['win32', 'windows', 'win'],
    };
    const aliases = osMap[currentOS] || [currentOS];
    const matched = eligibility.os.some(os =>
      aliases.includes(os.toLowerCase())
    );
    if (!matched) return false;
  }

  // Check binary executables
  if (eligibility.binaries && eligibility.binaries.length > 0) {
    for (const binary of eligibility.binaries) {
      if (!(await binaryExists(binary))) {
        return false;
      }
    }
  }

  // Check environment variables
  if (eligibility.envVars && eligibility.envVars.length > 0) {
    for (const envVar of eligibility.envVars) {
      if (!process.env[envVar]) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Load all skills from a directory
 */
async function loadSkillsFromDirectory(
  directory: string,
  source: SkillSource
): Promise<SkillEntry[]> {
  if (!(await directoryExists(directory))) {
    return [];
  }

  const skills: SkillEntry[] = [];

  try {
    // Find all SKILL.md files
    const pattern = join(directory, '**/SKILL.md');
    const files = await glob(pattern, { nodir: true });

    for (const filePath of files) {
      const skill = await parseSkillFile(filePath, source);
      if (skill) {
        skills.push(skill);
      }
    }
  } catch (error) {
    console.error(`Failed to load skills from ${directory}:`, error);
  }

  return skills;
}

/**
 * Get default skills directories
 */
export function getDefaultSkillsDirs(): {
  bundled: string;
  user: string;
  workspace: string;
} {
  return {
    bundled: join(import.meta.dirname || __dirname, '../../skills'),
    user: join(homedir(), '.vex', 'skills'),
    workspace: join(process.cwd(), '.vex', 'skills'),
  };
}

/**
 * Load all skills
 */
export async function loadAllSkills(
  config?: SkillsConfig
): Promise<SkillEntry[]> {
  const dirs = getDefaultSkillsDirs();
  const allSkills: SkillEntry[] = [];

  // Load in priority order: bundled -> user -> workspace
  // workspace has highest priority, can override skills with the same name

  // 1. Load bundled skills
  const bundledSkills = await loadSkillsFromDirectory(dirs.bundled, 'bundled');
  allSkills.push(...bundledSkills);

  // 2. Load user skills
  const userDir = config?.userDir ? expandHomePath(config.userDir) : dirs.user;
  const userSkills = await loadSkillsFromDirectory(userDir, 'user');
  allSkills.push(...userSkills);

  // 3. Load workspace skills
  const workspaceDir = config?.workspaceDir ? expandHomePath(config.workspaceDir) : dirs.workspace;
  const workspaceSkills = await loadSkillsFromDirectory(workspaceDir, 'workspace');
  allSkills.push(...workspaceSkills);

  // Filter disabled skills
  let filteredSkills = allSkills.filter(skill => {
    // Check enabled field in frontmatter
    if (skill.frontmatter.enabled === false) return false;

    // Check disabled list in config
    if (config?.disabled?.includes(skill.frontmatter.name)) return false;

    // If only is set, only enable skills in that list
    if (config?.only && config.only.length > 0) {
      return config.only.includes(skill.frontmatter.name);
    }

    return true;
  });

  // Check eligibility and filter
  const eligibleSkills: SkillEntry[] = [];
  for (const skill of filteredSkills) {
    if (await checkEligibility(skill)) {
      eligibleSkills.push(skill);
    }
  }

  // Sort by priority
  eligibleSkills.sort((a, b) => {
    const priorityA = a.frontmatter.priority ?? 100;
    const priorityB = b.frontmatter.priority ?? 100;
    return priorityA - priorityB;
  });

  // Deduplicate (keep highest-priority for same-named skills)
  const seen = new Map<string, SkillEntry>();
  for (const skill of eligibleSkills) {
    const name = skill.frontmatter.name;
    if (!seen.has(name)) {
      seen.set(name, skill);
    }
  }

  return Array.from(seen.values());
}
