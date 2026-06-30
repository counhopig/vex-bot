# Vex API Reference

**Version:** Based on commit `b7bf46a` (main branch)
**Generated:** 2026-06-25

Vex (`vex-bot`) is a lightweight AI chatbot framework built for the Chinese AI model and communication software ecosystem. Built on `@mariozechner/pi-coding-agent` (agent runtime) and `@mariozechner/pi-ai` (LLM abstraction). This document catalogs every public export in the framework, organized by module.

---

## Table of Contents

1. [Agent](#1-agent)
2. [Gateway](#2-gateway)
3. [Types](#3-types)
4. [Plugins](#4-plugins)
5. [Tools](#5-tools)
6. [Skills](#6-skills)
7. [Memory](#7-memory)
8. [Cron](#8-cron)
9. [Outbound](#9-outbound)
10. [Hooks](#10-hooks)
11. [Config](#11-config)
12. [Providers](#12-providers)
13. [Channels](#13-channels)
14. [CLI](#14-cli)
15. [Top-Level Exports](#15-top-level-exports)

---

## 1. Agent

Agent is the core intelligence module, responsible for message processing, tool calling, and session management. Built on top of `@mariozechner/pi-coding-agent`'s `AgentRuntime`.

**Source:** `src/agents/agent.ts`, `src/agents/runtime.ts`

### Classes

#### `Agent`

Top-level agent class wrapping `AgentRuntime`. Manages tool initialization, skill registration, and session lifecycle.

```typescript
class Agent {
  constructor(runtime: AgentRuntime, options: AgentOptions)

  // Process a message (non-streaming), returns complete response
  processMessage(context: InboundMessageContext): Promise<AgentResponse>

  // Process a message with streaming, yielding text deltas
  processMessageStream(
    context: InboundMessageContext,
    options?: { signal?: AbortSignal }
  ): AsyncGenerator<string, AgentResponse, unknown>

  // Clear conversation history for a session
  clearSession(context: InboundMessageContext): void

  // Get session information (message count, last update, etc.)
  getSessionInfo(context: InboundMessageContext): {
    messageCount: number;
    estimatedTokens: number;
    hasSummary: boolean;
    lastUpdate: Date;
  } | null

  // Restore a session from historical transcript
  restoreSessionFromTranscript(
    sessionKey: string,
    messages: Array<{ role: "user" | "assistant"; content: string }>
  ): void

  // Register a custom tool
  registerTool(tool: AgentTool): void

  // Set skills registry to inject skills into system prompt
  setSkillsRegistry(registry: SkillsRegistry): void
}
```

**Constructor behavior:** When `enableTools` is `true`, the constructor automatically initializes built-in tools (filesystem, bash, browser, memory, etc.) and registers them with the underlying `AgentRuntime`.

#### `AgentRuntime`

Session management engine based on `@mariozechner/pi-coding-agent`. Handles model invocation, session persistence, and streaming output.

```typescript
class AgentRuntime {
  constructor(config: RuntimeConfig)

  // Non-streaming chat
  chat(context: InboundMessageContext): Promise<ChatResponse>

  // Streaming chat, yields StreamEvent values
  chatStream(
    context: InboundMessageContext,
    options?: { signal?: AbortSignal }
  ): AsyncGenerator<StreamEvent, ChatResponse, unknown>

  // Clear a session
  clearSession(context: InboundMessageContext): Promise<void>

  // Get session info
  getSessionInfo(context: InboundMessageContext): {
    messageCount: number;
    lastUpdate: Date;
  } | null

  // Restore session from historical messages
  restoreSessionFromTranscript(
    sessionKey: string,
    messages: Array<{ role: "user" | "assistant"; content: string }>
  ): Promise<void>

  // Shut down all sessions
  shutdown(): Promise<void>

  // Set skills registry
  setSkillsRegistry(registry: SkillsRegistry): void

  // Register a custom tool
  registerCustomTool(tool: AgentTool): void
}
```

### Interfaces

#### `AgentOptions`

Agent constructor configuration.

```typescript
interface AgentOptions {
  model: string;                     // Model ID (required)
  provider?: ProviderId;             // Model provider
  systemPrompt?: string;             // System prompt
  temperature?: number;              // Sampling temperature
  maxTokens?: number;                // Max generation tokens
  maxHistoryMessages?: number;       // Max history messages to keep
  maxHistoryTurns?: number;          // Max history turns to keep
  contextWindow?: number;            // Context window size
  enableTools?: boolean;             // Enable built-in tools
  toolPolicy?: { allow?: string[]; deny?: string[] };  // Tool allow/deny list
  enableCompaction?: boolean;        // Enable context compaction
  compactionThreshold?: number;      // Compaction trigger threshold
  maxToolRounds?: number;            // Max tool calling rounds per turn
  workingDirectory?: string;         // Working directory
  enableFunctionCalling?: boolean;   // Enable function calling
  memoryManager?: MemoryManager;     // Memory manager instance
}
```

#### `AgentResponse`

Return value from `processMessage`.

```typescript
interface AgentResponse {
  content: string;                   // Response text
  toolCalls?: ToolCallResult[];      // Tool call results (if any)
  usage?: {                          // Token usage stats
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  provider: ProviderId;              // Model provider used
  model: string;                     // Model used
}
```

#### `ToolCallResult`

Result of a single tool call execution.

```typescript
interface ToolCallResult {
  toolCallId: string;                // Tool call identifier
  name: string;                      // Tool name
  result: {
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  };
  isError: boolean;                  // Whether this was an error
  durationMs: number;                // Execution time in milliseconds
}
```

#### `RuntimeConfig`

`AgentRuntime` constructor configuration.

```typescript
interface RuntimeConfig {
  model: string;
  provider: ProviderId;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  workingDirectory?: string;
  sessionDir?: string;
  memoryManager?: MemoryManager;
  cronService?: CronService;
}
```

#### `ChatResponse`

Return value from `AgentRuntime.chat()`.

```typescript
interface ChatResponse {
  content: string;
  provider: ProviderId;
  model: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}
```

#### `StreamEvent`

Streaming output event type, yielded by `chatStream` async generator.

```typescript
type StreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_start"; name: string; argsPreview: string }
  | { type: "tool_end"; isError: boolean };
```

### Factory Functions

#### `createAgent(config: VexConfig): Promise<Agent>`

Creates a complete Agent instance from `VexConfig`. Internally:
1. Initializes the Memory system from config
2. Calls `createAgentRuntime` to create the runtime
3. Initializes the Cron scheduling service
4. Constructs Agent and loads Skills

#### `createAgentRuntime(config: VexConfig): AgentRuntime`

Creates an `AgentRuntime` instance from `VexConfig`. Extracts `agent` fields from config into a `RuntimeConfig` and initializes the model resolver.

---

## 2. Gateway

Gateway is the Express HTTP/WebSocket server, responsible for channel management, message routing, and web interface hosting.

**Source:** `src/gateway/server.ts`

### Class

#### `Gateway`

```typescript
class Gateway {
  constructor(config: VexConfig)

  // Initialize the Agent instance (must be called before start)
  initAgent(): Promise<void>

  // Initialize channels and WebSocket service
  initialize(): Promise<void>

  // Start HTTP server and listen on configured port
  start(): Promise<void>

  // Shut down the server and all channels
  shutdown(): Promise<void>

  // Get the raw Express app instance
  getApp(): Express
}
```

**Routes:**
- `GET /health` -- Health check, returns `{"status":"ok","timestamp":"..."}`
- WebChat frontend hosted at root path, control panel at `/control`
- WeChat channel (iLink OC API) routes registered automatically via `setupRoutes`

### Factory Functions

#### `createGateway(config: VexConfig): Promise<Gateway>`

Creates a Gateway instance and initializes the Agent. Returns a ready-but-not-started Gateway object.

#### `startGateway(config: VexConfig): Promise<Gateway>`

Convenience entry point: creates Gateway, calls `start()`, and registers `SIGINT`/`SIGTERM` signal handlers for graceful shutdown. This is the most commonly used entry point.

---

## 3. Types

Global shared TypeScript type definitions.

**Source:** `src/types/index.ts`

### `VexConfig`

Main configuration interface, corresponding to the structure of `config.local.json5` / YAML files.

```typescript
interface VexConfig {
  // Model provider configurations. Key is ProviderId, value is SimpleProviderConfig
  providers: Record<string, SimpleProviderConfig | Record<string, unknown>>;

  // Communication channel configurations (currently only WeChat)
  channels: {
    weixin?: WeixinConfig;
  };

  // Agent configuration
  agent: AgentConfig;

  // Server configuration
  server: {
    port: number;
    host?: string;
  };

  // Logging configuration
  logging: {
    level: "debug" | "info" | "warn" | "error";
  };

  // Session storage configuration
  sessions?: SessionStoreConfig;

  // Memory system configuration
  memory?: MemoryConfig;

  // Skills system configuration
  skills?: {
    enabled?: boolean;
    userDir?: string;
    workspaceDir?: string;
    disabled?: string[];
    only?: string[];
  };
}
```

### Sub-Config Interfaces

#### `AgentConfig`

```typescript
interface AgentConfig {
  defaultModel: string;
  defaultProvider: ProviderId;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  workingDirectory?: string;
  enableFunctionCalling?: boolean;
}
```

#### `SimpleProviderConfig`

```typescript
interface SimpleProviderConfig {
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  groupId?: string;       // MiniMax-specific
}
```

#### `WeixinConfig`

```typescript
interface WeixinConfig {
  baseUrl?: string;              // Default: https://ilinkai.weixin.qq.com
  token?: string;                // Bot token obtained after QR login
  accountId?: string;            // iLink Bot ID
  botType?: string;              // Bot type, default "3"
  qrPollInterval?: number;       // QR polling interval in seconds, default 1
  longPollTimeoutMs?: number;    // Long-polling timeout in ms, default 35000
  apiTimeoutMs?: number;         // API request timeout in ms, default 120000
  cdnBaseUrl?: string;           // CDN base URL
  enabled?: boolean;             // Whether this channel is enabled
}
```

#### `MemoryConfig`

```typescript
interface MemoryConfig {
  enabled?: boolean;
  directory?: string;
  embeddingModel?: string;
  embeddingProvider?: ProviderId;
}
```

#### `SessionStoreConfig`

```typescript
interface SessionStoreConfig {
  type: "memory" | "file";
  directory?: string;
  ttlMs?: number;
}
```

### Message-Related Types

#### `ChannelId`

```typescript
type ChannelId = "weixin" | "webchat";
```

#### `ChatType`

```typescript
type ChatType = "direct" | "group";
```

#### `ProviderId`

```typescript
type ProviderId =
  | "deepseek" | "doubao" | "minimax" | "kimi" | "stepfun"
  | "modelscope" | "dashscope" | "zhipu" | "longcat"
  | "openai" | "ollama" | "openrouter" | "together" | "groq"
  | "azure-openai" | "vllm"
  | "custom-openai" | "custom-anthropic";
```

#### `InboundMessageContext`

Unified inbound message context. All channel messages are normalized to this structure.

```typescript
interface InboundMessageContext {
  channelId: ChannelId;      // Source channel
  messageId: string;         // Message ID
  chatId: string;            // Chat ID (channel ID or group ID)
  chatType: ChatType;        // Chat type
  senderId: string;          // Sender ID
  senderName?: string;       // Sender display name
  content: string;           // Message text
  mediaUrls?: string[];      // Attachment links
  replyToId?: string;        // Replied-to message ID
  mentions?: string[];       // @mentioned users
  timestamp: number;         // Unix timestamp in milliseconds
  raw?: unknown;             // Raw message data (channel-specific)
}
```

#### `OutboundMessage`

```typescript
interface OutboundMessage {
  chatId: string;
  content: string;
  replyToId?: string;
  mediaUrls?: string[];
  mentions?: string[];
}
```

#### `SendResult`

```typescript
interface SendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}
```

### Error Classes

```typescript
class VexError extends Error {
  constructor(message: string, public code: string, details?: unknown);
}

class ProviderError extends VexError {
  constructor(message: string, public provider: ProviderId, details?: unknown);
}

class ChannelError extends VexError {
  constructor(message: string, public channel: ChannelId, details?: unknown);
}
```

### `ModelDefinition`

```typescript
interface ModelDefinition {
  id: string;
  name: string;
  provider: ProviderId;
  api: ModelApi;
  contextWindow: number;
  maxTokens: number;
  supportsVision: boolean;
  supportsReasoning: boolean;
  supportsToolCalls?: boolean;      // Default: true
  cost?: {
    input: number;                  // Per million tokens
    output: number;
    cacheRead?: number;
  };
}
```

### `ChatMessage`

```typescript
interface ChatMessage {
  role: MessageRole;
  content: string | MessageContent[] | null;
  tool_calls?: MessageToolCall[];    // Assistant message tool calls
  tool_call_id?: string;             // Tool message call ID
  name?: string;                     // Tool message name
}
```

---

## 4. Plugins

Three-tier plugin system with auto-discovery (bundled / user-global / workspace). Provides extension capabilities for tools, hooks, HTTP routes, and background services.

**Source:** `src/plugins/index.ts`, `src/plugins/service.ts`

### Interfaces

#### `PluginMeta`

Plugin metadata.

```typescript
interface PluginMeta {
  id: string;              // Unique plugin identifier
  name: string;            // Display name
  version: string;         // Semver version
  description?: string;    // Short description
  author?: string;         // Author name
  kind?: string;           // Plugin kind (for exclusive slots)
  dependencies?: string[]; // IDs of dependent plugins
}
```

#### `PluginApi`

The operational interface provided to plugins during `register` and `activate` phases.

```typescript
interface PluginApi {
  id: string;                                                   // Plugin ID
  meta: PluginMeta;                                              // Plugin metadata
  config: VexConfig;                                             // Global configuration
  pluginConfig?: Record<string, unknown>;                        // Plugin-specific config
  registerTool: (tool: Tool) => void;                            // Register a single tool
  registerTools: (tools: Tool[]) => void;                        // Batch register tools
  registerHook: <T extends HookEventType>(
    eventType: T,
    handler: HookHandler
  ) => () => void;                                               // Register a hook (returns unsubscribe fn)
  registerHttpRoute?: (route: HttpRoute) => void;                // Register an HTTP route
  registerService?: (service: PluginService) => void;            // Register a background service
  getLogger: (name?: string) => ReturnType<typeof getChildLogger>;  // Get a logger
  getStateDir: () => string;                                     // Get persistent state directory
}
```

#### `PluginDefinition`

Plugin definition object.

```typescript
interface PluginDefinition {
  meta: PluginMeta;
  configSchema?: PluginConfigSchema;                              // JSON Schema for plugin config
  register?: (api: PluginApi) => void | Promise<void>;            // Register phase
  activate?: (api: PluginApi) => void | Promise<void>;            // Activate phase
  cleanup?: () => void | Promise<void>;                           // Cleanup function
}
```

**Lifecycle:** `register` → `activate` → runtime → `cleanup`

#### `HttpRoute`

```typescript
interface HttpRoute {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  handler: (req: unknown, res: unknown) => void | Promise<void>;
}
```

#### `PluginService`

```typescript
interface PluginService {
  id: string;
  start: () => void | Promise<void>;
  stop: () => void | Promise<void>;
}
```

#### `PluginConfigSchema`

```typescript
interface PluginConfigSchema {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}
```

### Helper Functions

#### `definePlugin(meta, initialize, cleanup?): PluginDefinition`

Creates a standard plugin definition. `initialize` serves as the `register` callback.

```typescript
function definePlugin(
  meta: PluginMeta,
  initialize: (api: PluginApi) => void | Promise<void>,
  cleanup?: () => void | Promise<void>
): PluginDefinition
```

#### `defineToolPlugin(meta, tools): PluginDefinition`

Creates a simple plugin that only provides tools.

```typescript
function defineToolPlugin(
  meta: PluginMeta,
  tools: Tool[]
): PluginDefinition
```

### Management Functions

| Function | Signature | Description |
|----------|-----------|-------------|
| `registerPlugin` | `(definition: PluginDefinition) => Promise<void>` | Register a plugin |
| `unregisterPlugin` | `(pluginId: string) => Promise<void>` | Unload a plugin |
| `getLoadedPlugins` | `() => PluginMeta[]` | Get list of loaded plugins |
| `isPluginLoaded` | `(pluginId: string) => boolean` | Check if plugin is loaded |
| `isPluginActivated` | `(pluginId: string) => boolean` | Check if plugin is activated |
| `unregisterAllPlugins` | `() => Promise<void>` | Unload all plugins |

### `PluginService` Class

Higher-level service for managing plugin lifecycle.

```typescript
class PluginService {
  constructor(config: VexConfig, enableConfig?: PluginEnableConfig)

  initialize(): Promise<{
    loaded: string[];
    activated: string[];
    skipped: Array<{ id: string; reason: string }>;
    failed: Array<{ id: string; error: string }>;
  }>

  shutdown(): Promise<void>
  discover(): Promise<Array<{ id: string; origin: string; manifest?: Record<string, unknown>; loaded: boolean; activated: boolean }>>
  list(): PluginMeta[]
  get(pluginId: string): LoadedPlugin | undefined
  unload(pluginId: string): Promise<boolean>
  isLoaded(pluginId: string): boolean
  isActivated(pluginId: string): boolean
}
```

### `getPluginService(config?, enableConfig?): PluginService`

Returns a singleton `PluginService` instance. Requires `config` on first call.

---

## 5. Tools

Global tool registry used by plugins and built-in tools. Tool names are case-insensitive, supports wildcard policy filtering.

**Source:** `src/tools/registry.ts`, `src/tools/types.ts`, `src/tools/common.ts`

### Registration Functions

#### `registerTool(tool: Tool): void`

Registers a single tool. Tool names are normalized to lowercase for case-insensitive lookup.

#### `registerTools(tools: Tool[]): void`

Batch-registers tools.

#### `getTool(name: string): AgentTool | undefined`

Looks up a tool by name (case-insensitive).

#### `getAllTools(): AgentTool[]`

Returns all registered tools.

### Policy Filtering

#### `filterToolsByPolicy(tools, policy): AgentTool[]`

Filters tools by a policy. `deny` takes precedence over `allow`. When `allow` is set, unmatched tools are excluded.

```typescript
function filterToolsByPolicy(
  tools: AgentTool[],
  policy: ToolPolicy
): AgentTool[]
```

#### `ToolPolicy`

```typescript
interface ToolPolicy {
  allow?: string[];    // Allowed tool names (wildcard `*` supported)
  deny?: string[];     // Denied tool names (wildcard `*` supported)
}
```

**Supported wildcards:**
- `*` -- matches all
- `file*` -- matches tools starting with `file`
- `group:web` -- expands to `["web_search", "web_fetch"]`
- Other predefined groups: `group:memory`, `group:media`, `group:system`

### Result Helper Functions

```typescript
function jsonResult(data: unknown, isError?: boolean): VexToolResult<unknown>
function textResult(text: string, details?: unknown, isError?: boolean): VexToolResult<unknown>
function errorResult(error: string | Error): VexToolResult<unknown>
function imageResult(params: {
  label: string;
  base64: string;
  mimeType: string;
  extraText?: string;
  details?: Record<string, unknown>;
}): AgentToolResult<unknown>
```

### `createBuiltinTools(options?): AgentTool[]`

Creates all built-in tools. Default set includes: `current_time`, `calculator`, `web_search`, `web_fetch`, `image_analyze`, `delay`, filesystem tools (`read`, `write`, `edit`), `bash`, `process`, `apply_patch`, `browser`. Optional tools (require service instances): `memory_search`, `memory_store` (needs `MemoryManager`), `cron_add`, `cron_list`, `cron_remove` (needs `CronService`).

```typescript
interface BuiltinToolsOptions {
  image?: ImageAnalyzeToolOptions;
  filesystem?: FilesystemToolsOptions;
  bash?: BashToolOptions;
  memory?: MemoryToolsOptions;
  enableBrowser?: boolean;
  enableFilesystem?: boolean;
  enableBash?: boolean;
  enableProcess?: boolean;
  enableMemory?: boolean;
  enableCron?: boolean;
  memoryManager?: MemoryManager;
  cronService?: CronService;
}
```

---

## 6. Skills

Skills system based on `SKILL.md` files (YAML frontmatter + Markdown content). Supports three-tier sourcing (bundled / user-level / workspace), injected into the Agent system prompt at initialization time.

**Source:** `src/skills/registry.ts`, `src/skills/types.ts`

### Interfaces

#### `SkillsRegistry`

```typescript
interface SkillsRegistry {
  getAll(): SkillEntry[];                      // All loaded skills
  get(name: string): SkillEntry | undefined;   // Lookup by name
  getEligible(): SkillEntry[];                 // Skills passing eligibility checks
  buildPrompt(): string;                       // Build skill prompt text for injection
  reload(): Promise<void>;                     // Reload all skill files
}
```

#### `SkillsConfig`

```typescript
interface SkillsConfig {
  enabled?: boolean;          // Enable skills system
  userDir?: string;           // User skills directory (default ~/.vex/skills)
  workspaceDir?: string;      // Workspace skills directory (default ./.vex/skills)
  disabled?: string[];        // Disabled skill names
  only?: string[];            // Only enable these skills (all others disabled)
}
```

#### `SkillEntry`

A parsed skill entry.

```typescript
interface SkillEntry {
  frontmatter: SkillFrontmatter;   // YAML frontmatter metadata
  content: string;                 // Markdown skill content
  filePath: string;                // File path
  source: SkillSource;             // Source type
}

type SkillSource = "bundled" | "user" | "workspace";
```

#### `SkillFrontmatter`

YAML frontmatter structure of a `SKILL.md` file.

```typescript
interface SkillFrontmatter {
  name: string;                        // Unique skill identifier
  title?: string;                      // Display name
  description?: string;                // Short description
  version?: string;                    // Version
  author?: string;                     // Author
  enabled?: boolean;                   // Whether enabled
  eligibility?: SkillEligibility;      // Preconditions
  tags?: string[];                     // Keyword tags for matching
  priority?: number;                   // Priority (lower = higher)
}

interface SkillEligibility {
  os?: string[];           // Required OS
  binaries?: string[];     // Required executables
  envVars?: string[];      // Required environment variables
}
```

### Factory Functions

#### `initSkills(config?): Promise<SkillsRegistry>`

Initializes and loads skills. Equivalent to `createSkillsRegistry(config)` + `registry.reload()`.

#### `createSkillsRegistry(config?): SkillsRegistry`

Creates a SkillsRegistry instance without loading. Call `reload()` to actually load skill files.

---

## 7. Memory

Long-term memory system based on local TF-IDF embeddings (no external API dependency). Supports semantic search with hybrid scoring (vector similarity × 0.7 + text matching × 0.3).

**Source:** `src/memory/manager.ts`, `src/memory/types.ts`

### Class

#### `MemoryManager`

```typescript
class MemoryManager {
  constructor(options?: {
    enabled?: boolean;     // Enable/disable (default true)
    directory?: string;    // Storage directory
  })

  // Store a memory, returns entry ID (null when disabled)
  remember(
    content: string,
    metadata?: Partial<MemoryEntry["metadata"]>
  ): Promise<string | null>

  // Semantic search, returns up to `limit` results
  recall(query: string, limit?: number): Promise<MemoryEntry[]>

  // Get a single memory by ID
  get(id: string): Promise<MemoryEntry | undefined>

  // Delete a memory
  forget(id: string): Promise<boolean>

  // List memories, optionally filtered by type/tags
  list(filter?: { type?: string; tags?: string[] }): Promise<MemoryEntry[]>

  // Clear all memories
  clearAll(): Promise<void>

  // Format memory entries for context injection
  formatForContext(entries: MemoryEntry[]): string

  // Close the store
  close(): Promise<void>

  // Enable/disable toggle
  enabled: boolean           // setter
  isEnabled: boolean         // getter
}
```

### Interfaces

#### `MemoryEntry`

```typescript
interface MemoryEntry {
  id: string;
  content: string;
  embedding?: number[];
  metadata: {
    type: "conversation" | "fact" | "note" | "code";
    source?: string;
    timestamp: number;
    tags?: string[];
  };
  score?: number;            // Search relevance score (0-1)
}
```

#### `MemoryStore`

Abstract storage layer interface.

```typescript
interface MemoryStore {
  add(entry: Omit<MemoryEntry, "id">): Promise<string>;
  search(query: string, limit?: number): Promise<MemoryEntry[]>;
  get(id: string): Promise<MemoryEntry | undefined>;
  delete(id: string): Promise<boolean>;
  list(filter?: MemoryListFilter): Promise<MemoryEntry[]>;
  clear(): Promise<void>;
  close?(): Promise<void>;
  status?(): MemoryStoreStatus;
}
```

#### `EmbeddingProvider`

```typescript
interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
  dimension: number;
}
```

### Factory Function

#### `createMemoryManager(options?): MemoryManager`

Creates a `MemoryManager` instance. Internally uses `JsonMemoryStore` + `SimpleEmbedding`.

### Built-In Implementations

- **`JsonMemoryStore`** -- JSON file-based local storage
- **`SimpleEmbedding`** -- 256-dimensional TF-IDF local embedding (`dimension: 256`, vocabulary cap of 50000, LRU eviction)

---

## 8. Cron

Scheduling engine supporting three schedule types: one-shot (`at`), periodic (`every`), and cron expressions (`cron`).

**Source:** `src/cron/service.ts`, `src/cron/types.ts`

### Class

#### `CronService`

```typescript
class CronService {
  constructor(deps?: CronServiceDeps)

  // Start the scheduling loop
  start(): void

  // Stop the scheduling loop
  stop(): void

  // List jobs (optionally include disabled)
  list(options?: { includeDisabled?: boolean }): CronJob[]

  // Get job by ID
  get(id: string): CronJob | undefined

  // Get job by name
  getByName(name: string): CronJob | undefined

  // Create a new job
  add(input: CronJobCreate): CronJob

  // Update an existing job (partial update)
  update(id: string, patch: CronJobUpdate): CronJob | undefined

  // Remove a job
  remove(id: string): boolean

  // Run a job immediately
  run(id: string, options?: { forced?: boolean }): Promise<{
    status: "ok" | "error" | "skipped" | "not_found";
    error?: string;
    summary?: string;
  }>

  // Reload storage and recalculate schedule
  reload(): void
}
```

**`run()` status values:**
- `ok` -- executed successfully
- `error` -- execution failed
- `skipped` -- skipped (e.g. job disabled)
- `not_found` -- job does not exist

### Interfaces

#### `CronJob`

```typescript
interface CronJob {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  schedule: CronSchedule;             // Schedule configuration
  payload: CronPayload;               // Execution payload
  createdAtMs: number;
  updatedAtMs: number;
  deleteAfterRun?: boolean;           // Auto-delete after one-shot run
  state: CronJobState;                // Runtime state
}
```

#### `CronSchedule`

```typescript
type CronSchedule = ScheduleAt | ScheduleEvery | ScheduleCron;

interface ScheduleAt {
  kind: "at";
  atMs: number;                // Execution timestamp in milliseconds
}

interface ScheduleEvery {
  kind: "every";
  everyMs: number;             // Interval in milliseconds
  anchorMs?: number;           // Alignment anchor (millisecond timestamp)
}

interface ScheduleCron {
  kind: "cron";
  expr: string;                // Cron expression (sec min hour day month week)
  tz?: string;                 // Timezone
}
```

#### `PayloadAgentTurn`

Agent conversation payload.

```typescript
interface PayloadAgentTurn {
  kind: "agentTurn";
  message: string;                // User message
  model?: string;                 // Override model
  timeoutSeconds?: number;        // Timeout in seconds
  deliver?: boolean;              // Whether to deliver the result
  channel?: string;               // Delivery channel
  to?: string;                    // Delivery target
}
```

#### `PayloadSystemEvent`

System event payload.

```typescript
interface PayloadSystemEvent {
  kind: "systemEvent";
  message: string;
}
```

#### `CronJobCreate` / `CronJobUpdate`

```typescript
interface CronJobCreate {
  name: string;
  description?: string;
  enabled?: boolean;
  schedule: CronSchedule;
  payload: CronPayload;
  deleteAfterRun?: boolean;
}

interface CronJobUpdate {
  name?: string;
  description?: string;
  enabled?: boolean;
  schedule?: CronSchedule;
  payload?: Partial<CronPayload>;
  deleteAfterRun?: boolean;
}
```

### Factory & Helper Functions

#### `getCronService(deps?): CronService`

Returns the default Cron service singleton. Created on first call with the provided `deps` parameter; subsequent calls ignore the parameter.

```typescript
// Additional helpers exported from cron
function computeNextRunAtMs(job: CronJob, fromMs: number): number | undefined
function computeJobNextRunAtMs(job: CronJob, nowMs: number): number | undefined
function validateCronExpr(expr: string): boolean
function formatSchedule(schedule: CronSchedule): string
```

---

## 9. Outbound

Unified cross-channel message delivery interface. Supports best-effort mode, batch delivery, and abort signals.

**Source:** `src/outbound/index.ts`

### Interfaces

#### `DeliveryTarget`

```typescript
interface DeliveryTarget {
  channel: ChannelId;       // Target channel
  to: string;               // Target chatId
  accountId?: string;       // Account ID (optional)
}
```

#### `DeliveryPayload`

```typescript
interface DeliveryPayload {
  text: string;             // Message text
  replyToId?: string;       // Replied-to message ID
  mediaUrls?: string[];     // Media attachment links
  mentions?: string[];      // @mentioned users
}
```

#### `DeliveryOptions`

```typescript
interface DeliveryOptions {
  bestEffort?: boolean;       // Best-effort delivery (don't throw on failure)
  abortSignal?: AbortSignal;  // Abort signal
}
```

#### `DeliveryResult`

```typescript
interface DeliveryResult {
  success: boolean;           // Whether delivery succeeded
  channel: ChannelId;
  messageId?: string;         // Message ID on success
  error?: string;             // Error message on failure
  errorDetails?: unknown;     // Error details
}
```

### Functions

#### `deliverMessage(target, payload, options?): Promise<DeliveryResult>`

Delivers a single message. Throws on failure by default; set `bestEffort: true` to return `{ success: false, error }` instead.

#### `deliverMessages(target, payloads, options?): Promise<DeliveryResult[]>`

Batch message delivery. In non-best-effort mode, stops at the first failure.

#### `deliverOutboundPayloads(params): Promise<DeliveryResult[]>`

Delivers multiple messages via params object. Parameters include `channel`, `to`, `payloads`, `bestEffort`, `abortSignal`.

#### `sendText(channel, to, text, options?): Promise<DeliveryResult>`

Shortcut for sending plain text. Calls `deliverMessage` internally.

#### `parseDeliveryTarget(target, fallbackChannel?): DeliveryTarget | null`

Parses a delivery target string. Supports two formats:
- `"channel:chatId"` format (e.g. `"weixin:user123"`)
- Plain text with fallback channel

#### `getAvailableChannels(): ChannelId[]`

Returns the list of registered channel IDs.

#### `isChannelAvailable(channelId): boolean`

Checks if a specific channel is registered.

---

## 10. Hooks

Global event hook system supporting 12 event types. Registration returns an unsubscribe function. Batch registration is supported.

**Source:** `src/hooks/index.ts`

### Event Types

`HookEventType` includes the following 12 events:

| Event Type | Trigger |
|-----------|---------|
| `message_received` | Inbound message received |
| `message_sending` | Message about to be sent |
| `message_sent` | Message has been sent |
| `agent_start` | Agent starts processing |
| `agent_end` | Agent finishes processing |
| `tool_start` | Tool execution begins |
| `tool_end` | Tool execution completes |
| `session_start` | Session begins |
| `session_end` | Session ends |
| `compaction_start` | Context compaction begins |
| `compaction_end` | Context compaction completes |
| `error` | An error occurs |

### Event Interfaces (selected)

#### `AgentStartEvent`

```typescript
interface AgentStartEvent {
  type: "agent_start";
  timestamp: number;
  sessionKey?: string;
  provider: ProviderId;
  model: string;
  messages: ChatMessage[];
}
```

#### `AgentEndEvent`

```typescript
interface AgentEndEvent {
  type: "agent_end";
  timestamp: number;
  sessionKey?: string;
  provider: ProviderId;
  model: string;
  response: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  durationMs: number;
}
```

#### `ToolStartEvent` / `ToolEndEvent`

```typescript
interface ToolStartEvent {
  type: "tool_start";
  toolName: string;
  toolCallId: string;
  arguments: unknown;
}

interface ToolEndEvent {
  type: "tool_end";
  toolName: string;
  toolCallId: string;
  result: unknown;
  isError: boolean;
  durationMs: number;
}
```

### Types

#### `HookHandler`

```typescript
type HookHandler<T extends HookEvent = HookEvent> = (
  event: T
) => void | Promise<void>;
```

#### `HookEvent`

Union type comprising all 12 specific event interfaces.

### Functions

#### `registerHook(eventType, handler): () => void`

Registers a hook, returns an unsubscribe function.

```typescript
function registerHook<T extends HookEventType>(
  eventType: T,
  handler: HookHandler
): () => void
```

#### `registerHooks(hooks): () => void`

Batch-registers hooks, returns a single unsubscribe function.

#### `triggerHook(event): Promise<void>`

Asynchronously triggers a hook, iterating and awaiting all handlers.

#### `triggerHookSync(event): void`

Synchronously triggers a hook (fire-and-forget). Internally calls `triggerHook` and logs on error.

#### `clearHooks(): void`

Clears all registered hooks.

#### `getHookCount(eventType?): number`

Returns the number of registered hooks, optionally filtered by event type.

### Convenience Emit Functions

```typescript
emitMessageReceived(context: InboundMessageContext): void
emitMessageSending(params: { channelId: string; chatId: string; content: string; replyToId?: string; sessionKey?: string }): void
emitAgentStart(params: { provider: ProviderId; model: string; messages: ChatMessage[]; sessionKey?: string }): void
emitAgentEnd(params: { provider: ProviderId; model: string; response: string; usage?: {...}; durationMs: number; sessionKey?: string }): void
emitToolStart(params: { toolName: string; toolCallId: string; arguments: unknown; sessionKey?: string }): void
emitToolEnd(params: { toolName: string; toolCallId: string; result: unknown; isError: boolean; durationMs: number; sessionKey?: string }): void
emitError(error: Error, context?: string): void
```

---

## 11. Config

Configuration loader supporting JSON5, JSON, and YAML formats with multi-file merging and environment variable override.

**Source:** `src/config/index.ts`

### Loading Order

1. Working directory config files (CWD `config.yml`, `config.json5`, `config.local.json5`, etc.)
2. User directory config files (`~/.vex/config.yml`, `config.local.json5`, etc.)
3. Environment variables (highest priority)

### Functions

#### `loadConfig(options?): VexConfig`

Loads, merges, and validates configuration.

```typescript
function loadConfig(options?: {
  configPath?: string;     // Specific config file path (skip search)
  configDir?: string;      // User config directory (default ~/.vex)
  cwd?: string;            // Working directory (default process.cwd())
}): VexConfig
```

**Search paths (in priority order):**
1. `{cwd}/config.yml` / `.yaml` / `.json` / `.json5`
2. `{cwd}/config.local.json` / `.json5`
3. `{configDir}/config.yml` etc.
4. `{configDir}/config.local.json` / `.json5`

Each found file is merged via `mergeConfigs`, with environment variables applied last. The final result is validated against a Zod schema (`VexConfigSchema`).

#### `validateRequiredConfig(config, options?): string[]`

Validates required config items, returns a list of errors.

```typescript
function validateRequiredConfig(
  config: VexConfig,
  options?: { webOnly?: boolean }
): string[]
```

**Checks:**
- At least one model provider with an API key is configured
- WeChat channel is configured (skipped in `webOnly` mode)

---

## 12. Providers

Model provider initialization and model resolution layer, built on the `@mariozechner/pi-ai` abstraction.

**Source:** `src/providers/index.ts`, `src/providers/model-resolver.ts`

### Functions

```typescript
// Initialize all configured model providers
initializeProviders(config: VexConfig): void

// Get all provider information
getAllProviders(): Array<{ id: ProviderId; name: string }>

// Get all available models (grouped by provider)
getAllModels(): Array<{
  provider: string;
  model: {
    id: string;
    name: string;
    supportsVision: boolean;
    supportsReasoning: boolean;
    contextWindow: number;
    maxTokens: number;
  };
}>

// Resolve a model ID to a specific provider
resolveModel(providerId: ProviderId, modelId: string): ResolvedModel | undefined

// Get the API key for a specific provider
getApiKeyForProvider(providerId: ProviderId): string | undefined

// Check whether a provider is available (configured and has a key)
isProviderAvailable(providerId: ProviderId): boolean
```

### `ResolvedModel`

```typescript
interface ResolvedModel {
  model: Model<Api>;        // pi-ai Model instance
  providerId: ProviderId;
}
```

---

## 13. Channels

Channel registry and WeChat adapter.

**Source:** `src/channels/common/index.ts`, `src/channels/common/base.ts`, `src/channels/weixin/adapter.ts`

### Interfaces

#### `ChannelAdapter`

Channel adapter contract.

```typescript
interface ChannelAdapter {
  id: ChannelId;
  meta: ChannelMeta;
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
  sendMessage(message: OutboundMessage): Promise<SendResult>;
  sendText(chatId: string, text: string, replyToId?: string): Promise<SendResult>;
  replyToContext(context: InboundMessageContext, text: string): Promise<SendResult>;
  isHealthy(): Promise<boolean>;
}
```

#### `BaseChannelAdapter`

Abstract base class implementing `ChannelAdapter`. Provides `setMessageHandler()` and `handleInboundMessage()`.

```typescript
abstract class BaseChannelAdapter implements ChannelAdapter {
  abstract id: ChannelId;
  abstract meta: ChannelMeta;
  protected logger: Logger;
  protected messageHandler?: MessageHandler;

  setMessageHandler(handler: MessageHandler): void;
  protected handleInboundMessage(context: InboundMessageContext): Promise<void>;

  abstract initialize(): Promise<void>;
  abstract shutdown(): Promise<void>;
  abstract sendMessage(message: OutboundMessage): Promise<SendResult>;
  abstract sendText(chatId: string, text: string, replyToId?: string): Promise<SendResult>;
  async replyToContext(context: InboundMessageContext, text: string): Promise<SendResult>;
  abstract isHealthy(): Promise<boolean>;
}
```

#### `MessageHandler`

```typescript
type MessageHandler = (context: InboundMessageContext) => Promise<void>;
```

### Functions

```typescript
// Register a channel in the global registry
registerChannel(channel: ChannelAdapter): void

// Get a channel by ID
getChannel(id: ChannelId): ChannelAdapter | undefined

// Get all registered channels
getAllChannels(): ChannelAdapter[]

// Check if a channel is registered
hasChannel(id: ChannelId): boolean

// Set global message handler (applied to all registered channels)
setGlobalMessageHandler(handler: MessageHandler): void

// Initialize all channels
initializeAllChannels(): Promise<void>

// Shut down all channels
shutdownAllChannels(): Promise<void>

// Create a personal WeChat channel (iLink OC API)
createWeixinChannel(config: WeixinConfig): WeixinChannel
```

---

## 14. CLI

The `vex` binary entry point (Commander.js). Provides the following subcommands:

| Command | Description | Common Options |
|---------|-------------|----------------|
| `vex onboard` | Interactive configuration wizard (~700 lines of readline prompts) | -- |
| `vex start` | Start the Gateway server | `--config <path>`, `--port <port>`, `--web-only` |
| `vex status` | View service running status | -- |
| `vex logs` | View / tail logs | `-f` (tail follow), `-n <lines>`, `--level <level>`, `--list`, `--date <YYYY-MM-DD>`, `--pretty` |
| `vex chat` | Terminal interactive chat | `-m <model>`, `-p <provider>` |
| `vex models` | List available models | -- |
| `vex check` | Check config validity | `--config <path>` |
| `vex kill` | Stop the running service | -- |
| `vex restart` | Restart the service | `--config <path>`, `--port <port>`, `--web-only` |
| `vex --version` | Print version | -- |

**Startup examples:**
```bash
vex start                          # Start with default config
vex start --port 8080              # Specify port
vex start --web-only               # WebChat only, no communication channels
vex start --config ./my-config.json5  # Specify config file
```

---

## 15. Top-Level Exports

The following is the complete barrel export list from `src/index.ts`, organized by module.

### Agent

```typescript
export { Agent, createAgent } from "./agents/index.js";
```

### Gateway

```typescript
export { Gateway, createGateway, startGateway } from "./gateway/index.js";
```

### Types

```typescript
// All types via export * from "./types/index.js"
// Includes: VexConfig, AgentConfig, SimpleProviderConfig, WeixinConfig,
//   MemoryConfig, SessionStoreConfig, InboundMessageContext, OutboundMessage,
//   SendResult, ChannelId, ChatType, ProviderId, ModelDefinition, ChatMessage,
//   VexError, ProviderError, ChannelError, ChannelMeta, ChannelCapabilities
```

### Tools

```typescript
export {
  type Tool, type ToolCall, type ToolCallResult,
  type ToolResult, type ToolPolicy,
  registerTool, registerTools,
  getTool, getAllTools, filterToolsByPolicy,
  createBuiltinTools,
  jsonResult, errorResult, textResult,
} from "./tools/index.js";
```

### Hooks

```typescript
export {
  type HookEventType, type HookEvent, type HookHandler,
  registerHook, registerHooks,
  triggerHook, triggerHookSync,
  clearHooks, getHookCount,
  emitMessageReceived, emitMessageSending,
  emitAgentStart, emitAgentEnd,
  emitToolStart, emitToolEnd,
  emitError,
} from "./hooks/index.js";
```

### Plugins

```typescript
export {
  type PluginMeta, type PluginApi, type PluginDefinition,
  registerPlugin, unregisterPlugin,
  getLoadedPlugins, isPluginLoaded, unregisterAllPlugins,
  definePlugin, defineToolPlugin,
} from "./plugins/index.js";
```

### Commands

```typescript
export {
  type CommandContext, type CommandHandler, type CommandDefinition,
  registerCommand, registerCommands,
  getCommand, getAllCommands, isCommand,
  parseCommand, executeCommand, registerBuiltinCommands,
} from "./commands/index.js";
```

### Memory

```typescript
export {
  MemoryManager, createMemoryManager,
  JsonMemoryStore, SimpleEmbedding,
  type MemoryEntry, type MemoryStore, type EmbeddingProvider,
} from "./memory/index.js";
```

### Outbound

```typescript
export {
  deliverMessage, deliverMessages, deliverOutboundPayloads,
  sendText, parseDeliveryTarget,
  getAvailableChannels, isChannelAvailable,
  type DeliveryTarget, type DeliveryPayload,
  type DeliveryOptions, type DeliveryResult,
} from "./outbound/index.js";
```

### Cron

```typescript
export {
  CronService, getCronService,
  CronStore, createCronExecutor, createDefaultCronExecuteJob,
  computeNextRunAtMs, computeJobNextRunAtMs,
  validateCronExpr, formatSchedule,
  type CronJob, type CronJobCreate, type CronJobUpdate,
  type CronSchedule, type CronPayload,
  type PayloadSystemEvent, type PayloadAgentTurn,
  type CronEvent, type CronExecutionResult,
  type AgentExecutor,
} from "./cron/index.js";
```

### Config

```typescript
export { loadConfig, validateRequiredConfig } from "./config/index.js";
```

### Providers

```typescript
export {
  initializeProviders, getAllProviders, getAllModels,
  resolveModel, getApiKeyForProvider, isProviderAvailable,
} from "./providers/index.js";
```

### Channels

```typescript
export {
  BaseChannelAdapter, createWeixinChannel,
  registerChannel, getChannel, getAllChannels,
  setGlobalMessageHandler,
} from "./channels/index.js";
```

### Utils

```typescript
export { getLogger, createLogger, setLogger, getChildLogger } from "./utils/logger.js";
export {
  generateId, getEnvVar, requireEnvVar,
  delay, retry, truncate, safeJsonParse, deepMerge,
  computeHmacSha256, aesDecrypt,
} from "./utils/index.js";
```

---

**Repository:** [https://github.com/counhopig/vex-bot](https://github.com/counhopig/vex-bot)
