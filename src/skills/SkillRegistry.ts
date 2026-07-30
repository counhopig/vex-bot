/**
 * SkillRegistry — per-Agent skill registry (class-based, not process-global).
 *
 * Architecture doc principle #5: each Agent owns its SkillRegistry instance.
 * The archive's `createSkillsRegistry()` returned a singleton-like closure;
 * this is a proper class with independent instances.
 */

import type { SkillEntry } from "./types.js";

export class SkillRegistry {
  private skills: SkillEntry[] = [];

  register(entry: SkillEntry): void {
    const i = this.skills.findIndex(
      (s) => s.frontmatter.name === entry.frontmatter.name,
    );
    if (i >= 0) {
      this.skills[i] = entry;
    } else {
      this.skills.push(entry);
    }
  }

  get(name: string): SkillEntry | undefined {
    return this.skills.find((s) => s.frontmatter.name === name);
  }

  getAll(): SkillEntry[] {
    return [...this.skills];
  }

  /**
   * Replace the entire skill list (used after loadAllSkills).
   * Unlike register(), this atomically replaces — old entries that
   * no longer exist on disk are dropped.
   */
  async load(entries: SkillEntry[]): Promise<void> {
    this.skills = [...entries];
  }
}
