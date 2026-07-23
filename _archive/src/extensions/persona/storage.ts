/**
 * 存储引擎层：轻量级 JSON 文件存储
 * 每个用户一个 JSON 文件，内存在线缓存。
 */

import { createExtensionStore, JsonStore } from "../common/json-store.js";
import {
  ChatTurn,
  Consolidation,
  Effect,
  EmotionState,
  InteractionEvent,
  InteractionMode,
  InteractionOutcome,
  type InteractionOutcomeValue,
  ProfileFact,
  ReflectionRecord,
  Todo,
  TodoType,
  type TodoTypeValue,
  UserProfile,
} from "./models.js";
import { getChildLogger } from "../../utils/logger.js";
import {
  emotionGetEmotion,
  emotionUpdateEmotion,
} from "./storage/emotion.js";
import {
  profileGetProfile,
  profileUpdateProfile,
  profileAddFact,
  profileGetAllFacts,
} from "./storage/profile.js";
import {
  todosGetByType,
  todosAdd,
  todosComplete,
} from "./storage/todos.js";
import {
  historyAppend,
  historyGet,
  interactionsSave,
  consolidationsProcess,
  reflectionsGetAll,
  reflectionsSave,
} from "./storage/history.js";

const logger = getChildLogger("persona-storage");

/** 单个用户的完整数据 */
export type UserData = {
  [key: string]: unknown;
  emotion?: Record<string, unknown>;
  profile?: Record<string, unknown>;
  history?: Record<string, unknown>[];
  effects?: Record<string, unknown>[];
  todos?: Record<string, unknown>[];
  interactions?: Record<string, unknown>[];
  consolidations?: Record<string, unknown>[];
  reflections?: Record<string, unknown>[];
  profile_facts?: Record<string, unknown>[];
  turn_counters?: Record<string, number>;
  umo?: string;
  proactive_failure?: Record<string, unknown>;
};

export class PersonaStorage {
  private store: JsonStore<UserData>;

  constructor(cacheMax?: number) {
    this.store = createExtensionStore<UserData>("persona");
    // Note: JsonStore currently does not expose cacheMax override;
    // the default 128 is acceptable; we may extend JsonStore later.
    void cacheMax;
  }

  private load(userId: string): UserData {
    return this.store.get(userId) ?? {};
  }

  private save(userId: string, data: UserData): void {
    this.store.set(userId, data);
  }

  // ---------- Emotion ----------

  getEmotion(userId: string): EmotionState {
    return emotionGetEmotion(this.load(userId), userId);
  }

  saveEmotion(userId: string, emotion: EmotionState): void {
    const data = this.load(userId);
    emotionUpdateEmotion(data, userId, emotion.toDict());
    this.save(userId, data);
  }

  applyDecay(userId: string, decayPerHour: number): EmotionState {
    const emotion = this.getEmotion(userId);
    const now = Date.now() / 1000;
    const hoursPassed = (now - emotion.lastUpdate) / 3600.0;
    if (hoursPassed > 0) {
      emotion.decay(decayPerHour * hoursPassed);
      this.saveEmotion(userId, emotion);
    }
    return emotion;
  }

  // ---------- Profile ----------

  getProfile(userId: string): UserProfile {
    const data = this.load(userId);
    const profile = profileGetProfile(data);
    if (!profile.userId) {
      profile.userId = userId;
    }
    return profile;
  }

  saveProfile(userId: string, profile: UserProfile): void {
    const data = this.load(userId);
    profileUpdateProfile(data, profile.toDict());
    this.save(userId, data);
  }

  touchProfile(userId: string, nickname: string): UserProfile {
    const profile = this.getProfile(userId);
    profile.lastSeen = Date.now() / 1000;
    if (nickname && !profile.nickname) {
      profile.nickname = nickname;
    }
    profile.chatCount += 1;
    this.saveProfile(userId, profile);
    return profile;
  }

  getAffinity(userId: string): number {
    return this.getProfile(userId).affinity;
  }

  getPersonaSnapshot(userId: string): Record<string, unknown> {
    const now = Date.now() / 1000;
    const emotion = this.getEmotion(userId);
    const profile = this.getProfile(userId);
    const effects = this.getActiveEffects(userId);
    const todos = this.getActiveTodos(userId);

    return {
      user_id: userId,
      emotion: emotion.toDict(),
      emotion_narrative: emotion.narrative(),
      affinity: profile.affinity,
      nickname: profile.nickname,
      chat_count: profile.chatCount,
      active_effects: effects.map((e) => ({
        id: e.id,
        type: e.effectType,
        source: e.sourceDetail,
        intensity: Math.round(e.currentIntensity(now) * 100) / 100,
        expires_at: e.expiresAt,
      })),
      active_todos: todos.map((t) => ({
        id: t.id,
        type: t.todoType,
        content: t.content,
        priority: t.priority,
      })),
    };
  }

