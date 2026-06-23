---
name: clawhub
title: ClawdHub Skills Manager
description: Search, install and manage skills from ClawdHub
version: "1.0"
tags:
  - clawhub
  - skills
  - package-manager
eligibility:
  binaries:
    - clawhub
---

You have access to the `clawhub` CLI tool for managing skills from [ClawdHub](https://clawhub.ai), a community hub for sharing AI assistant skills.

## Common Commands

### Search for skills

```bash
clawhub search <query>
```

### Install a skill

Always use `--workdir` to install into the vex user skills directory:

```bash
clawhub install <slug> --workdir ~/.vex/skills
```

### List installed skills

```bash
clawhub list
```

### Update installed skills

```bash
clawhub update --workdir ~/.vex/skills
```

### Publish a skill

```bash
clawhub publish <directory>
```

## Important Notes

- Always install skills with `--workdir ~/.vex/skills` so vex can discover and load them.
- After installing a skill, inform the user that vex needs to be restarted (or skills reloaded) for the new skill to take effect.
- When the user asks to find or install a skill, use `clawhub search` to help them discover available options on ClawdHub.
