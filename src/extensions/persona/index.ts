import type { VexConfig, InboundMessageContext, ProviderId } from "../../types/index.js";
import { registerMessageInterceptor, registerPromptInjector, registerResponseObserver } from "../../pipeline/index.js";
import { getChildLogger } from "../../utils/logger.js";
import type { MemoryManager } from "../../memory/index.js";
import { llmComplete } from "../../providers/llm.js";
import { InteractionMode, InteractionOutcome, TodoType, type ProfileFact } from "./models.js";
import { createPersonaConfig, isSleeping, type PersonaConfig } from "./config.js";
import { PersonaStorage } from "./storage.js";

const logger = getChildLogger("persona");

const cleanupFns: Array<() => void> = [];
let storage: PersonaStorage | null = null;
let longTermMemory: MemoryManager | null = null;

/** Uids with an in-flight profile extraction; concurrent triggers are skipped. */
const inFlightProfileExtraction = new Set<string>();
/** Captured from VexConfig at init so background tasks can resolve the LLM. */
let agentProvider: ProviderId | undefined;
let agentModel: string | undefined;

function getWebOwnerId(ctx: InboundMessageContext): string | undefined {
  const raw = ctx.raw;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw) || !("__webUserId" in raw)) {
    return undefined;
  }
  const ownerId = raw.__webUserId;
  return typeof ownerId === "string" ? ownerId : undefined;
}

function userKey(ctx: InboundMessageContext): string {
  const ownerId = getWebOwnerId(ctx);
  return ownerId ? `${ctx.channelId}:${ownerId}:${ctx.senderId}` : `${ctx.channelId}:${ctx.senderId}`;
}

function normalizeTimestampMs(timestamp: number): number {
  return timestamp < 1e12 ? timestamp * 1000 : timestamp;
}

function memoryTags(ctx: InboundMessageContext): string[] {
  return [
    "persona",
    `user:${userKey(ctx)}`,
    `channel:${ctx.channelId}`,
  ];
}

async function rememberPersonaFact(
  config: ReturnType<typeof createPersonaConfig>,
  ctx: InboundMessageContext,
  content: string,
  type: "fact" | "note" = "fact",
): Promise<void> {
  if (!config.memoryEnabled || !longTermMemory || !content.trim()) return;
  await longTermMemory.remember(content.trim(), {
    type,
    source: `persona:${userKey(ctx)}`,
    tags: memoryTags(ctx),
  });
}

async function recallPersonaMemories(
  config: ReturnType<typeof createPersonaConfig>,
  ctx: InboundMessageContext,
): Promise<string> {
  if (!config.memoryEnabled || !longTermMemory || !ctx.content.trim()) return "";
  const userTag = `user:${userKey(ctx)}`;
  const belongsToUser = (entry: Awaited<ReturnType<MemoryManager["list"]>>[number]): boolean => {
    const tags = entry.metadata.tags ?? [];
    return tags.includes("persona") && tags.includes(userTag);
  };

  const entries = await longTermMemory.recall(`${ctx.content} ${ctx.senderName ?? ""}`, 5);
  let filtered = entries.filter(belongsToUser);
  if (filtered.length === 0) {
    filtered = (await longTermMemory.list({ tags: ["persona", userTag] }))
      .filter(belongsToUser)
      .sort((a, b) => b.metadata.timestamp - a.metadata.timestamp)
      .slice(0, 5);
  }
  if (filtered.length === 0) return "";
  return longTermMemory.formatForContext(filtered);
}