  // ---------- Memory ----------

  getHistory(userId: string): ChatTurn[] {
    return historyGet(this.load(userId));
  }

  appendHistory(userId: string, role: string, content: string): void {
    const data = this.load(userId);
    const turn = new ChatTurn();
    turn.role = role;
    turn.content = content;
    turn.timestamp = Date.now() / 1000;
    historyAppend(data, turn.toDict());
    this.save(userId, data);
  }

  appendHistoryAndRecoverEmotion(
    userId: string,
    role: string,
    content: string,
    recovery: number,
  ): EmotionState {
    const data = this.load(userId);

    const turn = new ChatTurn();
    turn.role = role;
    turn.content = content;
    turn.timestamp = Date.now() / 1000;
    historyAppend(data, turn.toDict());

    const emotion = emotionGetEmotion(data, userId);
    emotion.onInteract(recovery);
    emotionUpdateEmotion(data, userId, emotion.toDict());

    this.save(userId, data);
    return emotion;
  }

  formatHistoryForPrompt(userId: string, maxTurns: number): string {
    const history = this.getHistory(userId);
    const turns = history.slice(-(maxTurns * 2));
    if (turns.length === 0) {
      return "";
    }
    const lines: string[] = [];
    for (const turn of turns) {
      const roleLabel = turn.role === "user" ? "用户" : "你";
      lines.push(`${roleLabel}: ${turn.content}`);
    }
    return lines.join("\n");
  }

  // ---------- Effect ----------

  getEffects(userId: string): Effect[] {
    const data = this.load(userId);
    const effectsData = data.effects ?? [];
    return effectsData.map((e) => Effect.fromDict(e));
  }

  addEffect(
    userId: string,
    effectType: string,
    intensity: number,
    sourceDetail: string,
    decayStyle = "linear",
    recoveryStyle = "social",
    durationHours = 6.0,
  ): Effect {
    const now = Date.now() / 1000;
    const effect = new Effect();
    effect.id = Math.random().toString(36).slice(2, 10);
    effect.effectType = effectType;
    effect.intensity = intensity;
    effect.sourceDetail = sourceDetail;
    effect.decayStyle = decayStyle;
    effect.recoveryStyle = recoveryStyle;
    effect.createdAt = now;
    effect.expiresAt = now + durationHours * 3600;

    const data = this.load(userId);
    const effects = data.effects ?? [];
    effects.push(effect.toDict());
    data.effects = effects;
    this.save(userId, data);
    return effect;
  }

  cleanupExpiredEffects(userId: string): number {
    const now = Date.now() / 1000;
    const data = this.load(userId);
    const effects = data.effects ?? [];
    const before = effects.length;
    const filtered = effects.filter((e) => ((e.expiresAt as number | undefined) ?? 0) > now);
    data.effects = filtered;
    this.save(userId, data);
    return before - filtered.length;
  }

  getActiveEffects(userId: string): Effect[] {
    const now = Date.now() / 1000;
    const effects = this.getEffects(userId);
    return effects.filter((e) => e.expiresAt > now && e.currentIntensity(now) > 5);
  }

  formatEffectsForPrompt(userId: string): string {
    const now = Date.now() / 1000;
    const effects = this.getActiveEffects(userId);
    const narratives = effects.map((e) => e.narrative(now)).filter((n) => n.length > 0);
    return narratives.join("，");
  }

  removeEffect(userId: string, effectId: string): boolean {
    const data = this.load(userId);
    const effects = data.effects ?? [];
    const before = effects.length;
    const filtered = effects.filter((e) => (e.id as string | undefined) !== effectId);
    data.effects = filtered;
    this.save(userId, data);
    return filtered.length < before;
  }

  // ---------- Todo ----------

  getTodos(userId: string): Todo[] {
    return todosGetByType(this.load(userId));
  }

  addTodo(userId: string, todoType: TodoTypeValue, content: string, priority = 0): Todo {
    const todo = new Todo();
    todo.id = Math.random().toString(36).slice(2, 10);
    todo.todoType = todoType;
    todo.content = content;
    todo.createdAt = Date.now() / 1000;
    todo.priority = priority;
    todo.done = false;

    const data = this.load(userId);
    todosAdd(data, todo.toDict());
    this.save(userId, data);
    return todo;
  }

  markTodoDone(userId: string, todoId: string): boolean {
    const data = this.load(userId);
    const found = todosComplete(data, todoId);
    if (found) {
      this.save(userId, data);
    }
    return found;
  }

  getActiveTodos(userId: string): Todo[] {
    return this.getTodos(userId).filter((t) => !t.done);
  }

