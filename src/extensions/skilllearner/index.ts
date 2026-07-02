import type { VexConfig, InboundMessageContext } from "../../types/index.js";
import { registerMessageInterceptor } from "../../pipeline/index.js";
import { getChildLogger } from "../../utils/logger.js";
import { llmComplete } from "../../providers/llm.js";
import type { MemoryManager } from "../../memory/index.js";
import type { LearnedSkill, LearningConfig, LearningSession, SkillType } from "./models.js";
import { SkillStorage } from "./storage.js";

const logger = getChildLogger("skilllearner");

const storage = new SkillStorage();
const cleanupFns: Array<() => void> = [];
let longTermMemory: MemoryManager | null = null;

function getUserKey(ctx: InboundMessageContext): string {
  return `${ctx.channelId}:${ctx.senderId}`;
}

function getGroupKey(ctx: InboundMessageContext): string {
  return ctx.chatType === "group" ? `${ctx.channelId}:${ctx.chatId}` : "";
}

function sanitizeSkillName(raw: string): string {
  const normalized = raw.trim().replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "");
  const name = normalized || `skill-${Date.now()}`;
  logger.debug({ rawLength: raw.length, sanitizedName: name }, "Skill name sanitized");
  return name;
}

function configFromVex(config: VexConfig): LearningConfig {
  return {
    autoTriggerKeywords: config.skillLearner?.autoTriggerKeywords ?? [],
    maxLearningTurns: config.skillLearner?.maxLearningTurns ?? 20,
    enableAutoLearn: config.skillLearner?.enableAutoLearn ?? true,
    enableProactiveSuggest: config.skillLearner?.enableProactiveSuggest ?? true,
    proactiveThreshold: config.skillLearner?.proactiveThreshold ?? 3,
  };
}

function buildSkillMarkdown(name: string, messages: readonly { readonly content: string }[]): string {
  const body = messages.map((message) => `- ${message.content}`).join("\n");
  return `---\nname: ${name}\ndescription: Learned from chat conversation.\n---\n\n# ${name}\n\n## Knowledge\n\n${body}\n`;
}

async function generateSkillMarkdown(config: VexConfig, name: string, session: LearningSession): Promise<string> {
  const providerId = config.agent.defaultProvider;
  const model = config.agent.defaultModel;
  const prompt = [
    "请把以下用户教学内容整理成一个 Vex SKILL.md。",
    "要求：保留 YAML frontmatter，中文表达清晰，内容可直接作为机器人技能注入。",
    "",
    session.messages.map((message, index) => `${index + 1}. ${message.content}`).join("\n"),
  ].join("\n");

  try {
    logger.debug(
      { name, sessionId: session.sessionId, messageCount: session.messages.length, providerId, model },
      "Generating skill markdown with LLM"
    );
    const result = await llmComplete({ providerId, model, prompt, maxTokens: 2048 });
    const text = result.text.trim();
    logger.debug({ name, sessionId: session.sessionId, generatedLength: text.length }, "Skill markdown generated");
    return text.includes("---") && text.includes("#") ? text : buildSkillMarkdown(name, session.messages);
  } catch (error) {
    logger.warn({ error, name }, "Skill markdown generation fell back to deterministic content");
    return buildSkillMarkdown(name, session.messages);
  }
}

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

function statusText(session: LearningSession | null): string {
  if (!session) {
    return "当前没有进行中的技能学习会话。";
  }
  return `正在学习中：已记录 ${session.messages.length} 条消息。使用 /skill_save [名称] 保存，或 /skill_cancel 取消。`;
}

