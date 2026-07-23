/**
 * Skill Learner storage layer
 *
 * Sessions: per-user JSON via createExtensionStore
 * Skills: backed up under ~/.vex/extensions/skilllearner/skills/
 * Deployed to: ~/.vex/skills/<name>/SKILL.md
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { homedir } from "os";
import { createExtensionStore } from "../common/json-store.js";
import type { LearningSession, LearnedSkill } from "./models.js";
import { getChildLogger } from "../../utils/logger.js";

const logger = getChildLogger("skilllearner:storage");

const sessionStore = createExtensionStore<LearningSession>("skilllearner");

const SKILL_LEARNER_DIR = join(homedir(), ".vex", "extensions", "skilllearner");
const SKILLS_BACKUP_DIR = join(SKILL_LEARNER_DIR, "skills");
const SKILLS_DEPLOY_DIR = join(homedir(), ".vex", "skills");

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function sessionKey(userId: string, groupId: string): string {
  return groupId ? `${groupId}:${userId}` : userId;
}

export class SkillStorage {
  private activeSessions = new Map<string, LearningSession>();

  createSession(userId: string, groupId: string): LearningSession {
    const session: LearningSession = {
      sessionId: Math.random().toString(36).slice(2, 10),
      userId,
      groupId,
      startedAt: Date.now(),
      messages: [],
      summary: "",
      proposedName: "",
      proposedType: "",
      state: "listening",
    };
    const key = sessionKey(userId, groupId);
    this.activeSessions.set(key, session);
    sessionStore.set(`session:${session.sessionId}`, session);
    logger.info({ sessionId: session.sessionId, userId, groupId }, "Created learning session");
    return session;
  }

  getActiveSession(userId: string, groupId: string): LearningSession | null {
    const key = sessionKey(userId, groupId);
    return this.activeSessions.get(key) ?? null;
  }

  updateSession(session: LearningSession): void {
    const key = sessionKey(session.userId, session.groupId);
    this.activeSessions.set(key, session);
    sessionStore.set(`session:${session.sessionId}`, session);
  }

  endSession(userId: string, groupId: string): void {
    const key = sessionKey(userId, groupId);
    const session = this.activeSessions.get(key);
    if (session) {
      const ended: LearningSession = { ...session, state: "idle" };
      sessionStore.set(`session:${session.sessionId}`, ended);
      this.activeSessions.delete(key);
      logger.info({ sessionId: session.sessionId }, "Ended learning session");
    }
  }

  saveSkill(skill: LearnedSkill): void {
    ensureDir(SKILLS_BACKUP_DIR);
    const skillDir = join(SKILLS_BACKUP_DIR, skill.name);
    ensureDir(skillDir);

    writeFileSync(join(skillDir, "SKILL.md"), skill.skillMdContent, "utf-8");
    writeFileSync(
      join(skillDir, ".skill_meta.json"),
      JSON.stringify(skill, null, 2),
      "utf-8"
    );

    for (const [filename, content] of Object.entries(skill.additionalFiles)) {
      writeFileSync(join(skillDir, filename), content, "utf-8");
    }

    logger.info({ name: skill.name, dir: skillDir }, "Saved skill to backup");
  }

  getSkill(name: string): LearnedSkill | null {
    const metaPath = join(SKILLS_BACKUP_DIR, name, ".skill_meta.json");
    if (!existsSync(metaPath)) {
      return null;
    }
    try {
      const raw = readFileSync(metaPath, "utf-8");
      return JSON.parse(raw) as LearnedSkill;
    } catch (error) {
      logger.warn({ error, name }, "Failed to read skill meta");
      return null;
    }
  }

  listSkills(): LearnedSkill[] {
    ensureDir(SKILLS_BACKUP_DIR);
    const skills: LearnedSkill[] = [];
    for (const entry of readdirSync(SKILLS_BACKUP_DIR, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const skill = this.getSkill(entry.name);
        if (skill) {
          skills.push(skill);
        }
      }
    }
    skills.sort((a, b) => b.createdAt - a.createdAt);
    return skills;
  }

  deleteSkill(name: string): boolean {
    const skillDir = join(SKILLS_BACKUP_DIR, name);
    if (!existsSync(skillDir)) {
      return false;
    }
    try {
      rmSync(skillDir, { recursive: true, force: true });
      logger.info({ name }, "Deleted skill from backup");
      return true;
    } catch (error) {
      logger.warn({ error, name }, "Failed to delete skill");
      return false;
    }
  }

  getSkillMd(name: string): string | null {
    const mdPath = join(SKILLS_BACKUP_DIR, name, "SKILL.md");
    if (!existsSync(mdPath)) {
      return null;
    }
    try {
      return readFileSync(mdPath, "utf-8");
    } catch (error) {
      logger.warn({ error, name }, "Failed to read SKILL.md");
      return null;
    }
  }

  deployToSkills(skill: LearnedSkill): string | null {
    try {
      ensureDir(SKILLS_DEPLOY_DIR);
      const targetDir = join(SKILLS_DEPLOY_DIR, skill.name);
      ensureDir(targetDir);

      writeFileSync(join(targetDir, "SKILL.md"), skill.skillMdContent, "utf-8");
      for (const [filename, content] of Object.entries(skill.additionalFiles)) {
        writeFileSync(join(targetDir, filename), content, "utf-8");
      }

      logger.info({ name: skill.name, dir: targetDir }, "Deployed skill to ~/.vex/skills");
      return targetDir;
    } catch (error) {
      logger.error({ error, name: skill.name }, "Failed to deploy skill");
      return null;
    }
  }

  undeployFromSkills(name: string): boolean {
    try {
      const targetDir = join(SKILLS_DEPLOY_DIR, name);
      if (!existsSync(targetDir)) {
        return false;
      }
      rmSync(targetDir, { recursive: true, force: true });
      logger.info({ name }, "Undeployed skill from ~/.vex/skills");
      return true;
    } catch (error) {
      logger.error({ error, name }, "Failed to undeploy skill");
      return false;
    }
  }
}
