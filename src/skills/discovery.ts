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

async function readSkills(directory: string): Promise<SkillInfo[]> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const skills: SkillInfo[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name, "SKILL.md");
    let text: string;
    try { text = await readFile(path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
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

export async function discoverSkills(options: { workspace: string; builtinDir?: string }): Promise<SkillInfo[]> {
  const byName = new Map<string, SkillInfo>();
  for (const directory of [options.builtinDir ?? builtinSkillsDirectory(), join(options.workspace, "skills")]) {
    for (const skill of await readSkills(directory)) byName.set(skill.name, skill);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function skillsSection(workspace: string, builtinDir?: string): PromptSection {
  return async () => {
    const skills = await discoverSkills({ workspace, builtinDir });
    if (!skills.length) return undefined;
    return [
      "## Skills",
      "需要技能时，先用 read 读取对应 SKILL.md，再遵循其中说明运行脚本。脚本执行仍需遵守 bash 审批。",
      ...skills.map(({ name, description, path }) => `- ${JSON.stringify(name)}：${JSON.stringify(description)}；路径：${JSON.stringify(path)}`),
    ].join("\n");
  };
}
