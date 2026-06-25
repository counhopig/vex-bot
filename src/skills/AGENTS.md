# Skills Module

SKILL.md injection system. Parses YAML frontmatter + Markdown skill files from 3-tier directories, builds prompt segments injected into the system prompt at startup.

## STRUCTURE

```
skills/
├── types.ts       # SkillFrontmatter, SkillEntry, SkillsConfig, SkillsRegistry, SkillSource
├── parser.ts      # parseSkillContent() / parseSkillFile(): YAML frontmatter + Markdown extraction
├── loader.ts      # loadAllSkills() / getDefaultSkillsDirs(): 3-tier scan, eligibility, dedup, sort
├── registry.ts    # createSkillsRegistry() / initSkills(): set/get, buildPrompt(), reload()
└── index.ts       # Barrel
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Data shapes | `types.ts` | `SkillFrontmatter`, `SkillEntry`, `SkillsConfig`, `SkillsRegistry` |
| Parse a SKILL.md | `parser.ts` | `parseSkillContent(content, filePath, source)` returns `SkillEntry | null` |
| Load from disk | `loader.ts` | `loadAllSkills(config?)` orchestrates 3-tier scan + filter + dedup |
| Build prompt | `registry.ts` | `buildPrompt()` assembles `## Skill: <title>` sections from all entries |
| Init at startup | `registry.ts` | `initSkills(config?)` creates registry, calls `reload()`, returns `SkillsRegistry` |
| Custom dirs | `loader.ts` | `SkillsConfig.userDir` / `SkillsConfig.workspaceDir` override defaults |

## SKILL FILE FORMAT

Each skill lives in its own directory containing a `SKILL.md` file:

```markdown
---
name: my-skill
title: My Skill
description: What this skill does
version: "1.0"
enabled: true
priority: 10
tags: [tag1, tag2]
eligibility:
  os: [linux, darwin]
  binaries: [git]
  envVars: [MY_API_KEY]
---

Skill instructions as Markdown content here.
```

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `name` | string | no* | Falls back to directory name |
| `title` | string | no | `name` |
| `description` | string | no | — |
| `version` | string | no | — |
| `enabled` | boolean | no | `true` |
| `priority` | number | no | `100` (lower = higher priority) |
| `tags` | string[] | no | — |
| `eligibility` | object | no | Checked at load: `os`, `binaries`, `envVars` |

If no `---` frontmatter is present, the directory name becomes the skill name and the entire file is treated as content. Moltbot-compatible `metadata.openclaw.requires` blocks are also parsed as a fallback eligibility source.

## LOADING ORDER

Skills load in 3 tiers (lowest to highest override priority):

| Priority | Source | Default Directory | Override |
|----------|--------|-------------------|----------|
| 1 (lowest) | bundled | `<module>/skills/` | — |
| 2 | user | `~/.vex/skills/` | Overrides bundled by `name` |
| 3 (highest) | workspace | `./.vex/skills/` | Overrides user + bundled by `name` |

Within each tier, `glob('**/SKILL.md')` finds all skill files. After loading, the pipeline applies sequentially: (1) filter by `enabled` frontmatter field, (2) filter by `disabled[]` config list, (3) if `only[]` is set, keep only listed names, (4) check eligibility (os/binaries/envVars), (5) sort by `priority` ascending, (6) deduplicate (first-seen wins, so workspace beats user beats bundled).

## CONVENTIONS

- `parseSkillContent()` is synchronous, pure; `parseSkillFile()` wraps it with async file I/O
- Eligibility checks run at load time, not lazily — ineligible skills are silently dropped
- `buildPrompt()` always emits footers with the ClawHub link; returns empty string when no skills loaded
- `getEligible()` is currently an alias for `getAll()` since ineligible skills are already filtered during load

## ANTI-PATTERNS

- **NEVER import `yaml` outside this module** — parsing is encapsulated in `parser.ts`
- **NEVER modify `skills[]` array directly** — go through `reload()` or the registry factory
- **NEVER assume `name` uniqueness without dedup** — same-name skills across tiers resolve to highest priority source
