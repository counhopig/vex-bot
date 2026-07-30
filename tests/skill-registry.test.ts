/**
 * SkillRegistry + SkillInjector tests.
 */

import { describe, it, expect } from "vitest";
import type { SkillEntry } from "../src/skills/types.js";

function makeEntry(name: string, overrides?: Partial<SkillEntry>): SkillEntry {
  return {
    frontmatter: { name, title: name, priority: overrides?.frontmatter?.priority },
    content: `Content for ${name}`,
    filePath: `/skills/${name}/SKILL.md`,
    source: "bundled",
    ...overrides,
  } as SkillEntry;
}

describe("SkillRegistry", () => {
  let SkillRegistry: typeof import("../src/skills/SkillRegistry.js").SkillRegistry;

  beforeAll(async () => {
    ({ SkillRegistry } = await import("../src/skills/SkillRegistry.js"));
  });

  it("starts empty", () => {
    const r = new SkillRegistry();
    expect(r.getAll()).toEqual([]);
  });

  it("register adds an entry and getAll returns it", () => {
    const r = new SkillRegistry();
    const e = makeEntry("greeting");
    r.register(e);
    expect(r.getAll()).toEqual([e]);
  });

  it("get retrieves by name", () => {
    const r = new SkillRegistry();
    const e = makeEntry("test-skill");
    r.register(e);
    expect(r.get("test-skill")).toBe(e);
    expect(r.get("unknown")).toBeUndefined();
  });

  it("register overwrites same-named skill", () => {
    const r = new SkillRegistry();
    r.register(makeEntry("dup", { content: "first" }));
    r.register(makeEntry("dup", { content: "second" }));
    expect(r.get("dup")!.content).toBe("second");
    expect(r.getAll()).toHaveLength(1);
  });

  it("load replaces all entries", async () => {
    const r = new SkillRegistry();
    r.register(makeEntry("old"));
    await r.load([makeEntry("new"), makeEntry("other")]);
    expect(r.getAll()).toHaveLength(2);
    expect(r.get("old")).toBeUndefined();
    expect(r.get("new")).toBeDefined();
  });

  it("is independent between instances", () => {
    const r1 = new SkillRegistry();
    const r2 = new SkillRegistry();
    r1.register(makeEntry("only-r1"));
    expect(r2.getAll()).toEqual([]);
  });
});

describe("SkillInjector", () => {
  let SkillRegistry: typeof import("../src/skills/SkillRegistry.js").SkillRegistry;
  let buildPrompt: typeof import("../src/skills/SkillInjector.js").buildPrompt;

  beforeAll(async () => {
    ({ SkillRegistry } = await import("../src/skills/SkillRegistry.js"));
    ({ buildPrompt } = await import("../src/skills/SkillInjector.js"));
  });

  it("returns empty string for empty registry", () => {
    const r = new SkillRegistry();
    expect(buildPrompt(r)).toBe("");
  });

  it("builds prompt sections for each skill", () => {
    const r = new SkillRegistry();
    r.register(makeEntry("s1", { frontmatter: { name: "s1", title: "Skill One", description: "Does X" }, content: "Do this." }));
    r.register(makeEntry("s2", { frontmatter: { name: "s2", title: "Skill Two" }, content: "Do that." }));

    const prompt = buildPrompt(r);
    expect(prompt).toContain("# Available Skills");
    expect(prompt).toContain("## Skill: Skill One - Does X");
    expect(prompt).toContain("Do this.");
    expect(prompt).toContain("## Skill: Skill Two");
    expect(prompt).toContain("Do that.");
    expect(prompt).toContain("https://clawhub.ai");
  });

  it("uses name as title fallback", () => {
    const r = new SkillRegistry();
    r.register(makeEntry("bare", { frontmatter: { name: "bare" } }));
    const prompt = buildPrompt(r);
    expect(prompt).toContain("## Skill: bare");
  });
});
