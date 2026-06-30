# Vex Developer Guide

> **Version**: Based on commit `b7bf46a` (2026-06-25)
> **Audience**: Developers who need to understand, extend, or contribute to vex-bot

---

## Table of Contents

1. [Project Structure Deep Dive](#1-project-structure-deep-dive)
2. [Message Processing Flow](#2-message-processing-flow)
3. [Extension Guide](#3-extension-guide)
   - [3a. Add a New Channel](#3a-add-a-new-channel)
   - [3b. Add a New Tool](#3b-add-a-new-tool)
   - [3c. Add a New Plugin](#3c-add-a-new-plugin)
   - [3d. Add a New Skill](#3d-add-a-new-skill)
   - [3e. Add a New Provider](#3e-add-a-new-provider)
4. [Build & Test](#4-build--test)
5. [Coding Conventions](#5-coding-conventions)
6. [Key Dependencies](#6-key-dependencies)
7. [Known Issues](#7-known-issues)

---

## 1. Project Structure Deep Dive

Vex follows a layered architecture: **Gateway (entry) → Agent (orchestration) → AgentRuntime (runtime) → Providers (model layer)**. Channels serve as the I/O adaptation layer, with Tools, Skills, Memory, and Cron as side systems.

### Full Directory Tree

```
vex-bot/
├── src/
│   ├── gateway/            # Express HTTP + WebSocket server, route dispatch
│   │   ├── server.ts       #   Gateway class: Express init, channel startup, WS mount
│   │   └── index.ts        #   Barrel export
│   │
│   ├── agents/             # Agent orchestration core (pi-coding-agent wrapper)
│   │   ├── agent.ts        #   Agent class: message loop, tool calling, session restore, streaming
│   │   ├── runtime.ts      #   AgentRuntime: session management, chat/chatStream, tool registration
│   │   ├── system-prompt.ts#   System prompt assembly: base + environment + tool rules + skills + memory
│   │   └── index.ts        #   Barrel export
│   │
│   ├── channels/           # Platform adapters (Channel interface implementations)
│   │   ├── common/
│   │   │   ├── base.ts     #     Channel interface contract, ChannelAdapter abstract class
│   │   │   └── index.ts    #     Global channel registry (Map<ChannelId, ChannelAdapter>)
│   │   ├── weixin/         #     Personal WeChat adapter (iLink OC API long-polling)
│   │   │   ├── client.ts   #       iLink HTTP client (QR code, polling, message send)
│   │   │   ├── login.ts    #       QR code login flow
│   │   │   ├── adapter.ts  #       WeixinChannel adapter
│   │   │   └── index.ts    #       createWeixinChannel factory
│   │   └── index.ts        #   Barrel export
│   │
│   ├── tools/              # Tool registration, validation, execution engine + 25 built-in tools
│   │   ├── types.ts        #   Tool interface, ToolPolicy, TOOL_GROUPS
│   │   ├── registry.ts     #   registerTool / registerTools / getTool / filterToolsByPolicy
│   │   ├── common.ts       #   Shared helpers: result builders, param readers, path resolution
│   │   ├── builtin/        #   25 built-in tool implementations
│   │   │   ├── filesystem.ts  # read_file, write_file, edit_file, glob, grep, apply_patch
│   │   │   ├── bash.ts        # bash execution, process management
│   │   │   ├── web.ts         # web_search, web_fetch
│   │   │   ├── browser.ts     # Playwright browser automation
│   │   │   ├── image.ts       # image_analyze (vision models)
│   │   │   ├── cron.ts        # cron schedule management (5 tools)
│   │   │   ├── memory.ts      # memory_store, memory_query, memory_list, memory_delete
│   │   │   ├── subagent.ts    # Subagent task delegation
│   │   │   ├── system.ts      # current_time, calculator, delay
│   │   │   ├── process-tool.ts     # Background process management
│   │   │   ├── process-registry.ts # Process registry (PID tracking)
│   │   │   └── index.ts       # Exports all built-in tool arrays
│   │   └── index.ts        #   Barrel export
│   │
│   ├── skills/             # SKILL.md injection system (YAML frontmatter + Markdown)
│   │   ├── types.ts        #   SkillFrontmatter, SkillEntry, SkillsRegistry
│   │   ├── parser.ts       #   parseSkillContent / parseSkillFile: parse SKILL.md
│   │   ├── loader.ts       #   loadAllSkills: 3-tier scan + eligibility + dedup + sort
│   │   ├── registry.ts     #   createSkillsRegistry / initSkills: prompt assembly
│   │   └── index.ts        #   Barrel export
│   │
│   ├── plugins/            # Auto-discovery plugin system (3-tier: bundled/global/workspace)
│   │   ├── index.ts        #   definePlugin, registerPlugin, PluginApi, 15+ type interfaces
│   │   ├── loader.ts       #   loadPlugins → resolveEnableState → import → register
│   │   ├── discovery.ts    #   discoverPlugins: filesystem scan for vex.plugin.json
│   │   └── service.ts      #   PluginService orchestrator (⚠ not wired into Gateway startup)
│   │
│   ├── providers/          # Model resolution layer (pi-ai wrapper)
│   │   ├── model-resolver.ts  # Provider presets (baseUrl, API key env vars)
│   │   └── index.ts        #   Barrel export
│   │
│   ├── memory/             # Long-term memory system (TF-IDF local embedding)
│   │   ├── manager.ts      #   MemoryManager: remember / recall / forget / list
│   │   ├── store.ts        #   JsonMemoryStore: JSON file CRUD + cosine similarity
│   │   ├── embedding.ts    #   SimpleEmbedding: TF-IDF tokenization + 256-dim vectors
│   │   ├── types.ts        #   MemoryEntry, MemoryStore, EmbeddingProvider
│   │   └── index.ts        #   Barrel export
│   │
│   ├── cron/               # Scheduling engine: at / every / cron expressions
│   │   ├── types.ts        #   CronJob, CronSchedule (discriminated union: at/every/cron)
│   │   ├── service.ts      #   CronService: scheduling loop (setTimeout chaining)
│   │   ├── schedule.ts     #   Schedule computation: computeJobNextRunAtMs
│   │   ├── executor.ts     #   Job execution: agentTurn delegates to AgentExecutor, systemEvent outbound
│   │   ├── store.ts        #   JsonCronStore: atomic write + backup
│   │   └── index.ts        #   Barrel export
│   │
│   ├── sessions/           # Session persistence (memory/file, JSONL transcript)
│   │   ├── types.ts        #   Session type definitions
│   │   ├── store.ts        #   MemoryStore and FileStore (JSONL format)
│   │   └── index.ts        #   Barrel export
│   │
│   ├── web/                # Server-rendered WebChat SPA (inline HTML/CSS/JS, no frontend build)
│   │   ├── types.ts        #   WsFrame union, ChatMessage, session info (⚠ incompatible with src/types ChatMessage)
│   │   ├── websocket.ts    #   WsServer: connection management, 16 method handlers, heartbeat, JSON5 config save
│   │   ├── static.ts       #   Two inline SPAs (WebChat UI + Control Panel UI)
│   │   └── index.ts        #   Barrel export
│   │
│   ├── browser/            # Playwright headless browser automation
│   │   ├── types.ts        #   BrowserProfile, BrowserAction (11 action variants)
│   │   ├── service.ts      #   BrowserService: lifecycle orchestration, action dispatch
│   │   ├── session.ts      #   Session state, start/stop, element ref resolution
│   │   ├── screenshot.ts   #   Screenshot capture, sharp compression
│   │   ├── profiles.ts     #   ProfileManager: create/list/delete/set default
│   │   └── index.ts        #   Barrel export
│   │
│   ├── outbound/           # Unified cross-channel message delivery
│   │   └── index.ts        #   deliverOutboundPayloads / deliverMessage
│   │
│   ├── hooks/              # Event hook system (12 event types)
│   │   └── index.ts        #   registerHook, triggerHook
│   │
│   ├── config/             # Config loading (JSON5/YAML/env, Zod validation)
│   │   └── index.ts        #   loadConfig, validateRequiredConfig, Zod schemas
│   │
│   ├── cli/                # Commander.js CLI (onboard, start, logs, status ... 9 subcommands)
│   │   ├── index.ts        #   CLI entry (~700 line onboard wizard)
│   │   └── fetch-patch.ts  #   globalThis.fetch monkey-patch (non-ASCII header support)
│   │
│   ├── commands/           # Chat command framework
│   │   └── index.ts
│   │
│   ├── types/              # Shared TypeScript types
│   │   └── index.ts        #   VexConfig, InboundMessageContext, ChannelId, VexError ...
│   │
│   └── utils/              # Logger, crypto helpers (⚠ 10 of 13 functions unused internally)
│       ├── logger.ts       #   getChildLogger("moduleName") pattern
│       └── index.ts        #   Barrel export (significant dead code)
│
├── skills/                 # Built-in skills (greeting, clawhub, etc.)
├── tests/                  # Vitest tests (15 files, flat structure)
├── docs/                   # Documentation (you are here)
└── .github/                # CI: GitHub Release triggers npm publish
```

### Layered Architecture Diagram

```
┌─────────────────────────────────────────────────────┐
│                     Gateway                          │
│   Express HTTP + WebSocket + Channel init            │
├─────────────────────────────────────────────────────┤
│                     Agent                            │
│   Message loop · Tool calling · Session restore       │
│   Stream response                                   │
├─────────────────────────────────────────────────────┤
│                  AgentRuntime                        │
│   Session management · chat/chatStream · API key      │
│   injection · Model resolution                       │
│   (wraps @mariozechner/pi-coding-agent)              │
├─────────────────────────────────────────────────────┤
│                   Providers                          │
│   Model resolution · Provider presets · AuthStorage   │
│   fallback                                          │
│   (wraps @mariozechner/pi-ai)                        │
└─────────────────────────────────────────────────────┘

     ▲                  ▲          ▲          ▲
     │                  │          │          │
┌────┴────┐    ┌────────┴──┐  ┌───┴───┐  ┌──┴──────┐
│ Channels │    │   Tools   │  │Skills │  │ Memory  │
│ (I/O)    │    │ (25 built-│  │       │  │ Cron    │
│          │    │  in)      │  │       │  │         │
└─────────┘    └───────────┘  └───────┘  └─────────┘
```

### `createAgent()` Initialization Sequence

Inside `src/agents/agent.ts:createAgent()`, the wiring order is:

1. **Dynamic import** of `MemoryManager` via `import("../memory/index.js")` — lazy-loaded, conditionally created if `config.memory` exists and `enabled !== false`
2. **`createAgentRuntime(config)`** — creates AgentRuntime with sessions, API keys, and system prompt assembly
3. **`createDefaultCronExecuteJob()`** — wraps `runtime.chat()` as an `AgentExecutor` callback for cron-triggered conversations
4. **`getCronService()` + `cronService.start()`** — Cron starts here, **before** Gateway initialization
5. **`new Agent(runtime, options)`** — constructor calls `initializeTools()` which creates 25 built-in tools and registers them on the runtime
6. **`initSkills(config.skills)` → `agent.setSkillsRegistry(registry)`** — skills loaded last, injected into system prompt

---

## 2. Message Processing Flow

### 2.1 WeChat Channel: iLink OC API Long-Polling

```
WeChat client → iLink OC API
     │
     ▼ (long-polling, NOT WebSocket)
WeixinChannel (adapter.ts)
     │ handleMessage()
     ▼
Agent.processMessage(ctx)
     │ Non-streaming; delegates to runtime.chat()
     ▼
AgentRuntime.chat(sessionKey, messages)
     │ getOrCreateSession() → AgentSession (pi-coding-agent)
     ▼
pi-coding-agent → LLM Provider → reply
     │
     ▼
WeixinChannel.replyToContext() → iLink API → WeChat client
```

**Key details**:
- WeixinChannel receives messages via iLink OC API HTTP long-polling, not WebSocket
- QR code login flow is implemented in `channels/weixin/login.ts` with token persistence
- Messages are normalized to `InboundMessageContext` in `adapter.ts`, then passed to Agent
- `Agent.processMessage()` is non-streaming — collects the full response before replying

### 2.2 WebChat Channel: WebSocket Streaming

```
Browser WebChat UI
     │ WebSocket ws://host/ws
     ▼
WsServer (websocket.ts) — 16 methods
     │ handleChatSend()
     ▼
Agent.processMessageStream(ctx)
     │ AsyncGenerator, yields per token
     │ Events: text_delta, tool_start, tool_end
     ▼
WsServer emits chat.delta events per token to client
     │ Client accumulates deltas
     │ done:true triggers marked.parse() for Markdown rendering
     ▼
Transcript persisted to session JSONL file
```

**Key details**:
- WebSocket frame format: `{id, type:"req"|"res"|"event", method?, params?, ok?, payload?, error?}`
- 16 WS methods cover: chat, sessions, config, weixin.qr, status, ping
- `Agent.processMessageStream()` is an `AsyncGenerator` that yields `text_delta` / `tool_start` / `tool_end` events
- Stream event loop: subscribes to `AgentSessionEvent`, queues them, polls every 50ms while draining, abortable via `AbortSignal`
- `chat.cancel` method signals `AbortController.abort()` → session stops mid-generation
- Client accumulates text deltas in a buffer; when `done:true` arrives, it calls `marked.parse()` to render the final Markdown

### 2.3 Session Management

**Session Key Derivation** (`runtime.ts:getSessionKey()`):

| Conversation Type | sessionKey Format | Notes |
|-------------------|-------------------|-------|
| Group chat | `channelId:chatId` | Isolated per group |
| Direct message | `channelId:senderId` | Isolated per sender |
| WebChat | `webchat:${clientId}` | Isolated per client |

**Session Lifecycle**:
1. `AgentRuntime.getOrCreateSession(sessionKey)` creates or restores an `AgentSession`
2. Each session gets a `SessionManager` from pi-coding-agent, backed by `~/.vex/sessions/<key>.jsonl`
3. `AuthStorage` is injected with API keys from config, including a fallback resolver for provider aliases
4. `ModelRegistry` is configured via `resolveModel(provider, model)` before `createAgentSession()`
5. Custom tools are registered per-session via `createAgentSession()`'s `customTools` parameter
6. System prompt is assembled by `buildSystemPromptText()` and set via `session.agent.setSystemPrompt()` — **must also set `_baseSystemPrompt`** or `prompt()` will reset it
7. Transcript is persisted to JSONL format at `~/.vex/sessions/<sanitizedKey>.jsonl`

**Important**: `AgentRuntime.getOrCreateSession()` is the **only** entry point for creating an `AgentSession`. It handles AuthStorage, ModelRegistry, and system prompt setup. Never construct an `AgentSession` manually.

---

## 3. Extension Guide

### 3a. Add a New Channel

A channel adapter normalizes external platform messages into `InboundMessageContext` and sends replies back to the platform.

**Steps**:

1. **Create a new subdirectory** under `src/channels/` (e.g., `src/channels/telegram/`)

2. **Implement the Channel interface** (defined in `src/channels/common/base.ts`):
   ```typescript
   interface Channel {
     id: ChannelId;           // Unique channel identifier
     name: string;            // Display name
     start(): Promise<void>;  // Start connection
     stop(): Promise<void>;   // Stop connection
     sendMessage(target: string, content: string): Promise<void>;
     replyToContext(ctx: InboundMessageContext, content: string): Promise<void>;
     setMessageHandler(handler: MessageHandler): void;
   }
   ```

3. **Register the channel** by calling `registerChannel()` (from `src/channels/common/index.ts`) in your factory function

4. **Export a factory function** following the `createXxxChannel(config): Channel` naming convention

5. **Update types**:
   - Extend the `ChannelId` union type in `src/types/index.ts`
   - Add channel config type to `VexConfig.channels`

**Reference implementation**: `src/channels/weixin/` — a complete iLink OC API adapter with QR code login, long-polling, and message normalization.

**Anti-patterns**:
- Never import channel internals outside the channels module — use `getChannel(id)`
- Never hardcode channel IDs in gateway — channels are initialized from config presence
- Never duplicate channel registry logic in outbound or web modules — use `getChannel()` / `getAllChannels()` from `common/index.ts`

---

### 3b. Add a New Tool

Tools are capability units the Agent can invoke, following the `AgentTool` interface from `@mariozechner/pi-agent-core`.

**Tool interface**:
```typescript
interface Tool {
  name: string;              // Tool name (e.g., "web_search")
  label: string;             // Display label
  description: string;       // Description shown to the LLM
  parameters: object;        // JSON Schema parameter definition
  execute(args: any, context: ToolExecutionContext): Promise<{ content: ContentBlock[] }>;
}
```

**Steps**:

1. **Create a tool implementation file** in `src/tools/builtin/` (e.g., `src/tools/builtin/my-tool.ts`)

2. **Implement the execute function**:
   - Use param readers from `src/tools/common.ts`: `readStringParam()`, `readNumberParam()`, `readBooleanParam()`, `readStringArrayParam()`
   - Use result builders: `jsonResult()`, `textResult()`, `errorResult()`, `imageResult()`
   - Validate parameters yourself — do not rely on framework validation

3. **Register in the barrel** at `src/tools/builtin/index.ts`: add the tool to the appropriate tool array export

4. **Registration to Agent**: Tools are auto-registered via `Agent.initializeTools()` which calls `createBuiltinTools()`. Plugin tools use `PluginApi.registerTool()`.

**Tool categories** via `TOOL_GROUPS` (`src/tools/types.ts`):
```typescript
const TOOL_GROUPS: Record<string, string[]> = {
  "group:web": ["web_search", "web_fetch"],
  "group:memory": ["memory_search", "memory_store"],
  "group:media": ["image_analyze"],
  "group:system": ["current_time", "calculator"],
};
```

**Tool policy** — allow/deny filtering supports wildcards and `group:` patterns:
```typescript
interface ToolPolicy {
  allow?: string[];  // e.g., ["*"], ["web_*"], ["group:web"]
  deny?: string[];   // e.g., ["bash"], ["group:system"]
}
```
`filterToolsByPolicy()` in `registry.ts` expands `group:` patterns, then applies deny-first logic with wildcard matching.

**Anti-patterns**:
- Never add npm dependencies for trivial utilities — prefer Node.js built-ins
- Never execute user input directly in bash — validate/escape in `common.ts`
- Never register tools with the same name — registry silently overwrites

---

### 3c. Add a New Plugin

The plugin system provides 3-tier auto-discovery, allowing tools, hooks, and services to be extended without modifying core code.

**Plugin types**:
- `definePlugin(meta, register, cleanup?)` — general-purpose plugin
- `defineToolPlugin(meta, tools)` — pure-tool plugin (shortcut)

**PluginApi capabilities**:

| Method | Description |
|--------|-------------|
| `registerTool(tool)` | Register a single tool |
| `registerTools(tools)` | Batch-register tools |
| `registerHook(event, handler)` | Register an event hook, returns unsubscribe function |
| `registerHttpRoute(method, path, handler)` | Register an HTTP route |
| `registerService(name, service)` | Register a service instance |
| `getLogger()` | Get a plugin-specific pino logger |
| `getStateDir()` | Get the plugin state directory |

**Lifecycle**:
1. **register** (sync) — register tools, hooks, routes
2. **activate** (async, optional) — start background services, establish connections
3. **cleanup** (sync, optional) — clean up resources, close connections

**3-tier priority** (lowest to highest):

| Priority | Source | Default Directory | Notes |
|----------|--------|-------------------|-------|
| 1 (lowest) | bundled | `CWD/plugins/` | Project-bundled plugins |
| 2 | global | `~/.vex/plugins/` | User-level global plugins |
| 3 (highest) | workspace | `CWD/.vex/plugins/` | Workspace-local plugins |

Plugins with the same ID — higher tiers override lower tiers.

**Plugin manifest** — each plugin directory needs one of:
- `vex.plugin.json` (recommended)
- `package.json` with `vex.plugin` field
- `index.ts` or `index.js`

**Enable/disable control**: resolved via `loader.ts:resolveEnableState()` using config's `plugins.enable` (supports `allow`/`deny`/`slots`/`entries` modes).

**Example**:
```typescript
// Define a simple tool plugin
import { defineToolPlugin } from "../plugins/index.js";

export default defineToolPlugin(
  {
    id: "my-tools",
    name: "My Tools",
    version: "1.0.0",
  },
  [
    {
      name: "hello",
      label: "Say Hello",
      description: "Greet the user",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Who to greet" }
        },
        required: ["name"]
      },
      async execute(args, context) {
        return { content: [{ type: "text", text: `Hello, ${args.name}!` }] };
      }
    }
  ]
);
```

**⚠ Known issue**: `PluginService` (`src/plugins/service.ts`) is implemented but **not wired** into Gateway startup. Bundled/global/workspace plugins are not auto-loaded on `vex start`. You must call `PluginService.initialize()` manually.

**Anti-patterns**:
- Never call `registerPlugin()` after `Gateway.initialize()` — tools must be registered before Agent starts
- Never import plugin internals directly — use `PluginApi` methods for tool/hook registration
- Never assume `PluginService` auto-runs

---

### 3d. Add a New Skill

Skills are domain knowledge snippets injected into the system prompt, stored as SKILL.md files.

**SKILL.md format** (YAML frontmatter + Markdown content):

```markdown
---
name: my-skill
title: My Skill
description: What this skill does
version: "1.0"
enabled: true
priority: 10
tags: [tag1, tag2]
eligibility:
  os: [linux, darwin]
  binaries: [git]
  envVars: [MY_API_KEY]
---

Skill instructions as Markdown content here.
```

| Field | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| `name` | string | no* | Falls back to directory name | Unique skill identifier |
| `title` | string | no | `name` | Display title |
| `description` | string | no | — | Skill description |
| `version` | string | no | — | Version number |
| `enabled` | boolean | no | `true` | Whether enabled |
| `priority` | number | no | `100` | Lower = higher priority |
| `tags` | string[] | no | — | Tags |
| `eligibility` | object | no | — | Eligibility check: `os`, `binaries`, `envVars` |

When no frontmatter exists, the directory name becomes the skill name and the entire file content is used as skill content.

**3-tier loading priority** (lowest to highest):

| Priority | Source | Default Directory | Override Rule |
|----------|--------|-------------------|---------------|
| 1 (lowest) | bundled | `<module>/skills/` | — |
| 2 | user | `~/.vex/skills/` | Overrides bundled by `name` |
| 3 (highest) | workspace | `./.vex/skills/` | Overrides user + bundled by `name` |

**Loading pipeline** (`loader.ts:loadAllSkills()`):
1. Scan all `**/SKILL.md` files
2. Filter by `enabled` frontmatter
3. Filter by config `disabled[]` list
4. If `only[]` is set, keep only listed names
5. Eligibility check (os / binaries / envVars)
6. Sort by `priority` ascending
7. Deduplicate (first-seen wins: workspace > user > bundled)

**Prompt injection**: `SkillsRegistry.buildPrompt()` assembles all loaded skills as `## Skill: <title>` Markdown sections, injected into the system prompt.

**Anti-patterns**:
- Never import `yaml` outside this module — parsing is encapsulated in `parser.ts`
- Never modify the `skills[]` array directly — use `reload()` or the registry factory
- Never assume `name` uniqueness without dedup — same-name skills across tiers resolve to highest priority source

---

### 3e. Add a New Provider (Model Provider)

Providers are defined in `src/providers/model-resolver.ts` through preset configurations that map model names to API endpoints and credentials.

**Provider preset structure**:
```typescript
// Pattern in src/providers/model-resolver.ts
const CHINA_PROVIDER_BASE_URLS: Record<string, string> = {
  deepseek: "https://api.deepseek.com/v1",
  kimi: "https://api.moonshot.cn/v1",
  stepfun: "https://api.stepfun.com/v1",
  // ...
};

const PRESET_PROVIDER_CONFIGS: Record<string, { baseUrl: string; headers?: Record<string, string> }> = {
  // openai, ollama, openrouter, together, groq, azure-openai, vllm
};
```

**API Key resolution chain** (`runtime.ts:getOrCreateSession()`):
1. Read API key directly from config
2. Read from environment variable (via `apiKeyEnv` mapping)
3. AuthStorage fallback resolver
4. Injected into pi-coding-agent's `createAgentSession()` call

**ProviderId type** (`src/types/index.ts`):
```typescript
type ProviderId =
  | "deepseek" | "doubao" | "minimax" | "kimi" | "stepfun" | "modelscope" | "dashscope" | "zhipu" | "longcat"
  | "openai" | "ollama" | "openrouter" | "together" | "groq"
  | "azure-openai" | "vllm"
  | "custom-openai" | "custom-anthropic";
```

**⚠ Important**:
- Provider IDs are **hardcoded in 3 places**: `src/cli/index.ts` (onboard), `src/web/static.ts` (control panel UI), `src/web/websocket.ts` (config validation). Adding a new provider requires updates to all 3.
- `model.provider` (set by `resolveModel()`) may differ from `config.provider` — API keys must be set for both in `AuthStorage`.
- The onboard wizard in `cli/index.ts` has ~15 provider IDs hardcoded for the interactive config flow. The `validProviders` list in `web/websocket.ts:validateConfig()` is a separate copy.

---

## 4. Build & Test

### Build Commands

| Command | Description |
|---------|-------------|
| `npm run build` | `tsc` compile → `dist/` (NodeNext module resolution, ES2022 target) |
| `npm run dev` | `tsx watch` development mode, auto-restart |
| `npm test` | `vitest` run tests (15 test files) |
| `npm start` | Production start (from `dist/`) |
| `npm run start:gateway` | Dev mode: bypass CLI, start Gateway directly |

### TypeScript Compilation Config

- **Module resolution**: `NodeNext` (ESM)
- **Target**: `ES2022`
- **Strict mode**: `noUncheckedIndexedAccess`, `noImplicitReturns`, `noFallthroughCasesInSwitch` all enabled
- **Output directory**: `dist/` (mirrors `src/` structure)

### Docker Build

- **Base image**: `node:20-alpine`, multi-stage build
- **Non-root user**: `vex:vex` (UID/GID 1001)
- **ENTRYPOINT**: CLI binary
- **Artifacts**: `dist/`, `skills/`, `package*.json` only
- **Health check**: depends on Express `/health` endpoint (returns `{"status":"ok","timestamp":"..."}`)
- **docker compose**: default and `.env.yml` variants pull the published GHCR image; `docker-compose.dev.yml` builds from the local Dockerfile

### Test Conventions

- **Framework**: Vitest 2.x, `globals: true`, `environment: "node"`
- **Directory**: `tests/` flat structure, not colocated in `src/`
- **Naming**: `<module>.test.ts` (e.g., `config.test.ts`, `hooks.test.ts`)
- **Mock pattern**: `vi.mock()` hoisted at top of file, `.js` extension in paths, no shared mock helpers — every file self-contained
- **Logger mock** (appears in 11/15 files): always the same shape, copy-pasted per file:
  ```typescript
  vi.mock("../src/utils/logger.js", () => ({
    getChildLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  }));
  ```
- **Fixtures**: temp dirs under `os.tmpdir()` created in `beforeEach`, cleaned in `afterEach`. No fixture files
- **Coverage excludes**: `src/cli/**`, `src/web/**`
- **Untested**: CLI, WebChat UI, gateway Express server, WeChat channel adapter, chat commands
- **No** snapshots, `.only`, `.skip`, custom matchers

### CI

| Stage | Detail |
|-------|--------|
| **Build** | `tsc` (NodeNext module, ES2022 target) → `dist/` |
| **CI trigger** | GitHub Release `created` event → verify gates → npm publish → GHCR image publish |
| **CI runner** | ubuntu-latest, Node 20 |
| **Tests in CI** | `npm test -- --run` |
| **Type gate in CI** | `npm run lint` (`tsc --noEmit`) |
| **Package smoke** | `npm run pack:smoke` |
| **Docker smoke** | Docker build, CLI `--version`/`--help`, and `/health` smoke |

### Release Runbook

Release artifacts:

- npm package: `vex-bot`
- CLI command: `vex`
- GHCR image: `ghcr.io/<owner>/vex-bot`
- Image tags: full semver, major/minor, major, git SHA, and `latest`

Repository/package setup:

1. Configure npm Trusted Publishing for the package and this GitHub repository. Keep `NPM_TOKEN` only as a fallback if Trusted Publishing is not available.
2. Ensure GitHub Actions has package write permission for GHCR.
3. Keep the release workflow permissions limited to `contents: read`, `id-token: write` for npm provenance, and `packages: write` for GHCR publishing.

Release checklist:

```bash
npm ci
npm run lint
npm test -- --run
npm run build
npm run pack:smoke
docker build -t vex-bot:release-check .
docker run --rm vex-bot:release-check --version
docker run --rm vex-bot:release-check --help
```

Then update `CHANGELOG.md`, tag the release, and create a GitHub Release from that tag. The release workflow publishes npm and GHCR only after verification passes.

Post-publish checks:

```bash
npm view vex-bot version
npm view vex-bot dist.integrity
docker pull ghcr.io/<owner>/vex-bot:<version>
docker run --rm ghcr.io/<owner>/vex-bot:<version> --version
```

Rollback guidance:

- npm: prefer publishing a fixed patch release. Use `npm deprecate vex-bot@<version> "message"` for a bad release; unpublish only when npm policy allows it and the release is truly unsafe.
- GHCR: delete or retag bad image versions from GitHub Packages, then publish a fixed patch release. Avoid moving immutable semver tags silently once users may have pulled them.
- Docs: update `CHANGELOG.md` with the issue and the replacement version.

---

## 5. Coding Conventions

### TypeScript

| Rule | Detail |
|------|--------|
| Strict mode | `noUncheckedIndexedAccess`, `noImplicitReturns`, `noFallthroughCasesInSwitch` all enabled |
| No `any` | `any` and `@ts-ignore` are forbidden project-wide |
| Import extensions | **Must use `.js` extensions** (NodeNext module resolution requires this), **never `.ts`** |

### Module Organization

| Rule | Detail |
|------|--------|
| Barrel exports | Every module must have `index.ts` re-exporting `*` from submodules |
| Comment style | JSDoc in Chinese, identifiers in English |
| Config validation | All config schemas defined as Zod objects in `src/config/index.ts` |

### Config System

| Rule | Detail |
|------|--------|
| Format | JSON5 (supports comments and trailing commas), YAML as fallback |
| Priority | `config.local.json5` > config files in `~/.vex/` > CWD; env vars take highest priority |
| Git | `config.local.json5` in `.gitignore`, for local overrides only |

### Logging

- Uses `pino` with `getChildLogger("moduleName")` pattern
- Child loggers named after the module
- Never create logger instances inside tool `execute()` functions

### Frontend

- **Never add a frontend build system** — WebChat is server-rendered inline HTML, embedded in `src/web/static.ts`
- `marked.js` loaded via CDN
- `static.ts` is currently 2,303 lines, containing two inline SPAs. Never add a third UI to this file.

### Package Structure

- Same package serves as both CLI binary and library: `"main": "dist/index.js"` (import) + `"bin": {"vex": "./dist/cli/index.js"}` (global command)

---

## 6. Key Dependencies

### Core Dependencies

| Package | Role | Key APIs |
|---------|------|----------|
| `@mariozechner/pi-coding-agent` | **Agent runtime** (core engine) | `createAgentSession`, `AgentSession`, `SessionManager`, `AuthStorage`, `ModelRegistry` |
| `@mariozechner/pi-ai` | LLM abstraction layer | Model invocation, message construction |
| `@mariozechner/pi-agent-core` | Agent core types | `AgentTool` interface (`name`, `label`, `description`, `parameters`, `execute`) |

Before modifying `src/agents/runtime.ts`, understand the pi-coding-agent API first.

### Infrastructure Dependencies

| Package | Role | Used In |
|---------|------|---------|
| `express` | HTTP server | `src/gateway/server.ts` |
| `ws` | WebSocket server | `src/web/websocket.ts` |
| `pino` | Structured logging | Global, `getChildLogger()` pattern |
| `zod` | Config validation | `src/config/index.ts`, `src/web/websocket.ts` |
| `commander` | CLI framework | `src/cli/index.ts` |
| `playwright-core` | Browser automation | `src/browser/` module (requires `npx playwright install chromium`) |
| `node-cache` | Message deduplication | — |
| `yaml` | YAML parsing (skills config) | `src/skills/parser.ts` |
| `marked` | Markdown rendering (frontend CDN) | WebChat UI (not an npm dependency) |

### Node.js Requirements

- **Minimum version**: Node 18
- **Features used**: `homedir()` from `os`, `readFileSync` from `fs`, ESM top-level await

---

## 7. Known Issues

The following issues come from project structure analysis. Developers should be aware of these when modifying code.

| # | Issue | Files Affected | Risk |
|---|-------|---------------|------|
| 1 | **`generateJson5()` duplication** | `src/cli/index.ts` + `src/web/websocket.ts` | Two files contain an identical ~40-line JSON5 serializer. Modifying one without the other will cause inconsistent behavior. Should be extracted to a shared utility module. |
| 2 | **`ChatMessage` name collision** | `src/types/index.ts` vs `src/web/types.ts` | Shared type has `tool_calls` field, web type has `id`/`timestamp` fields. The two `ChatMessage` shapes are incompatible. Mixing them causes type errors. |
| 3 | **Hardcoded provider IDs** | `src/cli/index.ts`, `src/web/static.ts`, `src/web/websocket.ts` | 15 provider IDs hardcoded in 3 places. Adding a new provider requires editing all 3 files. |
| 4 | **No centralized config writer** | `src/cli/index.ts:onboard` + `src/web/websocket.ts:saveConfig` | CLI onboard wizard and WebSocket `saveConfig` both independently write `~/.vex/config.local.json5`. Race condition risk with no file locking. |
| 5 | **`require()` in ESM modules** | `src/plugins/index.ts` (lines 240-241, 300-301), `src/agents/system-prompt.ts` (line 91) | Will fail on strict ESM Node.js. |
| 6 | **Plugin auto-discovery not wired** | `src/plugins/service.ts` → `Gateway` | PluginService is implemented but Gateway never calls it. Bundled/global/workspace plugins are not auto-loaded on `vex start`. |
| 7 | **Unused utility functions** | `src/utils/index.ts` | 10 of 13 exported functions never imported internally (`retry`, `delay`, `truncate`, `safeJsonParse`, `deepMerge`, etc.). Exist only in the public barrel export. |
| 8 | **Broken lint script** | `package.json` | `lint` script is `eslint src --ext .ts` but eslint is not installed. |
| 9 | **Stale `.env.example`** | Root `.env.example` | Lists Feishu/DingTalk/QQ/WeCom channels — these were stripped in the fork from OpenMozi. |
| 10 | **`static.ts` is oversized** | `src/web/static.ts` (2,303 lines) | Two inline SPAs with no separation of concerns. Adding a third UI would worsen this. New UIs should be in separate modules or served as external static files. |
| 11 | **WebSocket client code duplication** | `src/web/static.ts` | `getEmbeddedHtml()` and `getControlHtml()` duplicate WS connect/send/receive logic. Should extract shared client code before adding a third consumer. |
| 12 | **CLI `chat` bypasses Agent** | `src/cli/index.ts:chat` | CLI chat subcommand constructs `@mariozechner/pi-ai` messages directly, completely bypassing the Agent layer. This is the only exception to the normal message processing flow. |

### Other Notes

- **Playwright browser binaries**: Must run `npx playwright install chromium` before using browser features
- **`src/cli/fetch-patch.ts`**: Monkey-patches `globalThis.fetch` at CLI startup for non-ASCII header support (MiniMax/Zhipu)
- **Docker production**: Uses `npm ci --omit=dev` — never rely on devDependencies versions in production
- **Config writes** from CLI onboard and WebSocket saveConfig race on `~/.vex/config.local.json5` — no file locking
- **No `.dockerignore`**: Referenced in `.gitignore` but file is absent
- **No `.nvmrc`** and **no Makefile** in the project

---

> **Further reference**:
> - Per-module conventions in `src/*/AGENTS.md` files (9 sub-module docs)
> - Tool development: `src/tools/AGENTS.md`
> - Channel development: `src/channels/AGENTS.md`
> - Plugin development: `src/plugins/AGENTS.md`
> - Skills system: `src/skills/AGENTS.md`
> - Project overview: root `AGENTS.md`
