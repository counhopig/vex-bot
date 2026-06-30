/**
 * Core type definitions
 */

// ============== Model-related Types ==============

/** Supported model API types */
export type ModelApi =
  | "openai-compatible"      // OpenAI-compatible interface (DeepSeek, Kimi, Stepfun)
  | "openai"                 // OpenAI native/compatible interface (custom)
  | "anthropic"              // Anthropic-compatible interface (custom)
  | "minimax-v1"             // MiniMax native interface
  | "anthropic-messages";    // Anthropic messages interface

/** Model provider ID */
export type ProviderId =
  | "deepseek" | "doubao" | "minimax" | "kimi" | "stepfun" | "modelscope" | "dashscope" | "zhipu" | "longcat"
  | "openai" | "ollama" | "openrouter" | "together" | "groq"
  | "azure-openai" | "vllm"
  | "custom-openai" | "custom-anthropic";

/** Model definition */
export interface ModelDefinition {
  id: string;
  name: string;
  provider: ProviderId;
  api: ModelApi;
  contextWindow: number;
  maxTokens: number;
  supportsVision: boolean;
  supportsReasoning: boolean;
  /** Whether tool calls are supported (default true) */
  supportsToolCalls?: boolean;
  cost?: {
    input: number;   // Cost per million tokens
    output: number;
    cacheRead?: number;
  };
}

/** Simplified provider config (for user configuration) */
export interface SimpleProviderConfig {
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  groupId?: string;  // MiniMax specific
}

// ============== Message-related Types ==============

/** Message role */
export type MessageRole = "system" | "user" | "assistant" | "tool";

/** Content type */
export type ContentType = "text" | "image";

/** Text content */
export interface TextContent {
  type: "text";
  text: string;
}

/** Image content */
export interface ImageContent {
  type: "image";
  url?: string;
  base64?: string;
  mediaType?: string;
}

/** Message content */
export type MessageContent = TextContent | ImageContent;

/** Tool call (in assistant messages) */
export interface MessageToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;  // JSON string
  };
}

/** Chat message */
export interface ChatMessage {
  role: MessageRole;
  content: string | MessageContent[] | null;
  /** Tool calls in assistant messages */
  tool_calls?: MessageToolCall[];
  /** Tool call ID in tool messages */
  tool_call_id?: string;
  /** Tool name in tool messages */
  name?: string;
}

// ============== Channel-related Types ==============

/** Channel ID */
export type ChannelId = "weixin" | "webchat";

/** Chat type */
export type ChatType = "direct" | "group";

/** Channel capabilities */
export interface ChannelCapabilities {
  chatTypes: ChatType[];
  supportsMedia: boolean;
  supportsReply: boolean;
  supportsMention: boolean;
  supportsReaction: boolean;
  supportsThread: boolean;
  supportsEdit: boolean;
  maxMessageLength: number;
}

/** Channel metadata */
export interface ChannelMeta {
  id: ChannelId;
  name: string;
  description: string;
  capabilities: ChannelCapabilities;
}

/** Inbound message context */
export interface InboundMessageContext {
  channelId: ChannelId;
  messageId: string;
  chatId: string;
  chatType: ChatType;
  senderId: string;
  senderName?: string;
  content: string;
  mediaUrls?: string[];
  replyToId?: string;
  mentions?: string[];
  timestamp: number;
  raw?: unknown;
}

/** Outbound message */
export interface OutboundMessage {
  chatId: string;
  content: string;
  replyToId?: string;
  mediaUrls?: string[];
  mentions?: string[];
}

/** Send result */
export interface SendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

// ============== Config-related Types ==============

/** Personal WeChat (iLink OC) config */
export interface WeixinConfig {
  /** API base URL, default https://ilinkai.weixin.qq.com */
  baseUrl?: string;
  /** Bot token (bot_token obtained after QR code login) */
  token?: string;
  /** iLink Bot ID */
  accountId?: string;
  /** Bot type, default "3" */
  botType?: string;
  /** QR code polling interval (seconds), default 1 */
  qrPollInterval?: number;
  /** Long poll timeout (milliseconds), default 35000 */
  longPollTimeoutMs?: number;
  /** API request timeout (milliseconds), default 120000 */
  apiTimeoutMs?: number;
  /** CDN base URL, default https://novac2c.cdn.weixin.qq.com/c2c */
  cdnBaseUrl?: string;
  /** Whether the channel is enabled */
  enabled?: boolean;
}

