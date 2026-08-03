/**
 * Skill Learner storage layer — instance-scoped, zero process-global state.
 *
 * Active sessions live in an instance Map; skills are persisted under
 * stateDir/skills/ and optionally deployed to skillsDir.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import type { LearningSession, LearnedSkill } from "./models.js";

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function sessionKey(userId: string, groupId: string): string {
  return groupId ? `${groupId}:${userId}` : userId;
}

const ACTIVE_SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function isLearningSession(value: unknown): value is LearningSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const session = value as Partial<LearningSession>;
  return typeof session.sessionId === "string"
    && typeof session.userId === "string"
    && typeof session.groupId === "string"
    && typeof session.startedAt === "number"
    && Array.isArray(session.messages)
    && session.state === "listening";
}

export class SkillStorage {
  private readonly stateDir: string;
  private readonly skillsDir: string | undefined;
  private readonly activeSessions = new Map<string, LearningSession>();

  constructor(stateDir: string, skillsDir?: string) {
    this.stateDir = stateDir;
    this.skillsDir = skillsDir;
    this.restoreActiveSessions();
  }

  private restoreActiveSessions(): void {
    const sessionsDir = join(this.stateDir, "sessions");
    if (!existsSync(sessionsDir)) return;
    const cutoff = Date.now() - ACTIVE_SESSION_MAX_AGE_MS;
    for (const entry of readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const filePath = join(sessionsDir, entry.name);
      try {
        const parsed: unknown = JSON.parse(readFileSync(filePath, "utf-8"));
        if (!isLearningSession(parsed) || parsed.startedAt < cutoff) {
          unlinkSync(filePath);
          continue;
        }
        const key = sessionKey(parsed.userId, parsed.groupId);
        const current = this.activeSessions.get(key);
        if (!current || current.startedAt < parsed.startedAt) this.activeSessions.set(key, parsed);
      } catch {
        try { unlinkSync(filePath); } catch { /* best-effort pruning */ }
      }
    }
  }

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
    this.persistSession(session);
    return session;
  }

  getActiveSession(userId: string, groupId: string): LearningSession | null {
    const key = sessionKey(userId, groupId);
    return this.activeSessions.get(key) ?? null;
  }

  updateSession(session: LearningSession): void {
    const key = sessionKey(session.userId, session.groupId);
    this.activeSessions.set(key, session);
    this.persistSession(session);
  }

  endSession(userId: string, groupId: string): void {
    const key = sessionKey(userId, groupId);
    const session = this.activeSessions.get(key);
    if (session) {
      const ended: LearningSession = { ...session, state: "idle" };
      const sessionPath = join(this.stateDir, "sessions", `${ended.sessionId}.json`);
      try { unlinkSync(sessionPath); } catch { /* best-effort cleanup */ }
      this.activeSessions.delete(key);
    }
  }

  private persistSession(session: LearningSession): void {
    const sessionsDir = join(this.stateDir, "sessions");
    ensureDir(sessionsDir);
    writeFileSync(
      join(sessionsDir, `${session.sessionId}.json`),
      JSON.stringify(session, null, 2),
      "utf-8",
    );
  }

  saveSkill(skill: LearnedSkill): void {
    const skillsBackupDir = join(this.stateDir, "skills");
    ensureDir(skillsBackupDir);
    const skillDir = join(skillsBackupDir, skill.name);
    ensureDir(skillDir);

    writeFileSync(join(skillDir, "SKILL.md"), skill.skillMdContent, "utf-8");
    writeFileSync(
      join(skillDir, ".skill_meta.json"),
      JSON.stringify(skill, null, 2),
      "utf-8",
    );

    for (const [filename, content] of Object.entries(skill.additionalFiles)) {
      writeFileSync(join(skillDir, filename), content, "utf-8");
    }
  }

  getSkill(name: string): LearnedSkill | null {
    const metaPath = join(this.stateDir, "skills", name, ".skill_meta.json");
    if (!existsSync(metaPath)) {
      return null;
    }
    try {
      const raw = readFileSync(metaPath, "utf-8");
      return JSON.parse(raw) as LearnedSkill;
    } catch {
      return null;
    }
  }

  listSkills(): LearnedSkill[] {
    const skillsBackupDir = join(this.stateDir, "skills");
    if (!existsSync(skillsBackupDir)) {
      return [];
    }
    const skills: LearnedSkill[] = [];
    for (const entry of readdirSync(skillsBackupDir, { withFileTypes: true })) {
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
    const skillDir = join(this.stateDir, "skills", name);
    if (!existsSync(skillDir)) {
      return false;
    }
    try {
      rmSync(skillDir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  getSkillMd(name: string): string | null {
    const mdPath = join(this.stateDir, "skills", name, "SKILL.md");
    if (!existsSync(mdPath)) {
      return null;
    }
    try {
      return readFileSync(mdPath, "utf-8");
    } catch {
      return null;
    }
  }

  deployToSkills(skill: LearnedSkill): string | null {
    if (!this.skillsDir) {
      return null;
    }
    try {
      ensureDir(this.skillsDir);
      const targetDir = join(this.skillsDir, skill.name);
      ensureDir(targetDir);

      writeFileSync(join(targetDir, "SKILL.md"), skill.skillMdContent, "utf-8");
      for (const [filename, content] of Object.entries(skill.additionalFiles)) {
        writeFileSync(join(targetDir, filename), content, "utf-8");
      }

      return targetDir;
    } catch {
      return null;
    }
  }

  undeployFromSkills(name: string): boolean {
    if (!this.skillsDir) {
      return false;
    }
    try {
      const targetDir = join(this.skillsDir, name);
      if (!existsSync(targetDir)) {
        return false;
      }
      rmSync(targetDir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  /** Clear all in-memory active sessions (used by shutdown). */
  clearActiveSessions(): void {
    this.activeSessions.clear();
  }
}