  formatTodosForPrompt(userId: string): string {
    const todos = this.getActiveTodos(userId);
    if (todos.length === 0) {
      return "";
    }
    const lines: string[] = [];
    for (const t of todos) {
      const prefix = t.todoType === TodoType.INTERNAL ? "【生理】" : "【关系】";
      lines.push(`${prefix} ${t.content}`);
    }
    return lines.join("\n");
  }

  cleanupOldTodos(userId: string, maxAgeHours = 24.0): number {
    const now = Date.now() / 1000;
    const data = this.load(userId);
    const todos = data.todos ?? [];
    const before = todos.length;
    const filtered = todos.filter(
      (t) => (now - ((t.createdAt as number | undefined) ?? 0)) < maxAgeHours * 3600,
    );
    data.todos = filtered;
    this.save(userId, data);
    return before - filtered.length;
  }

  // ---------- Interaction ----------

  recordInteraction(
    userId: string,
    mode: typeof InteractionMode.ACTIVE | typeof InteractionMode.PASSIVE,
    outcome: InteractionOutcomeValue,
  ): void {
    const data = this.load(userId);
    const event = new InteractionEvent();
    event.mode = mode;
    event.outcome = outcome;
    event.timestamp = Date.now() / 1000;
    interactionsSave(data, event.toDict());
    this.save(userId, data);
  }

  getTodayInteractions(userId: string): InteractionEvent[] {
    const today = new Date().toISOString().slice(0, 10);
    const data = this.load(userId);
    const interactions = data.interactions ?? [];
    const result: InteractionEvent[] = [];
    for (const i of interactions) {
      const ts = (i.timestamp as number | undefined) ?? 0;
      const date = new Date(ts * 1000).toISOString().slice(0, 10);
      if (date === today) {
        result.push(InteractionEvent.fromDict(i));
      }
    }
    return result;
  }

  getHoursSinceLastInteraction(userId: string): number {
    const now = Date.now() / 1000;
    const data = this.load(userId);
    const interactions = data.interactions ?? [];
    if (interactions.length > 0) {
      const last = interactions[interactions.length - 1];
      const lastTs = last ? ((last.timestamp as number | undefined) ?? 0.0) : 0.0;
      if (lastTs > 0) {
        return (now - lastTs) / 3600.0;
      }
    }
    const profile = this.getProfile(userId);
    if (profile.lastSeen > 0) {
      return (now - profile.lastSeen) / 3600.0;
    }
    return 0.0;
  }

  clearInteractions(userId: string): void {
    const data = this.load(userId);
    data.interactions = [];
    this.save(userId, data);
  }

  // ---------- Consolidation ----------

  getConsolidations(userId: string): Consolidation[] {
    const data = this.load(userId);
    const consData = data.consolidations ?? [];
    return consData.map((c) => Consolidation.fromDict(c));
  }

  getLastConsolidation(userId: string): Consolidation | undefined {
    const cons = this.getConsolidations(userId);
    return cons[cons.length - 1];
  }

  runConsolidation(userId: string, date?: string): Consolidation {
    const targetDate = date ?? new Date().toISOString().slice(0, 10);
    const interactions = this.getTodayInteractions(userId);

    const connected = interactions.filter(
      (i) => i.outcome === InteractionOutcome.CONNECTED,
    ).length;
    const missed = interactions.filter(
      (i) => i.outcome === InteractionOutcome.MISSED,
    ).length;
    const active = interactions.filter((i) => i.mode === InteractionMode.ACTIVE).length;
    const passive = interactions.filter((i) => i.mode === InteractionMode.PASSIVE).length;
    const awkward = interactions.filter(
      (i) => i.outcome === InteractionOutcome.AWKWARD,
    ).length;
    const relief = interactions.filter(
      (i) => i.outcome === InteractionOutcome.RELIEF,
    ).length;

    let trajectory: string;
    let shiftHint: string;

    if (missed >= connected && missed > 0) {
      trajectory = "gap";
      shiftHint = "今天有点落差，主动搭话但没被接上";
    } else if (connected > missed && connected >= 2) {
      trajectory = "upward";
      shiftHint = "今天聊得挺开心的";
    } else if (active === 0 && passive === 0) {
      trajectory = "alone";
      shiftHint = "今天没怎么说话";
    } else if (awkward > relief) {
      trajectory = "gap";
      shiftHint = "今天有些尴尬的时刻";
    } else if (relief > 0) {
      trajectory = "steady";
      shiftHint = "今天气氛还算平稳";
    } else {
      trajectory = "flat";
      shiftHint = "今天平平淡淡";
    }

    const cons = new Consolidation();
    cons.date = targetDate;
    cons.connectedCount = connected;
    cons.missedCount = missed;
    cons.activeCount = active;
    cons.passiveCount = passive;
    cons.awkwardCount = awkward;
    cons.reliefCount = relief;
    cons.trajectory = trajectory;
    cons.shiftHint = shiftHint;

    const data = this.load(userId);
    consolidationsProcess(data, cons.toDict(), targetDate);
    this.save(userId, data);
    this.clearInteractions(userId);
    return cons;
  }

