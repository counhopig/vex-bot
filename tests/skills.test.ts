import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { builtinSkillsDirectory, discoverSkills, skillBodySection, skillsSection } from "../src/skills/discovery.js";

describe("skill discovery", () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
  async function root() { const directory = await mkdtemp(join(tmpdir(), "vex-skills-")); roots.push(directory); return directory; }
  async function skill(directory: string, folder: string, text: string) {
    await mkdir(join(directory, folder), { recursive: true });
    await writeFile(join(directory, folder, "SKILL.md"), text);
  }
  const document = (name: string, description: string, body = "private skill body") => `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;

  it("discovers the bundled skills", async () => {
    const skills = await discoverSkills({ workspace: await root() });
    expect(skills.map((item) => item.name)).toEqual(["image", "link-reader", "llm-wiki", "weather"]);
    expect(builtinSkillsDirectory()).toContain("skills");
  });
  it("discovers the bundled llm-wiki skill", async () => {
    const skills = await discoverSkills({ workspace: await root() });
    const wiki = skills.find((item) => item.name === "llm-wiki");
    expect(wiki?.path).toContain(join("llm-wiki", "SKILL.md"));
    expect(wiki?.description).toMatch(/^Use when/);
  });
  it("workspace names override builtins and changes appear next round", async () => {
    const builtinDir = await root();
    const workspace = await root();
    await skill(builtinDir, "weather", document("weather", "built in"));
    await skill(join(workspace, "skills"), "local", document("weather", "user version"));
    const section = skillsSection(workspace, builtinDir);
    expect((await discoverSkills({ workspace, builtinDir }))[0]?.description).toBe("user version");
    expect(await section({ now: new Date(), windowLabel: "web" })).not.toContain("private skill body");
    await skill(join(workspace, "skills"), "notes", document("notes", "notes skill"));
    expect(await section({ now: new Date(), windowLabel: "web" })).toContain("notes skill");
  });
  it("inlines one skill body by name, preferring the workspace version", async () => {
    const builtinDir = await root();
    const workspace = await root();
    const ctx = { now: new Date(), windowLabel: "wiki" };
    await skill(builtinDir, "llm-wiki", document("llm-wiki", "built in", "bundled body"));
    const section = skillBodySection("llm-wiki", "LLM Wiki skill", workspace, builtinDir);
    expect(await section(ctx)).toMatch(/^## LLM Wiki skill\n[\s\S]*bundled body/);
    await skill(join(workspace, "skills"), "my-wiki", document("llm-wiki", "user version", "owner body"));
    expect(await section(ctx)).toContain("owner body");
    await expect(skillBodySection("missing", "Missing", workspace, builtinDir)(ctx)).rejects.toThrow("missing skill is not available");
  });
  it("skips an unreadable skill with a warning and keeps the rest", async () => {
    const workspace = await root();
    await skill(join(workspace, "skills"), "good", document("good", "works"));
    await mkdir(join(workspace, "skills", "broken", "SKILL.md"), { recursive: true });
    const warnings: string[] = [];
    const skills = await discoverSkills({ workspace, builtinDir: await root(), warn: (message) => warnings.push(message) });
    expect(skills.map((item) => item.name)).toEqual(["good"]);
    expect(warnings).toHaveLength(1);
    expect(await skillsSection(workspace, await root())({ now: new Date(), windowLabel: "web" })).toContain("good");
  });
  it("ignores malformed frontmatter and incomplete directories", async () => {
    const builtinDir = await root();
    const workspace = await root();
    await skill(builtinDir, "bad", "not frontmatter");
    await skill(builtinDir, "invalid-name", document("BAD NAME", "desc"));
    await skill(builtinDir, "invalid-yaml", "---\nname: [\n---\n");
    await skill(builtinDir, "valid", document("valid", "usable"));
    expect((await discoverSkills({ workspace, builtinDir })).map((item) => item.name)).toEqual(["valid"]);
  });
});
