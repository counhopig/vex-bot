/**
 * Skill Learner — per-Agent instance-scoped service exposing a message interceptor.
 *
 * Ported from archive behavior spec with zero process-global state:
 * all runtime Maps and storage are instance fields on SkillLearner.
 */

import type { InboundMessageContext } from "../../channels/ChannelAdapter.js";
import { getChildLogger } from "../../utils/logger.js";
import type { MemoryManager } from "../../memory/index.js";
import type {
  LearningConfig,
  LearningSession,
  LearnedSkill,
  SkillType,
  LearningMessage,
} from "./models.js";
import { SkillStorage } from "./storage.js";

const logger = getChildLogger("skill-learner");

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type { LearningConfig } from "./models.js";

export type LearnerLlmComplete = (opts: { prompt: string }) => Promise<{ text: string }>;

export interface SkillLearnerOptions {
  config: LearningConfig;
  ownerId: string;
  stateDir: string;
  memoryManager?: MemoryManager;
  skillsDir?: string;
  complete?: LearnerLlmComplete;
}

// ---------------------------------------------------------------------------
// Session keying — derived per-call from ctx, never from init-time globals
// ---------------------------------------------------------------------------

function getUserKey(ctx: InboundMessageContext): string {
  const owner = ctx.webUserId ?? ctx.senderId;
  return `${owner}:${ctx.channelId}:${ctx.senderId}`;
}

function getGroupKey(ctx: InboundMessageContext): string {
  if (ctx.chatType !== "group") return "";
  const owner = ctx.webUserId ?? ctx.senderId;
  return `${owner}:${ctx.channelId}:${ctx.chatId}`;
}

// ---------------------------------------------------------------------------
// Skill name sanitization
// ---------------------------------------------------------------------------

export function sanitizeSkillName(raw: string): string {
  const normalized = raw.trim().replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "");
  const name = normalized || `skill-${Date.now()}`;
  logger.debug({ rawLength: raw.length, sanitizedName: name }, "Skill name sanitized");
  return name;
}

// ---------------------------------------------------------------------------
// Markdown generation
// ---------------------------------------------------------------------------

function buildSkillMarkdown(name: string, messages: readonly LearningMessage[]): string {
  const body = messages.map((message) => `- ${message.content}`).join("\n");
  return `---\nname: ${name}\ndescription: Learned from chat conversation.\n---\n\n# ${name}\n\n## Knowledge\n\n${body}\n`;
}

async function generateSkillMarkdown(
  complete: LearnerLlmComplete | undefined,
  name: string,
  session: LearningSession,
): Promise<string> {
  if (!complete) {
    return buildSkillMarkdown(name, session.messages);
  }

  const prompt = [
    "请把以下用户教学内容整理成一个 Vex SKILL.md。",
    "要求：保留 YAML frontmatter，中文表达清晰，内容可直接作为机器人技能注入。",
    "",
    session.messages.map((message, index) => `${index + 1}. ${message.content}`).join("\n"),
  ].join("\n");

  try {
    logger.debug(
      { name, sessionId: session.sessionId, messageCount: session.messages.length },
      "Generating skill markdown with LLM",
    );
    const result = await complete({ prompt });
    const text = result.text.trim();
    logger.debug({ name, sessionId: session.sessionId, generatedLength: text.length }, "Skill markdown generated");
    return text.includes("---") && text.includes("#") ? text : buildSkillMarkdown(name, session.messages);
  } catch (error) {
    logger.warn({ error, name }, "Skill markdown generation fell back to deterministic content");
    return buildSkillMarkdown(name, session.messages);
  }
}

// ---------------------------------------------------------------------------
// Skill factory
// ---------------------------------------------------------------------------

function createSkill(name: string, session: LearningSession, markdown: string): LearnedSkill {
  const now = Date.now();
  return {
    skillId: `skill-${now}`,
    name,
    displayName: name,
    skillType: "knowledge" satisfies SkillType,
    description: `从 ${session.messages.length} 条消息学习得到的技能`,
    createdAt: now,
    updatedAt: now,
    createdBy: session.userId,
    sourceSession: session.sessionId,
    tags: [],
    skillMdContent: markdown,
    additionalFiles: {},
    usageCount: 0,
  };
}

