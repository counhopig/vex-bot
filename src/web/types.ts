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

/** Save config request params */
export interface ConfigSaveParams {
  providers?: Record<string, ProviderConfigInfo>;
  channels?: Record<string, ChannelConfigInfo & {
    baseUrl?: string;
    botType?: string;
  }>;
  agent?: AgentConfigInfo;
  server?: ServerConfigInfo;
  logging?: LoggingConfigInfo;
  memory?: MemoryConfigInfo;
  skills?: SkillsConfigInfo;
}

/** Config validation result */
export interface ConfigValidateResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}
