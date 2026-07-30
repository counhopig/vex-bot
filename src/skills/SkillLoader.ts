/**
 * SkillLoader — SKILL.md discovery, parsing, and 3-tier loading.
 *
 * Merges _archive/src/skills/parser.ts + loader.ts into a single module.
 * parseSkillContent is the pure, sync parser (testable without filesystem).
 * loadAllSkills orchestrates the 3-tier directory scan, eligibility
 * filtering, deduplication, and priority-based override.
 */

import { readFile, stat } from "fs/promises";
import { join, basename, dirname } from "path";
import { homedir } from "os";
import { glob } from "glob";
import { parse as parseYaml } from "yaml";
import type { SkillEntry, SkillFrontmatter, SkillSource, SkillsConfig, SkillEligibility } from "./types.js";

// ---------------------------------------------------------------------------
// SKILL.md parser (pure, sync — the core of the module)
// ---------------------------------------------------------------------------

/**
 * Parse a SKILL.md file's raw text content into a SkillEntry.
 * Returns null when the frontmatter is malformed or unparseable.
 */
export function parseSkillContent(
  content: string,
  filePath: string,
  source: SkillSource,
): SkillEntry | null {
  const trimmedContent = content.trim();

  // No frontmatter → whole file is content, directory name becomes skill name.
  if (!trimmedContent.startsWith("---")) {
    const name = basename(dirname(filePath));
    return {
      frontmatter: { name },
      content: trimmedContent,
      filePath,
      source,
    };
  }

  // Find frontmatter closing delimiter.
  const endIndex = trimmedContent.indexOf("---", 3);
  if (endIndex === -1) {
    return null; // invalid: no closing ---
  }

  // Parse YAML block.
  const yamlContent = trimmedContent.slice(3, endIndex).trim();
  let parsed: Record<string, unknown>;
  try {
    parsed = parseYaml(yamlContent) ?? {};
  } catch {
    return null;
  }

  // Build frontmatter — name falls back to directory name.
  const frontmatter: SkillFrontmatter = {
    name: (parsed.name as string) || basename(dirname(filePath)),
    title: parsed.title as string | undefined,
    description: parsed.description as string | undefined,
    version: parsed.version as string | undefined,
    author: parsed.author as string | undefined,
    enabled: parsed.enabled !== false,
    tags: parsed.tags as string[] | undefined,
    priority: parsed.priority as number | undefined,
  };

  // Eligibility: explicit block wins, then top-level fields, then moltbot compat.
  if (parsed.eligibility && typeof parsed.eligibility === "object") {
    frontmatter.eligibility = parsed.eligibility as SkillEligibility;
  } else if (parsed.os || parsed.binaries || parsed.envVars) {
    frontmatter.eligibility = {
      os: parsed.os as string[] | undefined,
      binaries: parsed.binaries as string[] | undefined,
      envVars: parsed.envVars as string[] | undefined,
    };
  } else {
    // Moltbot compatibility: metadata.openclaw.requires → eligibility
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

  // Extract Markdown body.
  const markdownContent = trimmedContent.slice(endIndex + 3).trim();

  return {
    frontmatter,
    content: markdownContent,
    filePath,
    source,
  };
}

// ---------------------------------------------------------------------------
// File parser (async I/O wrapper around parseSkillContent)
// ---------------------------------------------------------------------------

async function parseSkillFile(
  filePath: string,
  source: SkillSource,
): Promise<SkillEntry | null> {
  try {
    const content = await readFile(filePath, "utf-8");
    return parseSkillContent(content, filePath, source);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Eligibility checks (ported from archive — validates env vars + binaries)
// ---------------------------------------------------------------------------

async function directoryExists(path: string): Promise<boolean> {
  try {
    const stats = await stat(path);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

async function binaryExists(name: string): Promise<boolean> {
  // Only allow valid executable names (shell metacharacter prevention).
  if (!/^[A-Za-z0-9._+-]+$/.test(name)) return false;
  const { execFileSync } = await import("child_process");
  const lookup = process.platform === "win32" ? "where" : "which";
  try {
    execFileSync(lookup, [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function checkEligibility(skill: SkillEntry): Promise<boolean> {
  const { eligibility } = skill.frontmatter;
  if (!eligibility) return true;

  // OS check.
  if (eligibility.os && eligibility.os.length > 0) {
    const currentOS = process.platform;
    const osMap: Record<string, string[]> = {
      darwin: ["darwin", "macos", "mac"],
      linux: ["linux"],
      win32: ["win32", "windows", "win"],
    };
    const aliases = osMap[currentOS] || [currentOS];
    if (!eligibility.os.some((os) => aliases.includes(os.toLowerCase()))) {
      return false;
    }
  }

  // Binary check.
  if (eligibility.binaries && eligibility.binaries.length > 0) {
    for (const binary of eligibility.binaries) {
      if (!(await binaryExists(binary))) return false;
    }
  }

  // Env var check.
  if (eligibility.envVars && eligibility.envVars.length > 0) {
    for (const envVar of eligibility.envVars) {
      if (!process.env[envVar]) return false;
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Directory scanning
// ---------------------------------------------------------------------------

async function loadSkillsFromDirectory(
  directory: string,
  source: SkillSource,
): Promise<SkillEntry[]> {
  if (!(await directoryExists(directory))) return [];

  const skills: SkillEntry[] = [];
  try {
    const pattern = join(directory, "**/SKILL.md");
    const files = await glob(pattern, { nodir: true });

    for (const filePath of files) {
      const skill = await parseSkillFile(filePath, source);
      if (skill) skills.push(skill);
    }
  } catch {
    // Silently skip unreadable directories.
  }

  return skills;
}

// ---------------------------------------------------------------------------
// Default directories
// ---------------------------------------------------------------------------

export function getDefaultSkillsDirs(): {
  bundled: string;
  user: string;
  workspace: string;
} {
  // import.meta.dirname points to dist/ or src/ at test time; resolve the
  // skills/ directory relative to the project root.
  const bundled = join(import.meta.dirname ?? __dirname, "../../skills");
  return {
    bundled,
    user: join(homedir(), ".vex", "skills"),
    workspace: join(process.cwd(), ".vex", "skills"),
  };
}

// ---------------------------------------------------------------------------
// Main loader
// ---------------------------------------------------------------------------

const sourceRank: Record<SkillSource, number> = {
  workspace: 0,
  user: 1,
  bundled: 2,
};

/**
 * Load all skills from 3 tiers: bundled → user → workspace.
 * Workspace overrides user, user overrides bundled (by name).
 * Applies eligibility filtering, config-based disabled/only lists,
 * and priority-based sorting.
 */
export async function loadAllSkills(
  config?: SkillsConfig,
): Promise<SkillEntry[]> {
  const dirs = getDefaultSkillsDirs();
  const allSkills: SkillEntry[] = [];

  // 1. Bundled
  allSkills.push(...(await loadSkillsFromDirectory(dirs.bundled, "bundled")));

  // 2. User (config override wins)
  const userDir = config?.userDir ? config.userDir : dirs.user;
  allSkills.push(...(await loadSkillsFromDirectory(userDir, "user")));

  // 3. Workspace (config override wins)
  const workspaceDir = config?.workspaceDir
    ? config.workspaceDir
    : dirs.workspace;
  allSkills.push(
    ...(await loadSkillsFromDirectory(workspaceDir, "workspace")),
  );

  // Filter by frontmatter.enabled + config.disabled / config.only
  let filtered = allSkills.filter((skill) => {
    if (skill.frontmatter.enabled === false) return false;
    if (config?.disabled?.includes(skill.frontmatter.name)) return false;
    if (config?.only && config.only.length > 0) {
      return config.only.includes(skill.frontmatter.name);
    }
    return true;
  });

  // Eligibility filter
  const eligible: SkillEntry[] = [];
  for (const skill of filtered) {
    if (await checkEligibility(skill)) {
      eligible.push(skill);
    }
  }

  // Sort: lower priority first; when equal, more local source wins.
  eligible.sort((a, b) => {
    const pa = a.frontmatter.priority ?? 100;
    const pb = b.frontmatter.priority ?? 100;
    if (pa !== pb) return pa - pb;
    return sourceRank[a.source] - sourceRank[b.source];
  });

  // Deduplicate by name (first entry wins after sort).
  const seen = new Map<string, SkillEntry>();
  for (const skill of eligible) {
    if (!seen.has(skill.frontmatter.name)) {
      seen.set(skill.frontmatter.name, skill);
    }
  }

  return Array.from(seen.values());
}