/** Agent config */
export interface AgentConfig {
  defaultModel: string;
  defaultProvider: ProviderId;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  /** Working directory */
  workingDirectory?: string;
  /** Whether function calling is enabled */
  enableFunctionCalling?: boolean;
}

/** Session store config */
export interface SessionStoreConfig {
  /** Store type */
  type: "memory" | "file";
  /** File store directory */
  directory?: string;
  /** Session TTL (milliseconds) */
  ttlMs?: number;
}

/** Memory config */
export interface MemoryConfig {
  enabled?: boolean;
  /** Storage directory */
  directory?: string;
  /** Embedding model */
  embeddingModel?: string;
  /** Embedding provider */
  embeddingProvider?: ProviderId;
}

/** Skill Learner config */
export interface SkillLearnerConfig {
  enabled?: boolean;
  autoTriggerKeywords?: string[];
  maxLearningTurns?: number;
  enableAutoLearn?: boolean;
  enableProactiveSuggest?: boolean;
  proactiveThreshold?: number;
  autoDeployToSkills?: boolean;
}

/** ShareLink config */
export interface ShareLinkConfig {
  enabled?: boolean;
  responseMode?: "simple" | "detailed";
  includeDescription?: boolean;
  includeCover?: boolean;
  descriptionMaxLength?: number;
  bilibiliCookie?: {
    sessdata?: string;
    biliJct?: string;
  };
  summarizeProviderId?: ProviderId;
  sttProviderId?: ProviderId;
  audioDownloadTimeout?: number;
  subtitleMaxLength?: number;
  llmShortContentThreshold?: number;
  llmChunkSize?: number;
  autoDetect?: boolean;
}

/** Persona config */
export interface PersonaConfig {
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
  ignore_group_chat?: boolean;
  greeting_on_first_chat?: boolean;
  goodnight_hint_enabled?: boolean;
  proactive_nudge_enabled?: boolean;
  proactive_nudge_cron?: string;
  rest_enabled?: boolean;
  rest_sleep_hour?: number;
  rest_wake_hour?: number;
  storage_cache_max?: number;
  debug_log_enabled?: boolean;
  admin_ids?: string[];
}

/** Main config */
export interface VexConfig {
  providers: Record<string, SimpleProviderConfig | Record<string, unknown>>;
  channels: {
    weixin?: WeixinConfig;
  };
  agent: AgentConfig;
  server: {
    port: number;
    host?: string;
  };
  logging: {
    level: "debug" | "info" | "warn" | "error";
  };
  /** Session store config */
  sessions?: SessionStoreConfig;
  /** Memory config */
  memory?: MemoryConfig;
  /** Skills config */
  skills?: {
    enabled?: boolean;
    userDir?: string;
    workspaceDir?: string;
    disabled?: string[];
    only?: string[];
  };
  /** Skill Learner config */
  skillLearner?: SkillLearnerConfig;
  /** ShareLink config */
  sharelink?: ShareLinkConfig;
  /** Persona config */
  persona?: PersonaConfig;
}

// ============== Event-related Types ==============

/** Event type */
export type EventType =
  | "message_received"
  | "message_sent"
  | "error"
  | "channel_connected"
  | "channel_disconnected";

/** Event handler */
export type EventHandler<T = unknown> = (data: T) => void | Promise<void>;

// ============== Error Types ==============

/** Vex error */
export class VexError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: unknown
  ) {
    super(message);
    this.name = "VexError";
  }
}

/** Provider error */
export class ProviderError extends VexError {
  constructor(
    message: string,
    public provider: ProviderId,
    details?: unknown
  ) {
    super(message, "PROVIDER_ERROR", details);
    this.name = "ProviderError";
  }
}

/** Channel error */
export class ChannelError extends VexError {
  constructor(
    message: string,
    public channel: ChannelId,
    details?: unknown
  ) {
    super(message, "CHANNEL_ERROR", details);
    this.name = "ChannelError";
  }
}