// ---------------------------------------------------------------------------
// Status text
// ---------------------------------------------------------------------------

function statusText(session: LearningSession | null): string {
  if (!session) {
    return "当前没有进行中的技能学习会话。";
  }
  return `正在学习中：已记录 ${session.messages.length} 条消息。使用 /skill_save [名称] 保存，或 /skill_cancel 取消。`;
}

// ---------------------------------------------------------------------------
// Encouragement
// ---------------------------------------------------------------------------

function encouragement(count: number): string | null {
  if ([1, 3, 5, 10, 15].includes(count)) {
    return `已记录 ${count} 条内容，继续发送或使用 /skill_save [名称] 保存。`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Auto-trigger
// ---------------------------------------------------------------------------

function shouldAutoTrigger(config: LearningConfig, content: string): boolean {
  return Boolean(config.enableAutoLearn) && (config.autoTriggerKeywords ?? []).some((keyword) => content.includes(keyword));
}

// ---------------------------------------------------------------------------
// SkillLearner class
// ---------------------------------------------------------------------------

export class SkillLearner {
  private readonly config: LearningConfig;
  private readonly ownerId: string;
  private readonly storage: SkillStorage;
  private readonly memoryManager: MemoryManager | undefined;
  private readonly complete: LearnerLlmComplete | undefined;
  private _shutdown = false;

  constructor(options: SkillLearnerOptions) {
    this.config = options.config;
    this.ownerId = options.ownerId;
    this.storage = new SkillStorage(options.stateDir, options.skillsDir);
    this.memoryManager = options.memoryManager;
    this.complete = options.complete;
  }

  /** MessageInterceptor implementation — returns a short-circuit reply or null. */
  async interceptor(ctx: InboundMessageContext): Promise<string | null> {
    if (this._shutdown) return null;

    const commandResult = await this.handleCommand(ctx);
    if (commandResult !== null) {
      return commandResult;
    }

    const captured = await this.handleLearningCapture(ctx);
    if (captured !== null) {
      return captured;
    }

    if (shouldAutoTrigger(this.config, ctx.content)) {
      const userId = getUserKey(ctx);
      const groupId = getGroupKey(ctx);
      this.storage.createSession(userId, groupId);
      logger.info(
        { userId, groupId, contentLength: ctx.content.length },
        "Skill Learner auto-triggered",
      );
      return "检测到你可能想让我学习这段内容，已进入技能学习模式。继续发送内容，完成后使用 /skill_save [名称] 保存。";
    }

    return null;
  }

  /** Clean up in-memory state; idempotent. */
  shutdown(): void {
    if (this._shutdown) return;
    this._shutdown = true;
    this.storage.clearActiveSessions();
  }

  // -----------------------------------------------------------------------
  // Command handling
  // -----------------------------------------------------------------------

  private async handleCommand(ctx: InboundMessageContext): Promise<string | null> {
    const [command = "", ...rest] = ctx.content.trim().split(/\s+/);
    const arg = rest.join(" ").trim();
    const userId = getUserKey(ctx);
    const groupId = getGroupKey(ctx);

    if (
      command.startsWith("/skill") ||
      command.startsWith("/学习") ||
      command === "/保存技能" ||
      command === "/取消学习"
    ) {
      logger.debug({ command, userId, groupId, argLength: arg.length }, "Skill Learner command received");
    }

    switch (command) {
      case "/skill_learn":
      case "/学习技能": {
        this.storage.createSession(userId, groupId);
        logger.info({ userId, groupId }, "Skill learning session started");
        return "已进入技能学习模式。请继续发送要我学习的内容，完成后使用 /skill_save [名称] 保存。";
      }
      case "/skill_cancel":
      case "/取消学习": {
        this.storage.endSession(userId, groupId);
        logger.info({ userId, groupId }, "Skill learning session cancelled");
        return "已取消当前技能学习。";
      }
      case "/skill_status":
      case "/学习状态": {
        return statusText(this.storage.getActiveSession(userId, groupId));
      }
      case "/skill_save":
      case "/保存技能": {
        const session = this.storage.getActiveSession(userId, groupId);
        if (!session || session.messages.length === 0) {
          return "没有可保存的学习内容。";
        }
        const name = sanitizeSkillName(arg || session.proposedName || "learned-skill");
        const markdown = await generateSkillMarkdown(this.complete, name, session);
        const skill = createSkill(name, session, markdown);
        this.storage.saveSkill(skill);
        const deployed = this.config.autoDeployToSkills !== false
          ? this.storage.deployToSkills(skill)
          : null;
        if (this.memoryManager) {
          await this.memoryManager.remember(
            [
              `保存的技能：${skill.name}`,
              skill.description,
              ...session.messages.map((message) => `- ${message.content}`),
            ].join("\n"),
            {
              type: "note",
              source: `skilllearner:${userId}`,
              tags: ["skill", `skill:${skill.name}`, `user:${userId}`],
            },
          );
        }
        this.storage.endSession(userId, groupId);
        logger.info(
          {
            name,
            sessionId: session.sessionId,
            messageCount: session.messages.length,
            deployed: Boolean(deployed),
            markdownLength: markdown.length,
          },
          "Skill saved",
        );
        return deployed
          ? `技能已保存并部署：${name}\n路径：${deployed}\n新技能会在下次启动或重新加载技能后生效。`
          : `技能已保存：${name}`;
      }
      case "/skill_list":
      case "/技能列表": {
        const skills = this.storage.listSkills();
        return skills.length === 0
          ? "还没有保存的技能。"
          : skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n");
      }
      case "/skill_view":
      case "/查看技能": {
        const name = sanitizeSkillName(arg);
        const markdown = this.storage.getSkillMd(name);
        return markdown ?? `未找到技能：${name}`;
      }
      case "/skill_delete":
      case "/删除技能": {
        const name = sanitizeSkillName(arg);
        const deleted = this.storage.deleteSkill(name);
        this.storage.undeployFromSkills(name);
        logger.info({ name, deleted }, "Skill delete requested");
        return deleted ? `已删除技能：${name}` : `未找到技能：${name}`;
      }
      case "/skill_export":
      case "/导出技能": {
        const name = sanitizeSkillName(arg);
        return this.storage.getSkillMd(name) ?? `未找到技能：${name}`;
      }
      case "/skill_help":
      case "/技能帮助": {
        return [
          "/skill_learn 开始学习",
          "/skill_save [名称] 保存技能",
          "/skill_cancel 取消学习",
          "/skill_status 查看状态",
          "/skill_list 列出技能",
          "/skill_view <名称> 查看技能",
          "/skill_delete <名称> 删除技能",
          "/skill_export <名称> 导出技能",
        ].join("\n");
      }
      default:
        return null;
    }
  }

  // -----------------------------------------------------------------------
  // Learning capture
  // -----------------------------------------------------------------------

  private async handleLearningCapture(ctx: InboundMessageContext): Promise<string | null> {
    const userId = getUserKey(ctx);
    const groupId = getGroupKey(ctx);
    const session = this.storage.getActiveSession(userId, groupId);
    if (!session) {
      return null;
    }
    if (ctx.content.trim().startsWith("/")) {
      return null;
    }

    const messages: LearningMessage[] = [...session.messages, { role: "user", content: ctx.content }];
    const updated: LearningSession = { ...session, messages };
    this.storage.updateSession(updated);
    logger.debug(
      { sessionId: session.sessionId, userId, groupId, messageCount: messages.length, contentLength: ctx.content.length },
      "Skill Learner captured message",
    );

    const maxLearningTurns = this.config.maxLearningTurns ?? 20;
    if (messages.length >= maxLearningTurns) {
      return `已达到最多 ${maxLearningTurns} 条学习内容，请使用 /skill_save [名称] 保存。`;
    }
    return encouragement(messages.length);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSkillLearner(options: SkillLearnerOptions): SkillLearner {
  return new SkillLearner(options);
}
