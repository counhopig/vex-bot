/**
 * Vex - Smart assistant for Chinese AI models + Chinese communication platforms
 *
 * Main entry point
 */

// Type exports
export * from "./types/index.js";

// Config
export { loadConfig, validateRequiredConfig } from "./config/index.js";

// Model providers
export {
  initializeProviders,
  getAllProviders,
  getAllModels,
  resolveModel,
  getApiKeyForProvider,
  isProviderAvailable,
} from "./providers/index.js";

// Channels
export {
  BaseChannelAdapter,
  createWeixinChannel,
  registerChannel,
  getChannel,
  getAllChannels,
  setGlobalMessageHandler,
} from "./channels/index.js";

// Agent
export {
  Agent,
  createAgent,
} from "./agents/index.js";

// Tools
export {
  type Tool,
  type ToolCall,
  type ToolCallResult,
  type ToolResult,
  type ToolPolicy,
  registerTool,
  registerTools,
  getTool,
  getAllTools,
  filterToolsByPolicy,
  createBuiltinTools,
  jsonResult,
  errorResult,
  textResult,
} from "./tools/index.js";

// Hooks
export {
  type HookEventType,
  type HookEvent,
  type HookHandler,
  registerHook,
  registerHooks,
  triggerHook,
  triggerHookSync,
  clearHooks,
  getHookCount,
  emitMessageReceived,
  emitMessageSending,
  emitAgentStart,
  emitAgentEnd,
  emitToolStart,
  emitToolEnd,
  emitError,
} from "./hooks/index.js";

// Plugins
export {
  type PluginMeta,
  type PluginApi,
  type PluginDefinition,
  registerPlugin,
  unregisterPlugin,
  getLoadedPlugins,
  isPluginLoaded,
  unregisterAllPlugins,
  definePlugin,
  defineToolPlugin,
} from "./plugins/index.js";

// Commands
export {
  type CommandContext,
  type CommandHandler,
  type CommandDefinition,
  registerCommand,
  registerCommands,
  getCommand,
  getAllCommands,
  isCommand,
  parseCommand,
  executeCommand,
  registerBuiltinCommands,
} from "./commands/index.js";

// Gateway
export { Gateway, createGateway, startGateway } from "./gateway/index.js";

// Utils
export { getLogger, createLogger, setLogger, getChildLogger } from "./utils/logger.js";
export {
  generateId,
  getEnvVar,
  requireEnvVar,
  delay,
  retry,
  truncate,
  safeJsonParse,
  deepMerge,
  computeHmacSha256,
  aesDecrypt,
} from "./utils/index.js";

// Memory
export {
  MemoryManager,
  createMemoryManager,
  JsonMemoryStore,
  SimpleEmbedding,
  type MemoryEntry,
  type MemoryStore,
  type EmbeddingProvider,
} from "./memory/index.js";

// Outbound (proactive message sending)
export {
  deliverMessage,
  deliverMessages,
  deliverOutboundPayloads,
  sendText,
  parseDeliveryTarget,
  getAvailableChannels,
  isChannelAvailable,
  type DeliveryTarget,
  type DeliveryPayload,
  type DeliveryOptions,
  type DeliveryResult,
} from "./outbound/index.js";

// Cron (scheduled tasks)
export {
  CronService,
  getCronService,
  CronStore,
  createCronExecutor,
  createDefaultCronExecuteJob,
  computeNextRunAtMs,
  computeJobNextRunAtMs,
  validateCronExpr,
  formatSchedule,
  type CronJob,
  type CronJobCreate,
  type CronJobUpdate,
  type CronSchedule,
  type CronPayload,
  type PayloadSystemEvent,
  type PayloadAgentTurn,
  type CronEvent,
  type CronExecutionResult,
  type AgentExecutor,
} from "./cron/index.js";