async function buildPrompt(config: ReturnType<typeof createPersonaConfig>, ctx: InboundMessageContext): Promise<string> {
  const currentStorage = storage;
  if (!currentStorage) {
    logger.debug(
      { channelId: ctx.channelId, chatId: ctx.chatId, senderId: ctx.senderId, hasStorage: Boolean(currentStorage), chatType: ctx.chatType },
      "Persona prompt skipped"
    );
    return "";
  }

  const uid = userKey(ctx);
  const profile = currentStorage.touchProfile(uid, ctx.senderName ?? "");
  const emotion = config.emotionEnabled
    ? currentStorage.applyDecay(uid, config.emotionDecayPerHour)
    : currentStorage.getEmotion(uid);
  currentStorage.cleanupExpiredEffects(uid);
  currentStorage.cleanupOldTodos(uid);
  currentStorage.appendHistory(uid, "user", ctx.content);

  const blocks: string[] = [
    `【私人 Persona】你现在扮演 ${config.personaName}。${config.personaBasePrompt}`,
    `【回复风格】${config.personaReplyStyle}`,
  ];

  if (config.timeAwarenessEnabled) {
    blocks.push(`【当前时间】${new Date(normalizeTimestampMs(ctx.timestamp)).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`);
  }
  if (config.restEnabled && isSleeping(config)) {
    blocks.push("【休息状态】现在是你的休息时间，回复可以更困倦、更简短。");
  }
  if (profile.nickname) {
    blocks.push(`【用户昵称】${profile.nickname}`);
  }
  blocks.push(`【亲密度】${Math.round(profile.affinity)}/100`);
  if (config.emotionEnabled) {
    blocks.push(`【情绪】${emotion.statusStr()}，${emotion.narrative()}`);
  }

  const effects = config.effectEnabled ? currentStorage.formatEffectsForPrompt(uid) : "";
  if (effects) {
    blocks.push(`【当前影响】${effects}`);
  }

  const todos = config.todoEnabled ? currentStorage.formatTodosForPrompt(uid) : "";
  if (todos) {
    blocks.push(`【待办】\n${todos}`);
  }

  const history = config.memoryEnabled ? currentStorage.formatHistoryForPrompt(uid, config.memoryMaxTurns) : "";
  if (history) {
    blocks.push(`【近期对话】\n${history}`);
  }

  const relevantMemories = await recallPersonaMemories(config, ctx);
  if (relevantMemories) {
    blocks.push(`【长期记忆】\n${relevantMemories}`);
  }

  const profileFacts = config.profileEnabled ? currentStorage.formatProfileFactsForPrompt(uid) : "";
  if (profileFacts) {
    blocks.push(`【用户画像】\n${profileFacts}`);
  }

  if (config.reflectionEnabled) {
    const reflection = currentStorage.getUnconsumedReflection(uid);
    if (reflection) {
      const reflectionLines = [
        reflection.note ? `反思：${reflection.note}` : "",
        reflection.bias ? `偏差提醒：${reflection.bias}` : "",
        ...reflection.explicitFacts().map((fact) => `事实：${fact}`),
      ].filter(Boolean);
      if (reflectionLines.length > 0) {
        blocks.push(`【最近反思】\n${reflectionLines.join("\n")}`);
      }
    }
  }

  if (config.goodnightHintEnabled) {
    blocks.push("【注意】如果用户道晚安或准备睡觉，要温柔收束，不要强行延长聊天。");
  }

  const prompt = blocks.join("\n\n");
  logger.debug(
    {
      userId: uid,
      blockCount: blocks.length,
      promptLength: prompt.length,
      affinity: profile.affinity,
      energy: emotion.energy,
      mood: emotion.mood,
      socialNeed: emotion.socialNeed,
    },
    "Persona prompt built"
  );
  return prompt;
}

function personaSummary(config: ReturnType<typeof createPersonaConfig>, ctx: InboundMessageContext): string {
  const currentStorage = storage;
  if (!currentStorage) {
    return "Persona 未初始化。";
  }
  const uid = userKey(ctx);
  const snapshot = currentStorage.getPersonaSnapshot(uid);
  return [
    `${config.personaName} 状态`,
    `情绪：${String(snapshot.emotion_narrative)} (${currentStorage.getEmotion(uid).statusStr()})`,
    `亲密度：${String(snapshot.affinity)}/100`,
    `聊天次数：${String(snapshot.chat_count)}`,
    `昵称：${String(snapshot.nickname) || "(未设置)"}`,
  ].join("\n");
}

interface ExtractedFact {
  category: string;
  content: string;
  evidence: string;
  confidence: number;
}

const EXTRACTION_PROMPT_HEADER = [
  "你是一名用户画像抽取助手。请从下方【近期对话】中抽取关于该用户的**持久事实**（居住地、职业、偏好、关系、重要日期、习惯等）。",
  "忽略一次性/临时内容（'今天天气'、'帮我查一下'等）。",
  "",
  "【输出要求】",
  "- 只输出尚未在【已记录的事实】中出现过的新事实。",
  "- 严格输出一个 JSON 数组，每个元素形如 {category, content, evidence, confidence}。",
  "- confidence 为 0~1 的浮点；<0.6 的事实宁可丢弃也不要写。",
  "- 没有任何新事实时，输出空数组 []。不要输出其它文字、不要解释、不要 Markdown 代码块包裹。",
].join("\n");