async function handleCommand(config: VexConfig, ctx: InboundMessageContext): Promise<string | null> {
  const [command = "", ...rest] = ctx.content.trim().split(/\s+/);
  const arg = rest.join(" ").trim();
  const userId = getUserKey(ctx);
  const groupId = getGroupKey(ctx);
  if (command.startsWith("/skill") || command.startsWith("/学习") || command.startsWith("/保存技能") || command.startsWith("/取消学习")) {
    logger.debug({ command, userId, groupId, argLength: arg.length }, "Skill Learner command received");
  }

  switch (command) {
    case "/skill_learn":
    case "/学习技能":
      storage.createSession(userId, groupId);
      logger.info({ userId, groupId }, "Skill learning session started");
      return "已进入技能学习模式。请继续发送要我学习的内容，完成后使用 /skill_save [名称] 保存。";
    case "/skill_cancel":
    case "/取消学习":
      storage.endSession(userId, groupId);
      logger.info({ userId, groupId }, "Skill learning session cancelled");
      return "已取消当前技能学习。";
    case "/skill_status":
    case "/学习状态":
      return statusText(storage.getActiveSession(userId, groupId));
    case "/skill_save":
    case "/保存技能": {
      const session = storage.getActiveSession(userId, groupId);
      if (!session || session.messages.length === 0) {
        return "没有可保存的学习内容。";
      }
      const name = sanitizeSkillName(arg || session.proposedName || "learned-skill");
      const markdown = await generateSkillMarkdown(config, name, session);
      const skill = createSkill(name, session, markdown);
      storage.saveSkill(skill);
      const deployed = config.skillLearner?.autoDeployToSkills !== false ? storage.deployToSkills(skill) : null;
      if (longTermMemory) {
        await longTermMemory.remember(
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
      storage.endSession(userId, groupId);
      logger.info(
        {
          name,
          sessionId: session.sessionId,
          messageCount: session.messages.length,
          deployed: Boolean(deployed),
          markdownLength: markdown.length,
        },
        "Skill saved"
      );
      return deployed
        ? `技能已保存并部署：${name}\n路径：${deployed}\n新技能会在下次启动或重新加载技能后生效。`
        : `技能已保存：${name}`;
    }
    case "/skill_list":
    case "/技能列表": {
      const skills = storage.listSkills();
      return skills.length === 0
        ? "还没有保存的技能。"
        : skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n");
    }
    case "/skill_view":
    case "/查看技能": {
      const name = sanitizeSkillName(arg);
      const markdown = storage.getSkillMd(name);
      return markdown ?? `未找到技能：${name}`;
    }
    case "/skill_delete":
    case "/删除技能": {
      const name = sanitizeSkillName(arg);
      const deleted = storage.deleteSkill(name);
      storage.undeployFromSkills(name);
      logger.info({ name, deleted }, "Skill delete requested");
      return deleted ? `已删除技能：${name}` : `未找到技能：${name}`;
    }
    case "/skill_export":
    case "/导出技能": {
      const name = sanitizeSkillName(arg);
      return storage.getSkillMd(name) ?? `未找到技能：${name}`;
    }
    case "/skill_help":
    case "/技能帮助":
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
    default:
      return null;
  }
}

function encouragement(count: number): string | null {
  if ([1, 3, 5, 10, 15].includes(count)) {
    return `已记录 ${count} 条内容，继续发送或使用 /skill_save [名称] 保存。`;
  }
  return null;
}

async function handleLearningCapture(config: LearningConfig, ctx: InboundMessageContext): Promise<string | null> {
  const userId = getUserKey(ctx);
  const groupId = getGroupKey(ctx);
  const session = storage.getActiveSession(userId, groupId);
  if (!session) {
    return null;
  }
  if (ctx.content.trim().startsWith("/")) {
    return null;
  }

  const messages = [...session.messages, { role: "user" as const, content: ctx.content }];
  const updated: LearningSession = { ...session, messages };
  storage.updateSession(updated);
  logger.debug(
    { sessionId: session.sessionId, userId, groupId, messageCount: messages.length, contentLength: ctx.content.length },
    "Skill Learner captured message"
  );

  if (messages.length >= config.maxLearningTurns) {
    return `已达到最多 ${config.maxLearningTurns} 条学习内容，请使用 /skill_save [名称] 保存。`;
  }
  return encouragement(messages.length);
}

function shouldAutoTrigger(config: LearningConfig, content: string): boolean {
  return config.enableAutoLearn && config.autoTriggerKeywords.some((keyword) => content.includes(keyword));
}

export function initSkillLearner(config: VexConfig, options?: { memoryManager?: MemoryManager }): void {
  const learningConfig = configFromVex(config);
  longTermMemory = options?.memoryManager ?? null;
  logger.debug(
    {
      autoTriggerKeywordCount: learningConfig.autoTriggerKeywords.length,
      maxLearningTurns: learningConfig.maxLearningTurns,
      enableAutoLearn: learningConfig.enableAutoLearn,
      enableProactiveSuggest: learningConfig.enableProactiveSuggest,
      proactiveThreshold: learningConfig.proactiveThreshold,
      autoDeployToSkills: config.skillLearner?.autoDeployToSkills !== false,
      hasLongTermMemory: Boolean(longTermMemory),
    },
    "Skill Learner config resolved"
  );
  const unregister = registerMessageInterceptor("skilllearner", async (ctx) => {
    const commandResult = await handleCommand(config, ctx);
    if (commandResult !== null) {
      return commandResult;
    }

    const captured = await handleLearningCapture(learningConfig, ctx);
    if (captured !== null) {
      return captured;
    }

    if (shouldAutoTrigger(learningConfig, ctx.content)) {
      storage.createSession(getUserKey(ctx), getGroupKey(ctx));
      logger.info(
        { userId: getUserKey(ctx), groupId: getGroupKey(ctx), contentLength: ctx.content.length },
        "Skill Learner auto-triggered"
      );
      return "检测到你可能想让我学习这段内容，已进入技能学习模式。继续发送内容，完成后使用 /skill_save [名称] 保存。";
    }

    return null;
  });
  cleanupFns.push(unregister);
  logger.info("Skill Learner interceptor registered");
}

export function cleanupSkillLearner(): void {
  for (const fn of cleanupFns) {
    fn();
  }
  cleanupFns.length = 0;
  longTermMemory = null;
}

export { sanitizeSkillName };
