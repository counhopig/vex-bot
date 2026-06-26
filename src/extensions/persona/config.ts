/**
 * 配置层：Persona 插件配置项
 */

export interface PersonaConfig {
  personaName: string;
  personaBasePrompt: string;
  personaReplyStyle: string;
  timeAwarenessEnabled: boolean;
  emotionEnabled: boolean;
  emotionDecayPerHour: number;
  emotionRecoveryPerReply: number;
  emotionInjectionStyle: string;
  emotionDecayCron: string;
  effectEnabled: boolean;
  effectAutoTrigger: boolean;
  todoEnabled: boolean;
  todoAutoTrigger: boolean;
  consolidationEnabled: boolean;
  memoryEnabled: boolean;
  memoryMaxTurns: number;
  profileEnabled: boolean;
  reflectionEnabled: boolean;
  reflectionTriggerTurns: number;
  reflectionHistoryTurns: number;
  reflectionPeriodicCron: string;
  profileBuildingEnabled: boolean;
  profileBuildingTriggerTurns: number;
  ignoreGroupChat: boolean;
  greetingOnFirstChat: boolean;
  goodnightHintEnabled: boolean;
  proactiveNudgeEnabled: boolean;
  proactiveNudgeCron: string;
  restEnabled: boolean;
  restSleepHour: number;
  restWakeHour: number;
  storageCacheMax: number;
  debugLogEnabled: boolean;
  adminIds?: string[];
}

export function createPersonaConfig(raw: object | undefined): PersonaConfig {
  const c: Record<string, unknown> = raw ? { ...raw } : {};
  return {
    personaName: typeof c.persona_name === "string" ? c.persona_name : "小忆",
    personaBasePrompt:
      typeof c.persona_base_prompt === "string"
        ? c.persona_base_prompt
        : "你是一个温柔细腻、略带毒舌但内心柔软的少女。你喜欢倾听，偶尔也会吐槽。你说话自然、口语化，不用太正式。你记得和用户之间的点滴，会在合适的时候提起往事。",
    personaReplyStyle:
      typeof c.persona_reply_style === "string"
        ? c.persona_reply_style
        : "用自然、口语化的方式回复，不要 robotic。偶尔可以用 emoji 或语气词表达情绪。回复不要太长，保持在 2~4 句话左右。",
    timeAwarenessEnabled: typeof c.time_awareness_enabled === "boolean" ? c.time_awareness_enabled : true,
    emotionEnabled: typeof c.emotion_enabled === "boolean" ? c.emotion_enabled : true,
    emotionDecayPerHour: typeof c.emotion_decay_per_hour === "number" ? c.emotion_decay_per_hour : 2.0,
    emotionRecoveryPerReply: typeof c.emotion_recovery_per_reply === "number" ? c.emotion_recovery_per_reply : 3.0,
    emotionInjectionStyle: typeof c.emotion_injection_style === "string" ? c.emotion_injection_style : "narrative",
    emotionDecayCron: typeof c.emotion_decay_cron === "string" ? c.emotion_decay_cron : "0 * * * *",
    effectEnabled: typeof c.effect_enabled === "boolean" ? c.effect_enabled : true,
    effectAutoTrigger: typeof c.effect_auto_trigger === "boolean" ? c.effect_auto_trigger : true,
    todoEnabled: typeof c.todo_enabled === "boolean" ? c.todo_enabled : true,
    todoAutoTrigger: typeof c.todo_auto_trigger === "boolean" ? c.todo_auto_trigger : true,
    consolidationEnabled: typeof c.consolidation_enabled === "boolean" ? c.consolidation_enabled : true,
    memoryEnabled: typeof c.memory_enabled === "boolean" ? c.memory_enabled : true,
    memoryMaxTurns: typeof c.memory_max_turns === "number" ? c.memory_max_turns : 10,
    profileEnabled: typeof c.profile_enabled === "boolean" ? c.profile_enabled : true,
    reflectionEnabled: typeof c.reflection_enabled === "boolean" ? c.reflection_enabled : true,
    reflectionTriggerTurns: typeof c.reflection_trigger_turns === "number" ? c.reflection_trigger_turns : 10,
    reflectionHistoryTurns: typeof c.reflection_history_turns === "number" ? c.reflection_history_turns : 20,
    reflectionPeriodicCron: typeof c.reflection_periodic_cron === "string" ? c.reflection_periodic_cron : "0 */6 * * *",
    profileBuildingEnabled: typeof c.profile_building_enabled === "boolean" ? c.profile_building_enabled : true,
    profileBuildingTriggerTurns: typeof c.profile_building_trigger_turns === "number" ? c.profile_building_trigger_turns : 5,
    ignoreGroupChat: typeof c.ignore_group_chat === "boolean" ? c.ignore_group_chat : true,
    greetingOnFirstChat: typeof c.greeting_on_first_chat === "boolean" ? c.greeting_on_first_chat : true,
    goodnightHintEnabled: typeof c.goodnight_hint_enabled === "boolean" ? c.goodnight_hint_enabled : true,
    proactiveNudgeEnabled: typeof c.proactive_nudge_enabled === "boolean" ? c.proactive_nudge_enabled : true,
    proactiveNudgeCron: typeof c.proactive_nudge_cron === "string" ? c.proactive_nudge_cron : "0 * * * *",
    restEnabled: typeof c.rest_enabled === "boolean" ? c.rest_enabled : true,
    restSleepHour: typeof c.rest_sleep_hour === "number" ? c.rest_sleep_hour : 23,
    restWakeHour: typeof c.rest_wake_hour === "number" ? c.rest_wake_hour : 7,
    storageCacheMax: typeof c.storage_cache_max === "number" ? c.storage_cache_max : 200,
    debugLogEnabled: typeof c.debug_log_enabled === "boolean" ? c.debug_log_enabled : false,
    adminIds: Array.isArray(c.admin_ids) ? c.admin_ids.filter((s): s is string => typeof s === "string") : undefined,
  };
}

export function isSleeping(cfg: PersonaConfig, hour?: number): boolean {
  const h = hour ?? new Date().getHours();
  const sleepH = cfg.restSleepHour;
  const wakeH = cfg.restWakeHour;
  if (sleepH <= wakeH) {
    return sleepH <= h && h < wakeH;
  } else {
    return sleepH <= h || h < wakeH;
  }
}