  // ---------- Admin ----------

  resetUser(userId: string): void {
    this.store.delete(userId);
  }

  listUsers(): string[] {
    return this.store.keys();
  }

  // ---------- Session (UMO) ----------

  saveUmo(userId: string, umo: string): void {
    const data = this.load(userId);
    data.umo = umo;
    this.save(userId, data);
  }

  getUmo(userId: string): string {
    const data = this.load(userId);
    return data.umo ?? "";
  }

  getProactiveFailureUntil(userId: string): number {
    const data = this.load(userId);
    const failure = data.proactive_failure;
    if (!failure) {
      return 0.0;
    }
    try {
      return Number(failure.until ?? 0);
    } catch {
      return 0.0;
    }
  }

  setProactiveFailure(userId: string, until: number, reason: string): void {
    const data = this.load(userId);
    data.proactive_failure = { until, reason };
    this.save(userId, data);
  }

  clearProactiveFailure(userId: string): void {
    const data = this.load(userId);
    if (data.proactive_failure !== undefined) {
      delete data.proactive_failure;
      this.save(userId, data);
    }
  }

  // ---------- Reflection ----------

  getReflections(userId: string): ReflectionRecord[] {
    return reflectionsGetAll(this.load(userId));
  }

  addReflection(
    userId: string,
    trigger: string,
    note: string,
    factsStr = "",
    bias = "",
  ): ReflectionRecord {
    const record = new ReflectionRecord();
    record.id = Math.random().toString(36).slice(2, 10);
    record.trigger = trigger;
    record.note = note;
    record.factsStr = factsStr;
    record.bias = bias;

    const data = this.load(userId);
    reflectionsSave(data, record.toDict());
    this.save(userId, data);
    return record;
  }

  getLatestReflection(userId: string): ReflectionRecord | undefined {
    const reflections = this.getReflections(userId);
    return reflections[reflections.length - 1];
  }

  getUnconsumedReflection(userId: string): ReflectionRecord | undefined {
    const data = this.load(userId);
    const reflections = data.reflections ?? [];
    for (const r of reflections) {
      if (!(r.consumed as boolean | undefined)) {
        r.consumed = true;
        this.save(userId, data);
        return ReflectionRecord.fromDict(r);
      }
    }
    return undefined;
  }

  clearReflections(userId: string): void {
    const data = this.load(userId);
    data.reflections = [];
    this.save(userId, data);
  }

  // ---------- Profile Facts ----------

  getProfileFacts(userId: string): ProfileFact[] {
    return profileGetAllFacts(this.load(userId));
  }

  addProfileFact(
    userId: string,
    category: string,
    content: string,
    evidence = "",
    confidence = 1.0,
  ): ProfileFact {
    const fact = new ProfileFact();
    fact.id = Math.random().toString(36).slice(2, 10);
    fact.category = category;
    fact.content = content;
    fact.evidence = evidence;
    fact.confidence = confidence;

    const data = this.load(userId);
    const existing = profileAddFact(data, fact.toDict());
    if (existing) {
      return existing;
    }
    this.save(userId, data);
    return fact;
  }

  removeProfileFact(userId: string, factId: string): boolean {
    const data = this.load(userId);
    const facts = data.profile_facts ?? [];
    const before = facts.length;
    const filtered = facts.filter((f) => (f.id as string | undefined) !== factId);
    data.profile_facts = filtered;
    this.save(userId, data);
    return filtered.length < before;
  }

  formatProfileFactsForPrompt(userId: string): string {
    const facts = this.getProfileFacts(userId);
    if (facts.length === 0) {
      return "";
    }
    const lines: string[] = [];
    for (const f of facts) {
      lines.push(`  · [${f.category}] ${f.content}`);
    }
    return lines.join("\n");
  }

  // ---------- Turn Counters ----------

  getTurnCounter(userId: string, key: string): number {
    const data = this.load(userId);
    return data.turn_counters?.[key] ?? 0;
  }

  incrementTurnCounter(userId: string, key: string): number {
    const data = this.load(userId);
    const counters = data.turn_counters ?? {};
    counters[key] = (counters[key] ?? 0) + 1;
    data.turn_counters = counters;
    this.save(userId, data);
    return counters[key];
  }

  resetTurnCounter(userId: string, key: string): void {
    const data = this.load(userId);
    const counters = data.turn_counters ?? {};
    counters[key] = 0;
    data.turn_counters = counters;
    this.save(userId, data);
  }
}
