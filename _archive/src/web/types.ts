/**
 * Web module type definitions
 */

/** WebSocket request frame */
export interface WsRequestFrame {
  type: "req";
  id: string;
  method: string;
  params?: unknown;
}

/** WebSocket response frame */
export interface WsResponseFrame {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: {
    code: string;
    message: string;
    /** HTTP-equivalent status when the failure is a typed HttpError (401/403/404/...). */
    status?: number;
    details?: unknown;
  };
}

/** WebSocket event frame */
export interface WsEventFrame {
  type: "event";
  event: string;
  payload?: unknown;
}

/** WebSocket frame type */
export type WsFrame = WsRequestFrame | WsResponseFrame | WsEventFrame;

/** Chat message */
export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
}

/** Chat send request params */
export interface ChatSendParams {
  message: string;
  sessionKey?: string;
}

/** Session list request params */
export interface SessionsListParams {
  limit?: number;
  activeMinutes?: number;
  search?: string;
}

/** Session history request params */
export interface SessionsHistoryParams {
  sessionKey: string;
}

/** Session delete request params */
export interface SessionsDeleteParams {
  sessionKey: string;
}

/** Session reset request params */
export interface SessionsResetParams {
  sessionKey: string;
}

/** Session restore request params */
export interface SessionsRestoreParams {
  sessionKey: string;
}

/** Chat stream delta event */
export interface ChatDeltaEvent {
  sessionId: string;
  delta: string;
  done: boolean;
  /** Whether the user cancelled */
  cancelled?: boolean;
}

/** Session information */
export interface SessionInfo {
  id: string;
  messageCount: number;
  lastUpdate: number;
  provider: string;
  model: string;
}

/** System status */
export interface SystemStatus {
  version: string;
  uptime: number;
  providers: Array<{
    id: string;
    name: string;
    available: boolean;
  }>;
  channels: Array<{
    id: string;
    name: string;
    connected: boolean;
  }>;
  sessions: number;
}

/** Configuration information */
export interface ConfigInfo {
  providers: Record<string, ProviderConfigInfo>;
  channels: Record<string, ChannelConfigInfo>;
  agent: AgentConfigInfo;
  server: ServerConfigInfo;
  logging: LoggingConfigInfo;
  memory: MemoryConfigInfo;
  skills: SkillsConfigInfo;
  persona?: PersonaConfigInfo;
  skillLearner?: SkillLearnerConfigInfo;
  sharelink?: ShareLinkConfigInfo;
  weather?: WeatherConfigInfo;
  sessions?: SessionsConfigInfo;
}

/** Provider config info (redacted) */
export interface ProviderConfigInfo {
  id: string;
  name?: string;
  baseUrl?: string;
  hasApiKey: boolean;
  groupId?: string;
}

/** Channel config info (redacted) */
export interface ChannelConfigInfo {
  id: string;
  name: string;
  hasConfig: boolean;
  enabled?: boolean;
  baseUrl?: string;
  botType?: string;
  accountId?: string;
  hasToken?: boolean;
}

/** Agent Configuration information */
export interface AgentConfigInfo {
  defaultProvider: string;
  defaultModel: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
}

/** Server config info */
export interface ServerConfigInfo {
  port: number;
  host: string;
}

/** Logging config info */
export interface LoggingConfigInfo {
  level: "debug" | "info" | "warn" | "error";
}

/** Memory system config info */
export interface MemoryConfigInfo {
  enabled?: boolean;
  directory?: string;
  embeddingModel?: string;
  embeddingProvider?: string;
}

/** Skills Configuration information */
export interface SkillsConfigInfo {
  enabled?: boolean;
  userDir?: string;
  workspaceDir?: string;
  disabled?: string[];
  only?: string[];
}

/** Persona (bot personality) config info */
export interface PersonaConfigInfo {
  enabled?: boolean;
  persona_name?: string;
  persona_base_prompt?: string;
  persona_reply_style?: string;
  time_awareness_enabled?: boolean;
  emotion_enabled?: boolean;
  emotion_decay_per_hour?: number;
  emotion_recovery_per_reply?: number;
  emotion_injection_style?: string;
  emotion_decay_cron?: string;
  effect_enabled?: boolean;
  effect_auto_trigger?: boolean;
  todo_enabled?: boolean;
  todo_auto_trigger?: boolean;
  consolidation_enabled?: boolean;
  memory_enabled?: boolean;
  memory_max_turns?: number;
  profile_enabled?: boolean;
  reflection_enabled?: boolean;
  reflection_trigger_turns?: number;
  reflection_history_turns?: number;
  reflection_periodic_cron?: string;
  profile_building_enabled?: boolean;
  profile_building_trigger_turns?: number;
  greeting_on_first_chat?: boolean;
  goodnight_hint_enabled?: boolean;
  proactive_nudge_enabled?: boolean;
  proactive_nudge_cron?: string;
  rest_enabled?: boolean;
  rest_sleep_hour?: number;
  rest_wake_hour?: number;
  storage_cache_max?: number;
  debug_log_enabled?: boolean;
}

/** Skill Learner config info */
export interface SkillLearnerConfigInfo {
  enabled?: boolean;
  autoTriggerKeywords?: string[];
  maxLearningTurns?: number;
  enableAutoLearn?: boolean;
  enableProactiveSuggest?: boolean;
  proactiveThreshold?: number;
  autoDeployToSkills?: boolean;
}

/** ShareLink config info (sensitive cookie fields redacted) */
export interface ShareLinkConfigInfo {
  enabled?: boolean;
  responseMode?: "simple" | "detailed";
  includeDescription?: boolean;
  includeCover?: boolean;
  descriptionMaxLength?: number;
  hasBilibiliCookie?: boolean;
  summarizeProviderId?: string;
  sttProviderId?: string;
  audioDownloadTimeout?: number;
  subtitleMaxLength?: number;
  llmShortContentThreshold?: number;
  llmChunkSize?: number;
  autoDetect?: boolean;
}

/** Weather tool config info (sensitive API key redacted) */
export interface WeatherConfigInfo {
  weather_provider?: "wttr" | "caiyun";
  caiyun_api_version?: "v2.6" | "v3";
  wttr_base_url?: string;
  default_location?: string;
  request_timeout_ms?: number;
  cache_ttl_ms?: number;
  hasCaiyunApiKey?: boolean;
}

/** Sessions store config info */
export interface SessionsConfigInfo {
  type?: "memory" | "file";
  directory?: string;
  ttlMs?: number;
}

/** Save config request params */
export interface ConfigSaveParams {
  providers?: Record<string, ProviderConfigInfo>;
  channels?: Record<string, Partial<ChannelConfigInfo> & {
    hasConfig: boolean;
    baseUrl?: string;
    botType?: string;
    accountId?: string;
  }>;
  agent?: AgentConfigInfo;
  server?: ServerConfigInfo;
  logging?: LoggingConfigInfo;
  memory?: MemoryConfigInfo;
  skills?: SkillsConfigInfo;
  persona?: PersonaConfigInfo;
  skillLearner?: SkillLearnerConfigInfo;
  sharelink?: ShareLinkConfigInfo & {
    /** Raw bilibili cookie, only sent when user explicitly edits it */
    bilibiliCookie?: { sessdata?: string; biliJct?: string };
  };
  weather?: WeatherConfigInfo & {
    /** Raw Caiyun API key, only sent when user explicitly edits it */
    caiyun_api_key?: string;
  };
  sessions?: SessionsConfigInfo;
  rawYaml?: string;
}

/** Config validation result */
export interface ConfigValidateResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}