/** Strip ```json fences / leading prose that some models emit around JSON. */
function extractJsonArray(raw: string): ExtractedFact[] | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1]!.trim() : trimmed;
  // Find the first '[' that looks like an array start; ignore prose before it.
  const bracketStart = candidate.indexOf("[");
  const bracketEnd = candidate.lastIndexOf("]");
  const json = bracketStart >= 0 && bracketEnd > bracketStart
    ? candidate.slice(bracketStart, bracketEnd + 1)
    : candidate;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return null;
    const facts: ExtractedFact[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const category = typeof record.category === "string" ? record.category.trim() : "";
      const content = typeof record.content === "string" ? record.content.trim() : "";
      const evidence = typeof record.evidence === "string" ? record.evidence.trim() : "";
      const rawConfidence = record.confidence;
      const confidence = typeof rawConfidence === "number"
        ? rawConfidence
        : Number(rawConfidence);
      if (!category || !content) continue;
      if (!Number.isFinite(confidence)) continue;
      facts.push({ category, content, evidence, confidence });
    }
    return facts;
  } catch {
    return null;
  }
}

function buildExistingFactsContext(facts: ProfileFact[]): string {
  if (facts.length === 0) return "（暂无）";
  return facts.map((f) => `- [${f.category}] ${f.content}`).join("\n");
}

async function extractProfileFacts(
  config: PersonaConfig,
  ctx: InboundMessageContext,
  uid: string,
): Promise<void> {
  if (inFlightProfileExtraction.has(uid)) return;
  const currentStorage = storage;
  if (!currentStorage || !agentProvider || !agentModel) return;
  inFlightProfileExtraction.add(uid);
  try {
    const history = currentStorage.formatHistoryForPrompt(uid, config.memoryMaxTurns);
    const existing = currentStorage.getProfileFacts(uid);
    const prompt = [
      EXTRACTION_PROMPT_HEADER,
      "",
      "【已记录的事实】（请勿重复）",
      buildExistingFactsContext(existing),
      "",
      "【近期对话】",
      history || "（暂无）",
    ].join("\n");
    const result = await llmComplete({
      providerId: agentProvider,
      model: agentModel,
      prompt,
      temperature: 0.2,
      maxTokens: 1024,
    });
    const facts = extractJsonArray(result.text);
    if (!facts) {
      logger.warn({ userId: uid }, "Profile extraction: invalid JSON, dropped");
      return;
    }
    let written = 0;
    let skippedConfidence = 0;
    let skippedDuplicate = 0;
    for (const fact of facts) {
      if (fact.confidence < 0.6) {
        skippedConfidence++;
        continue;
      }
      const beforeCount = currentStorage.getProfileFacts(uid).length;
      currentStorage.addProfileFact(uid, fact.category, fact.content, fact.evidence, fact.confidence);
      const afterCount = currentStorage.getProfileFacts(uid).length;
      if (afterCount === beforeCount) {
        skippedDuplicate++;
        continue;
      }
      written++;
      await rememberPersonaFact(
        config,
        ctx,
        `[${fact.category}] ${fact.content}`,
        "fact",
      );
    }
    logger.info(
      { userId: uid, returned: facts.length, written, skippedConfidence, skippedDuplicate },
      "Profile extraction finished",
    );
  } catch (error) {
    // Serialize the message explicitly; pino renders a raw Error as `{}`.
    logger.warn(
      { error: error instanceof Error ? error.message : String(error), userId: uid },
      "Profile extraction failed",
    );
  } finally {
    inFlightProfileExtraction.delete(uid);
  }
}

