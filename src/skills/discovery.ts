import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { PromptSection } from "../context/prompt.js";

export interface SkillInfo { name: string; description: string; path: string }

export function builtinSkillsDirectory(): string {
  const alongside = fileURLToPath(new URL("./", import.meta.url));
  if (existsSync(join(alongside, "weather", "SKILL.md"))) return alongside;
  const bundled = fileURLToPath(new URL("./builtin/", import.meta.url));
  return existsSync(bundled) ? bundled : fileURLToPath(new URL("../../skills/", import.meta.url));
}

type Warn = (message: string) => void;

async function readSkills(directory: string, warn?: Warn): Promise<SkillInfo[]> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") warn?.(`Cannot read the skills directory ${directory}: ${(error as Error).message}`);
    return [];
  }
  const skills: SkillInfo[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name, "SKILL.md");
    let text: string;
    try { text = await readFile(path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") warn?.(`Cannot read the skill ${path}: ${(error as Error).message}`);
      continue;
    }
    const match = text.replace(/^\uFEFF/, "").match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!match?.[1]) continue;
    let data: unknown;
    try { data = parse(match[1]); } catch { continue; }
    if (!data || typeof data !== "object") continue;
    const { name, description } = data as { name?: unknown; description?: unknown };
    if (typeof name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64 ||
      typeof description !== "string" || !description.trim() || description.length > 1024) continue;
    skills.push({ name, description: description.trim(), path });
  }
  return skills;
}

export async function discoverSkills(options: { workspace: string; builtinDir?: string; warn?: Warn }): Promise<SkillInfo[]> {
  const byName = new Map<string, SkillInfo>();
  for (const directory of [options.builtinDir ?? builtinSkillsDirectory(), join(options.workspace, "skills")]) {
    for (const skill of await readSkills(directory, options.warn)) byName.set(skill.name, skill);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function skillsSection(workspace: string, builtinDir?: string, warn?: Warn): PromptSection {
  return async () => {
    let skills: SkillInfo[];
    try { skills = await discoverSkills({ workspace, builtinDir, warn }); }
    catch (error) { warn?.(`Skill discovery failed: ${(error as Error).message}`); return undefined; }
    if (!skills.length) return undefined;
    return [
      "## Skills",
      "When a skill applies, read its SKILL.md first with the read tool, then follow it to run its scripts. Running scripts still follows bash approval.",
      ...skills.map(({ name, description, path }) => `- ${JSON.stringify(name)}: ${JSON.stringify(description)}; path: ${JSON.stringify(path)}`),
    ].join("\n");
  };
}

/**
 * Inlines one skill's SKILL.md by name for runs without the read tool, honouring the same
 * workspace-over-bundled precedence as the skills index.
 */
export function skillBodySection(name: string, title: string, workspace: string, builtinDir?: string, warn?: Warn): PromptSection {
  return async () => {
    const skill = (await discoverSkills({ workspace, builtinDir, warn })).find((item) => item.name === name);
    if (!skill) throw new Error(`The ${name} skill is not available`);
    return `## ${title}\n${await readFile(skill.path, "utf8")}`;
  };
}
