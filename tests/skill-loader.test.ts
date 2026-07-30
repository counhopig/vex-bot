/**
 * SkillLoader tests — parseSkillContent (pure parser).
 */

import { describe, it, expect } from "vitest";

describe("parseSkillContent", () => {
  let parse: (content: string, filePath: string, source: string) => any;

  beforeAll(async () => {
    ({ parseSkillContent: parse } = await import("../src/skills/SkillLoader.js"));
  });

  it("returns null for invalid frontmatter (no closing ---)", () => {
    const r = parse("---\nname: test\n", "/skills/test/SKILL.md", "bundled");
    expect(r).toBeNull();
  });

  it("parses full frontmatter with all fields", () => {
    const content = `---
name: my-skill
title: My Skill
description: Does things
version: "1.0"
author: Alice
enabled: true
priority: 5
tags: [a, b]
eligibility:
  os: [linux, darwin]
  binaries: [git]
  envVars: [API_KEY]
---

This is the skill content.
`;

    const r = parse(content, "/skills/my-skill/SKILL.md", "bundled");
    expect(r).not.toBeNull();
    expect(r!.frontmatter.name).toBe("my-skill");
    expect(r!.frontmatter.title).toBe("My Skill");
    expect(r!.frontmatter.description).toBe("Does things");
    expect(r!.frontmatter.version).toBe("1.0");
    expect(r!.frontmatter.author).toBe("Alice");
    expect(r!.frontmatter.enabled).toBe(true);
    expect(r!.frontmatter.priority).toBe(5);
    expect(r!.frontmatter.tags).toEqual(["a", "b"]);
    expect(r!.frontmatter.eligibility?.os).toEqual(["linux", "darwin"]);
    expect(r!.frontmatter.eligibility?.binaries).toEqual(["git"]);
    expect(r!.frontmatter.eligibility?.envVars).toEqual(["API_KEY"]);
    expect(r!.content).toBe("This is the skill content.");
    expect(r!.source).toBe("bundled");
    expect(r!.filePath).toBe("/skills/my-skill/SKILL.md");
  });

  it("defaults enabled to true when not specified", () => {
    const content = `---
name: test
---
content
`;
    const r = parse(content, "/s/SKILL.md", "user");
    expect(r!.frontmatter.enabled).toBe(true);
  });

  it("sets enabled to false when explicitly false", () => {
    const content = `---
name: test
enabled: false
---
content
`;
    const r = parse(content, "/s/SKILL.md", "user");
    expect(r!.frontmatter.enabled).toBe(false);
  });

  it("falls back to directory name when no 'name' in frontmatter", () => {
    const content = `---
title: Untitled
---
content
`;
    const r = parse(content, "/skills/implied-name/SKILL.md", "workspace");
    expect(r!.frontmatter.name).toBe("implied-name");
  });

  it("handles no frontmatter — uses directory name as skill name", () => {
    const content = "Just some markdown content.";
    const r = parse(content, "/skills/hello/SKILL.md", "bundled");
    expect(r!.frontmatter.name).toBe("hello");
    expect(r!.content).toBe("Just some markdown content.");
  });

  it("parses top-level eligibility fields (os, binaries, envVars)", () => {
    const content = `---
name: test
os: [linux]
binaries: [node]
envVars: [NODE_ENV]
---
ok
`;
    const r = parse(content, "/t/SKILL.md", "bundled");
    expect(r!.frontmatter.eligibility?.os).toEqual(["linux"]);
    expect(r!.frontmatter.eligibility?.binaries).toEqual(["node"]);
    expect(r!.frontmatter.eligibility?.envVars).toEqual(["NODE_ENV"]);
  });

  it("parses moltbot-compatible metadata.openclaw.requires as eligibility", () => {
    const content = `---
name: test
metadata:
  openclaw:
    requires:
      bins: [python3]
      env: [PYTHONPATH]
---
content
`;
    const r = parse(content, "/t/SKILL.md", "bundled");
    expect(r!.frontmatter.eligibility?.binaries).toEqual(["python3"]);
    expect(r!.frontmatter.eligibility?.envVars).toEqual(["PYTHONPATH"]);
  });

  it("trims whitespace from content after frontmatter", () => {
    const content = `---
name: clean
---

  trimmed content with surrounding whitespace  

`;
    const r = parse(content, "/c/SKILL.md", "bundled");
    expect(r!.content).toBe("trimmed content with surrounding whitespace");
  });
});