function parseNumber(raw: string, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

async function handlePersonaCommand(config: ReturnType<typeof createPersonaConfig>, ctx: InboundMessageContext): Promise<string | null> {
  const currentStorage = storage;
  if (!currentStorage) {
    return null;
  }
  const [command = "", ...rest] = ctx.content.trim().split(/\s+/);
  const arg = rest.join(" ").trim();
  const uid = userKey(ctx);
  if (command.startsWith("/persona") || command.startsWith("/人格")) {
    logger.debug({ command, userId: uid, argLength: arg.length }, "Persona command received");
  }

  switch (command) {
    case "/persona":
    case "/人格":
      return personaSummary(config, ctx);
    case "/persona_help":
    case "/人格帮助":
      return [
        "/persona 查看状态",
        "/persona_effects 查看影响",
        "/persona_todo 查看待办",
        "/persona_add_effect <内容> 添加影响",
        "/persona_add_todo <内容> 添加待办",
        "/persona_done_todo <id> 完成待办",
        "/persona_affinity 查看亲密度",
        "/persona_set_affinity <数字> 设置亲密度",
        "/persona_set_nickname <昵称> 设置昵称",
        "/persona_history 查看近期对话",
        "/persona_reset 重置状态",
      ].join("\n");
    case "/persona_effects":
      return currentStorage.getActiveEffects(uid).map((effect) => `${effect.id}: ${effect.narrative(Date.now() / 1000)}`).join("\n") || "当前没有影响。";
    case "/persona_todo":
    case "/persona_today":
      return currentStorage.getActiveTodos(uid).map((todo) => `${todo.id}: ${todo.content}`).join("\n") || "当前没有待办。";
    case "/persona_add_effect": {
      const effect = currentStorage.addEffect(uid, "manual", 40, arg || "被用户影响了一下");
      logger.info({ userId: uid, effectId: effect.id, argLength: arg.length }, "Persona effect added");
      return `已添加影响：${effect.id}`;
    }
    case "/persona_remove_effect":
      logger.info({ userId: uid, effectId: arg }, "Persona effect remove requested");
      return currentStorage.removeEffect(uid, arg) ? "已移除影响。" : "未找到影响。";
    case "/persona_clear_effects":
      for (const effect of currentStorage.getEffects(uid)) {
        currentStorage.removeEffect(uid, effect.id);
      }
      return "已清空影响。";
    case "/persona_add_todo": {
      const todo = currentStorage.addTodo(uid, TodoType.SOCIAL, arg || "找用户聊聊", 0);
      logger.info({ userId: uid, todoId: todo.id, argLength: arg.length }, "Persona todo added");
      return `已添加待办：${todo.id}`;
    }
    case "/persona_done_todo":
      return currentStorage.markTodoDone(uid, arg) ? "已完成待办。" : "未找到待办。";
    case "/persona_clear_todos":
      for (const todo of currentStorage.getActiveTodos(uid)) {
        currentStorage.markTodoDone(uid, todo.id);
      }
      return "已清空待办。";
    case "/persona_affinity":
      return `亲密度：${Math.round(currentStorage.getAffinity(uid))}/100`;
    case "/persona_set_affinity": {
      const profile = currentStorage.getProfile(uid);
      profile.affinity = Math.max(0, Math.min(100, parseNumber(arg, profile.affinity)));
      currentStorage.saveProfile(uid, profile);
      logger.info({ userId: uid, affinity: profile.affinity }, "Persona affinity updated");
      return `亲密度已设置为 ${Math.round(profile.affinity)}/100`;
    }
    case "/persona_set_nickname": {
      const profile = currentStorage.getProfile(uid);
      profile.nickname = arg;
      currentStorage.saveProfile(uid, profile);
      await rememberPersonaFact(config, ctx, `用户昵称是：${arg || "(空)"}`, "fact");
      logger.info({ userId: uid, hasNickname: arg.length > 0 }, "Persona nickname updated");
      return `昵称已设置为：${arg || "(空)"}`;
    }
    case "/persona_set_emotion": {
      const [energy = "", mood = "", socialNeed = ""] = rest;
      const emotion = currentStorage.getEmotion(uid);
      emotion.energy = Math.max(0, Math.min(100, parseNumber(energy, emotion.energy)));
      emotion.mood = Math.max(0, Math.min(100, parseNumber(mood, emotion.mood)));
      emotion.socialNeed = Math.max(0, Math.min(100, parseNumber(socialNeed, emotion.socialNeed)));
      currentStorage.saveEmotion(uid, emotion);
      logger.info(
        { userId: uid, energy: emotion.energy, mood: emotion.mood, socialNeed: emotion.socialNeed },
        "Persona emotion updated"
      );
      return `情绪已更新：${emotion.statusStr()}`;
    }
    case "/persona_note": {
      const profile = currentStorage.getProfile(uid);
      profile.notes = arg;
      currentStorage.saveProfile(uid, profile);
      await rememberPersonaFact(config, ctx, `关于用户的备注：${arg}`, "note");
      return "已记录备注。";
    }
    case "/persona_history":
      return currentStorage.formatHistoryForPrompt(uid, config.memoryMaxTurns) || "暂无历史。";
    case "/persona_consolidate": {
      const consolidation = currentStorage.runConsolidation(uid);
      return `已整理今日互动：${consolidation.shiftHint}`;
    }
    case "/persona_debug":
      return JSON.stringify(currentStorage.getPersonaSnapshot(uid), null, 2);
    case "/persona_reset":
      currentStorage.clearInteractions(uid);
      return "已重置互动统计。";
    case "/persona_reflections":
    case "/persona_facts":
    case "/persona_clear_reflections":
    case "/persona_remove_fact":
    case "/persona_apply":
    case "/persona_set_config":
      return "该 Persona 子命令已接入占位处理，完整反思/事实编辑会在后续 LLM 后台任务中生效。";
    default:
      return null;
  }
}

function observeResponse(config: PersonaConfig, ctx: InboundMessageContext, replyText: string): void {
  const currentStorage = storage;
  if (!currentStorage) {
    return;
  }
  const uid = userKey(ctx);
  currentStorage.appendHistoryAndRecoverEmotion(uid, "assistant", replyText, config.emotionRecoveryPerReply);
  currentStorage.recordInteraction(uid, InteractionMode.PASSIVE, InteractionOutcome.CONNECTED);
  logger.debug({ userId: uid, replyLength: replyText.length, recovery: config.emotionRecoveryPerReply }, "Persona response observed");

  // Background profile building: fire-and-forget every N turns.
  // Per-turn counter is bumped only when we actually consider extraction (gated + has LLM),
  // so disabled/misconfigured setups do not advance state.
  if (!config.profileBuildingEnabled || !agentProvider || !agentModel) return;
  const triggerTurns = Math.max(1, config.profileBuildingTriggerTurns);
  const turn = currentStorage.incrementTurnCounter(uid, "profile_building");
  if (turn % triggerTurns !== 0) return;
  // Detached: error contract is owned by extractProfileFacts (try/catch + logger.warn).
  void extractProfileFacts(config, ctx, uid).catch(() => {
    /* defensive belt; extractProfileFacts already swallows errors */
  });
}

export function initPersona(config: VexConfig, options?: { memoryManager?: MemoryManager }): void {
  const personaConfig = createPersonaConfig(config.persona);
  storage = new PersonaStorage(personaConfig.storageCacheMax);
  longTermMemory = options?.memoryManager ?? null;
  agentProvider = config.agent?.defaultProvider;
  agentModel = config.agent?.defaultModel;
  logger.debug(
    {
      personaName: personaConfig.personaName,
      emotionEnabled: personaConfig.emotionEnabled,
      effectEnabled: personaConfig.effectEnabled,
      todoEnabled: personaConfig.todoEnabled,
      memoryEnabled: personaConfig.memoryEnabled,
      profileBuildingEnabled: personaConfig.profileBuildingEnabled,
      profileBuildingTriggerTurns: personaConfig.profileBuildingTriggerTurns,
      hasAgentProvider: Boolean(agentProvider),
      hasAgentModel: Boolean(agentModel),
      hasLongTermMemory: Boolean(longTermMemory),
      storageCacheMax: personaConfig.storageCacheMax,
    },
    "Persona config resolved"
  );

  cleanupFns.push(registerPromptInjector("persona", async (ctx) => buildPrompt(personaConfig, ctx)));
  cleanupFns.push(registerMessageInterceptor("persona", async (ctx) => handlePersonaCommand(personaConfig, ctx)));
  cleanupFns.push(registerResponseObserver("persona", async (ctx, replyText) => observeResponse(personaConfig, ctx, replyText)));

  logger.info({ personaName: personaConfig.personaName }, "Persona extension registered");
}

export function cleanupPersona(): void {
  for (const fn of cleanupFns) {
    fn();
  }
  cleanupFns.length = 0;
  storage = null;
  longTermMemory = null;
  agentProvider = undefined;
  agentModel = undefined;
  inFlightProfileExtraction.clear();
}
