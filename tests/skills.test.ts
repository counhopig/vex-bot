/**
 * Skills 解析器测试
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseSkillContent } from "../src/skills/parser.js";
import { loadAllSkills } from "../src/skills/loader.js";

describe("skills/parser", () => {
  describe("parseSkillContent", () => {
    it("should parse skill with full frontmatter", () => {
      const content = `---
name: test-skill
title: Test Skill
description: A test skill for testing
version: "1.0"
author: Test Author
enabled: true
priority: 10
tags:
  - test
  - demo
---

This is the skill content.

It supports **markdown**.
`;

      const result = parseSkillContent(content, "/path/to/skill/SKILL.md", "user");

      expect(result).not.toBeNull();
      expect(result!.frontmatter.name).toBe("test-skill");
      expect(result!.frontmatter.title).toBe("Test Skill");
      expect(result!.frontmatter.description).toBe("A test skill for testing");
      expect(result!.frontmatter.version).toBe("1.0");
      expect(result!.frontmatter.author).toBe("Test Author");
      expect(result!.frontmatter.enabled).toBe(true);
      expect(result!.frontmatter.priority).toBe(10);
      expect(result!.frontmatter.tags).toEqual(["test", "demo"]);
      expect(result!.content).toContain("This is the skill content.");
      expect(result!.content).toContain("**markdown**");
      expect(result!.source).toBe("user");
    });

    it("should parse skill with minimal frontmatter", () => {
      const content = `---
name: minimal
---

Content only.
`;

      const result = parseSkillContent(content, "/path/to/minimal/SKILL.md", "bundled");

      expect(result).not.toBeNull();
      expect(result!.frontmatter.name).toBe("minimal");
      expect(result!.frontmatter.enabled).toBe(true); // default
      expect(result!.content).toBe("Content only.");
    });

    it("should use directory name when name is missing", () => {
      const content = `---
title: No Name Skill
---

Content here.
`;

      const result = parseSkillContent(content, "/path/to/my-skill/SKILL.md", "workspace");

      expect(result).not.toBeNull();
      expect(result!.frontmatter.name).toBe("my-skill");
    });

    it("should handle content without frontmatter", () => {
      const content = "Just plain content without frontmatter.";

      const result = parseSkillContent(content, "/path/to/simple/SKILL.md", "user");

      expect(result).not.toBeNull();
      expect(result!.frontmatter.name).toBe("simple");
      expect(result!.content).toBe("Just plain content without frontmatter.");
    });

    it("should parse boolean values correctly", () => {
      const content = `---
name: bool-test
enabled: false
---

Content.
`;

      const result = parseSkillContent(content, "/path/SKILL.md", "user");

      expect(result).not.toBeNull();
      expect(result!.frontmatter.enabled).toBe(false);
    });

    it("should parse numeric values correctly", () => {
      const content = `---
name: num-test
priority: 5
---

Content.
`;

      const result = parseSkillContent(content, "/path/SKILL.md", "user");

      expect(result).not.toBeNull();
      expect(result!.frontmatter.priority).toBe(5);
    });

    it("should parse quoted strings correctly", () => {
      const content = `---
name: "quoted-name"
version: '2.0'
---

Content.
`;

      const result = parseSkillContent(content, "/path/SKILL.md", "user");

      expect(result).not.toBeNull();
      expect(result!.frontmatter.name).toBe("quoted-name");
      expect(result!.frontmatter.version).toBe("2.0");
    });

    it("should handle empty content after frontmatter", () => {
      const content = `---
name: empty-content
---
`;

      const result = parseSkillContent(content, "/path/SKILL.md", "user");

      expect(result).not.toBeNull();
      expect(result!.frontmatter.name).toBe("empty-content");
      expect(result!.content).toBe("");
    });

    it("should return null for invalid frontmatter (no closing ---)", () => {
      const content = `---
name: broken
Content without closing frontmatter.
`;

      const result = parseSkillContent(content, "/path/SKILL.md", "user");

      expect(result).toBeNull();
    });

    it("should handle multiline content correctly", () => {
      const content = `---
name: multiline
---

Line 1

Line 2

Line 3
`;

      const result = parseSkillContent(content, "/path/SKILL.md", "user");

      expect(result).not.toBeNull();
      expect(result!.content).toContain("Line 1");
      expect(result!.content).toContain("Line 2");
      expect(result!.content).toContain("Line 3");
    });

    it("should preserve markdown formatting in content", () => {
      const content = `---
name: markdown-test
---

# Heading

- Item 1
- Item 2

\`\`\`javascript
const x = 1;
\`\`\`
`;

      const result = parseSkillContent(content, "/path/SKILL.md", "user");

      expect(result).not.toBeNull();
      expect(result!.content).toContain("# Heading");
      expect(result!.content).toContain("- Item 1");
      expect(result!.content).toContain("```javascript");
    });
  });
});

describe("skills/loader", () => {
  it("workspace skill overrides a same-named user skill at equal priority", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "vex-skill-override-"));
    const userDir = path.join(base, "user");
    const workspaceDir = path.join(base, "workspace");

    try {
      for (const [dir, marker] of [[userDir, "from-user"], [workspaceDir, "from-workspace"]] as const) {
        const skillDir = path.join(dir, "dupe");
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(path.join(skillDir, "SKILL.md"), `---\nname: dupe\n---\n\n${marker}\n`);
      }

      const skills = await loadAllSkills({ userDir, workspaceDir, only: ["dupe"] });

      expect(skills).toHaveLength(1);
      expect(skills[0].content).toBe("from-workspace");
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("a lower priority number beats source precedence for same-named skills", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "vex-skill-priority-"));
    const userDir = path.join(base, "user");
    const workspaceDir = path.join(base, "workspace");

    try {
      const userSkillDir = path.join(userDir, "dupe");
      fs.mkdirSync(userSkillDir, { recursive: true });
      fs.writeFileSync(path.join(userSkillDir, "SKILL.md"), "---\nname: dupe\npriority: 1\n---\n\nfrom-user\n");

      const workspaceSkillDir = path.join(workspaceDir, "dupe");
      fs.mkdirSync(workspaceSkillDir, { recursive: true });
      fs.writeFileSync(path.join(workspaceSkillDir, "SKILL.md"), "---\nname: dupe\n---\n\nfrom-workspace\n");

      const skills = await loadAllSkills({ userDir, workspaceDir, only: ["dupe"] });

      expect(skills).toHaveLength(1);
      expect(skills[0].content).toBe("from-user");
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("expands home directory shorthand for configured skill directories", async () => {
    const dirName = `.vex-skill-expand-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const skillDir = path.join(os.homedir(), dirName, "home-skill");
    const literalDir = path.join(process.cwd(), "~", dirName);

    try {
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, "SKILL.md"),
        "---\nname: home-skill\n---\n\nLoaded from home shorthand.\n",
      );

      const skills = await loadAllSkills({
        userDir: `~/${dirName}`,
        workspaceDir: path.join(os.tmpdir(), "vex-no-workspace-skills"),
        only: ["home-skill"],
      });

      expect(skills.some((skill) => skill.frontmatter.name === "home-skill")).toBe(true);
      expect(fs.existsSync(literalDir)).toBe(false);
    } finally {
      fs.rmSync(path.join(os.homedir(), dirName), { recursive: true, force: true });
      fs.rmSync(literalDir, { recursive: true, force: true });
    }
  });
});
