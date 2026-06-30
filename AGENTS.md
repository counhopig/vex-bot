# PROJECT KNOWLEDGE BASE

**Generated:** 2026-06-25
**Commit:** b7bf46a
**Branch:** main

## OVERVIEW

Vex (`vex-bot`) — lightweight AI chatbot framework for Chinese ecosystem. Built on `@mariozechner/pi-coding-agent` (agent runtime) + `@mariozechner/pi-ai` (LLM abstraction). Connects to personal WeChat via iLink OC API. ~24k lines / 85 .ts source files. TypeScript ESM only. npm package + CLI binary.

Forked from [OpenMozi](https://github.com/oujingzhou/openmozi) (Apache 2.0), stripped to weixin-only and rebranded as Vex.

## STRUCTURE

```
.
├── src/
│   ├── agents/        # Agent orchestration + session management (pi-coding-agent wrapper)
│   ├── gateway/       # Express HTTP/WS server, route dispatch
│   ├── channels/      # Platform adapters: personal WeChat (iLink OC API)
│   ├── tools/         # Tool registration, validation, execution engine + 25 built-in tools
│   ├── skills/        # SKILL.md injection system (YAML frontmatter + Markdown)
│   ├── plugins/       # Auto-discovery plugin system (3-tier: bundled/global/workspace)
│   ├── memory/        # Long-term memory with TF-IDF embedding
│   ├── cron/          # Scheduling: at/every/cron, agentTurn + systemEvent types
│   ├── outbound/      # Unified cross-channel message delivery
│   ├── web/           # Server-rendered WebChat SPA (inline HTML/CSS/JS, no frontend build)
│   ├── sessions/      # Session persistence (memory/file, JSONL transcript)
│   ├── browser/       # Playwright headless browser automation
│   ├── hooks/         # Event hook system (12 event types)
│   ├── providers/     # Model resolution layer (pi-ai wrapper)
│   ├── config/        # YAML config loading + Zod validation
│   ├── cli/           # Commander.js CLI (onboard, start, logs, status, etc.)
│   ├── commands/      # Chat command framework
│   ├── types/         # Shared TypeScript types
│   └── utils/         # Logger, crypto helpers
├── skills/            # Built-in skills (greeting, clawhub)
├── tests/             # Vitest tests (15 files)
├── docs/              # Documentation
└── .github/           # CI: npm publish on release
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Message processing pipeline | `src/agents/agent.ts` → `src/agents/runtime.ts` | Agent.processMessage → AgentRuntime.chat/chatStream |
| Server startup | `src/gateway/server.ts` | Gateway class: Express + WS + channel init |
| CLI commands | `src/cli/index.ts` | Commander.js, 9 subcommands, onboard wizard |
| Add new channel | `src/channels/` | See `src/channels/AGENTS.md` |
| Add new tool | `src/tools/` | See `src/tools/AGENTS.md` |
| Config schema | `src/config/index.ts` | Zod schemas, loadConfig, validateRequiredConfig |
| Model providers | `src/providers/model-resolver.ts` | Provider presets, model mapping |
| System prompt | `src/agents/system-prompt.ts` | Prompt assembly with skills/memory injection |
| Plugin API | `src/plugins/index.ts` | definePlugin, PluginApi, 3-tier loading |
| Type definitions | `src/types/index.ts` | All shared interfaces: VexConfig, channels, messages |
| WebChat UI | `src/web/static.ts` | Inline HTML/CSS/JS template string |
| Session persistence | `src/sessions/store.ts` | MemoryStore and FileStore (JSONL) |
| Memory system | `src/memory/manager.ts` | MemoryManager: store/query/list, TF-IDF |
| Cron scheduling | `src/cron/service.ts` | CronService: scheduling loop, job execution |
| Outbound delivery | `src/outbound/index.ts` | deliverOutboundPayloads, deliverMessage |

## CODE MAP

| Symbol | Type | Location | Role |
|--------|------|----------|------|
| `Gateway` | Class | `src/gateway/server.ts` | Express server, channel init, WS setup |
| `Agent` | Class | `src/agents/agent.ts` | Message loop, tool calling, session restore |
| `AgentRuntime` | Class | `src/agents/runtime.ts` | Session management, chat/chatStream (pi-coding-agent wrapper) |
| `AgentOptions` | Interface | `src/agents/agent.ts` | Agent config: model, provider, systemPrompt, maxTokens, etc. |
| `VexConfig` | Interface | `src/types/index.ts` | Full config shape: providers, channels, agent, server, logging |
| `InboundMessageContext` | Interface | `src/types/index.ts` | Normalized inbound message from any channel |
| `registerPlugin` | Function | `src/plugins/index.ts` | Plugin registration with lifecycle (register/activate/cleanup) |
| `definePlugin` | Function | `src/plugins/index.ts` | Plugin definition helper |
| `loadConfig` | Function | `src/config/index.ts` | YAML file loading → merge → Zod validation |
| `createAgentRuntime` | Function | `src/agents/runtime.ts` | Factory: VexConfig → AgentRuntime |
| `createAgent` | Function | `src/agents/agent.ts` | Factory: VexConfig → Agent (with tools, skills, memory, cron) |
| `VexError` | Class | `src/types/index.ts` | Base error with code + details |
| `ProviderError` | Class | `src/types/index.ts` | Provider-specific errors |
| `ChannelError` | Class | `src/types/index.ts` | Channel-specific errors |

## CONVENTIONS

- **Strict TypeScript everywhere**: `noUncheckedIndexedAccess`, `noImplicitReturns`, `noFallthroughCasesInSwitch` enabled
- **ESM only**: `"type": "module"`, NodeNext resolution, `.js` extension required in imports
- **Barrel exports**: Every module has `index.ts` re-exporting `*` from submodules
- **Chinese comments with English identifiers**: JSDoc in Chinese, code in English
- **Zod for config validation**: All config schemas defined as Zod objects in `src/config/index.ts`
- **YAML config format**: Application config is YAML-only (`config.local.yaml`)
- **Config hierarchy**: CWD `config.local.yaml`, then `~/.vex/config.local.yaml`; later files override earlier fields
- **Logger via pino**: `getChildLogger("moduleName")` pattern, child loggers named after module
- **Node >= 18**: Uses `homedir()` from `os`, `readFileSync` from `fs`, ESM top-level await
- **No external frontend**: WebChat is server-rendered HTML embedded in `static.ts`, marked.js loaded via CDN
- **No formatter/linter configured**: `lint` script in package.json is broken (eslint not installed)

## ANTI-PATTERNS

- **NEVER import `.ts` extensions** — must use `.js` extensions (NodeNext resolution)
- **NEVER add a frontend build system** — WebChat is intentionally server-rendered inline
- **NEVER use `package-lock.json` versions from devDependencies in production** — Docker uses `npm ci --omit=dev`
- **NEVER use `any` or `@ts-ignore`** — strict mode is enforced project-wide
- **NEVER check in `config.local.yaml`** — gitignored, for local overrides only

## UNIQUE STYLES

- CLI binary + library in same package: `"main": "dist/index.js"` (import) + `"bin": {"vex": "./dist/cli/index.js"}` (global)
- 3-tier resource loading for plugins and skills: built-in → user-level (`~/.vex/`) → workspace (`./.vex/`)
- Docker uses non-root user `vex:vex` (UID/GID 1001)
- Health check: `GET /health` returns `{"status":"ok","timestamp":"..."}`
- CLI `onboard` wizard is ~700 lines of inline readline prompts in `cli/index.ts`
- Only supported channel is personal WeChat via iLink OC API (QR code login + long-polling)
- ChannelId type is `"weixin" | "webchat"`

## BUILD & CI

| Stage | Detail |
|-------|--------|
| **Build** | `tsc` (NodeNext module, ES2022 target) → `dist/` |
| **CI trigger** | GitHub Release `created` event → `npm ci` → `npm run build` → `npm publish` |
| **CI runner** | ubuntu-latest, Node 20 |
| **Tests in CI** | ❌ NOT run — `release.yml` has no test step |
| **Lint in CI** | ❌ NOT run — eslint not installed, `lint` script broken |
| **Docker** | Multi-stage `node:20-alpine`: builder → production. Non-root `vex:vex` (1001:1001). CLI as ENTRYPOINT |
| **docker-compose** | Default published-image compose (`--web-only`, 512M mem limit) + dev compose for local Dockerfile builds |
| **Artifacts** | `dist/`, `skills/`, `package*.json` only. No Docker image push to registry |
| **Missing** | No `.dockerignore` (referenced in `.gitignore` but file absent), no `.nvmrc`, no Makefile |

## TEST INFRASTRUCTURE

- **Framework**: Vitest 2.x, `globals: true`, `environment: "node"`
- **Location**: `tests/` directory (flat, 15 files). NOT colocated with source. Zero `__tests__/` dirs in `src/`
- **Naming**: `<module>.test.ts` (e.g., `config.test.ts`, `hooks.test.ts`)
- **Mock pattern**: `vi.mock()` hoisted at top, `.js` extension in paths, NO shared mock helpers — every file self-contained
- **Logger mock** (appears in 11/15 files): always the same shape, copy-pasted per file
- **Fixtures**: temp dirs under `os.tmpdir()` created in `beforeEach`, cleaned in `afterEach`. No fixture files
- **Coverage excludes**: `src/cli/**`, `src/web/**`
- **Untested**: CLI, WebChat UI, gateway Express server, WeChat channel adapter, chat commands
- **Frontend QA**: Do not run browser/UI/visual frontend tests unless the user explicitly asks for them. Use TypeScript, unit tests, build, and backend/CLI smoke checks for default verification.
- **No** snapshots, `.only`, `.skip`, custom matchers

## CROSS-CUTTING CONCERNS

| Issue | Files Affected | Risk |
|-------|---------------|------|
| **`ChatMessage` name collision** | `src/types/index.ts` vs `src/web/types.ts` | Incompatible shapes — shared has `tool_calls`, web has `id`/`timestamp` |
| **Hardcoded provider IDs** | `src/cli/index.ts`, `src/web/static.ts`, `src/web/websocket.ts` | 15 provider IDs hardcoded in 3 places — adding a provider requires 3-file edit |
| **No centralized config writer** | `src/cli/index.ts:onboard` + `src/web/websocket.ts:saveConfig` | Both write `~/.vex/config.local.yaml` independently — race condition risk |
| **`require()` in ESM module** | `src/plugins/index.ts` (lines 240-241, 300-301), `src/agents/system-prompt.ts` (line 91) | Will fail on strict ESM Node.js |
| **Plugin auto-discovery not wired** | `src/plugins/service.ts` exists but never called from `Gateway` | Bundled/global/workspace plugins not auto-loaded on `vex start` |
| **Unused utils** | `src/utils/index.ts` — 10/13 functions never imported internally | Dead code: `retry`, `delay`, `truncate`, `safeJsonParse`, `deepMerge`, etc. exist only in public barrel |

## COMMANDS

```bash
npm run build          # tsc → dist/
npm run dev            # tsx watch (auto-restart)
npm test               # vitest
npm start              # Production start (from dist)
npm run start:gateway  # Dev: bypass CLI, start gateway directly
vex onboard           # Interactive config wizard
vex start --web-only  # WebChat only, no channel platforms
vex logs -f           # Tail follow logs
```

## AGENTS.md HIERARCHY

```
./AGENTS.md                       (root — you are here)
├── src/channels/AGENTS.md        Channel adapter layer
├── src/tools/AGENTS.md           Tool system + 25 built-in tools
├── src/agents/AGENTS.md          Agent orchestration core
├── src/web/AGENTS.md             WebSocket protocol + WebChat SPAs
├── src/plugins/AGENTS.md         3-tier plugin discovery system
├── src/cron/AGENTS.md            Scheduling engine
├── src/memory/AGENTS.md          Long-term memory system
├── src/skills/AGENTS.md          SKILL.md injection system
└── src/browser/AGENTS.md         Playwright browser automation
```

## NOTES

- The agent engine is `@mariozechner/pi-coding-agent` — understand its API before modifying `src/agents/runtime.ts`
- pi-coding-agent provides: `createAgentSession`, `AgentSession`, `SessionManager`, `AuthStorage`, `ModelRegistry`
- WeChat channel uses iLink OC API long-polling, not WebSocket
- Docker Compose health check depends on Express `/health` endpoint
- Playwright (`playwright-core`) requires browser binaries: `npx playwright install chromium`
- The `lint` script (`eslint src --ext .ts`) is currently broken — eslint is not installed
- `src/cli/fetch-patch.ts` monkey-patches `globalThis.fetch` at CLI startup for non-ASCII headers (MiniMax/Zhipu)
- `src/cli/index.ts:chat` bypasses Agent entirely — constructs `@mariozechner/pi-ai` messages directly
- Config writes from CLI onboard and WebSocket saveConfig race on `~/.vex/config.local.yaml`
- `src/web/static.ts` is 2303 lines — two inline SPAs with no separation of concerns
