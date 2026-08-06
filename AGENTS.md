# PROJECT KNOWLEDGE BASE

**Updated:** 2026-08-03
**Branch:** `rewrite/full-architecture`

**Start here:** this file is the sole technical reference for the codebase — `README.md` covers the user-facing pitch and quickstart; everything else (module map, conventions, known gaps) lives below. There is no separate `docs/` tree — the rewrite's process record (module-by-module log, review history) was retired once the rewrite shipped; check git history from commit `dfb0411` onward if you need that level of detail.

## OVERVIEW

Vex (`vex-bot`) — lightweight AI chatbot framework for the Chinese LLM/communication ecosystem. Built on `@mariozechner/pi-coding-agent` (agent runtime) + `@mariozechner/pi-ai` (LLM abstraction). Connects to personal WeChat via the iLink OC API, plus a server-rendered WebChat SPA. TypeScript ESM only. npm package + CLI binary.

**This is a from-scratch architecture rewrite**, not the original codebase. The pre-rewrite implementation is no longer kept in-tree — it lived under `_archive/` (read-only, `git mv`'d with history preserved) during the rewrite for reference, and was removed once the rewrite completed and shipped; it's still fully recoverable from git history starting at commit `dfb0411` if you need to check exact prior behavior or provenance. Never reconstruct it into new code without going through the same TDD/review process the rest of this codebase went through. If you're reading old blog posts, old commit messages, or a stale doc that mentions `src/agents/`, `src/gateway/`, `src/extensions/`, `src/commands/`, or `src/browser/` — those directories don't exist anymore.

**Core design principle, load-bearing across the whole codebase**: no process-global state bleeding across instances. Nearly everything that used to be a module-level singleton or `let` in the pre-rewrite implementation is now a class instantiated per (user, channel) or per-Agent. The one deliberate exception is `hooks/`'s `defaultBus` (EventBus) — hook *subscription* is broadcast semantics, not per-user state, and this is intentional, not an oversight.

## STRUCTURE

```
.
├── src/
│   ├── agent/          # Agent orchestration: Agent, AgentRuntime, AgentRegistry, Pipeline, persona/, SystemPromptAssembler
│   ├── channels/        # ChannelAdapter interface, ChannelRegistry, WeChat + WebChat adapters (channels/wechat/, channels/webchat/)
│   ├── cli/             # Commander CLI: index.ts (commands), server.ts (buildAgentFactory + startWebServer bootstrap), config.ts, models.ts, check.ts, chat.ts, onboard.ts
│   ├── config/          # ConfigStore + resolvers (YamlLoader/SqliteLoader), EffectiveConfig (per-user resolved config, BUILT_IN_DEFAULTS)
│   ├── cron/            # CronService/CronStore/schedule/executor — multi-tenant via CronJob.ownerId
│   ├── dispatcher/      # Dispatcher — the single inbound-message entry point (dispatch/dispatchSynthetic)
│   ├── hooks/           # HookEvent types + class-based EventBus (defaultBus is the one intentional shared singleton)
│   ├── memory/          # MemoryManager/JsonMemoryStore (per-Agent), tokenizer/ (CJK-native)
│   ├── outbound/        # OutboundDeliver — routes replies back through ChannelRegistry
│   ├── plugins/         # PluginService (per-(user,channel)), discovery (3-tier: bundled/global/workspace), loader
│   ├── providers/       # ModelResolver, ProviderMetadata (PROVIDER_IDS derived, not hardcoded), fetch-compat
│   ├── sessions/        # FileSessionStore (per-user), title.ts (session auto-titling)
│   ├── skills/          # SkillLoader/SkillRegistry/SkillInjector — feeds Agent's system prompt "skills" section
│   ├── tools/           # ToolRegistry + tools/builtin/* (13 built-in tools: filesystem, bash, browser, memory, weather, cron, image, web, etc.)
│   ├── utils/           # logger.ts (pino, lazy child-logger proxy — see CONVENTIONS), path.ts (expandHomePath/isPathInside)
│   ├── vendor/          # Vendored deps (e.g. qrcodegen.ts, no third-party call)
│   └── web/             # WebServer bootstrap, routes/ (auth, config, sessions, admin, weixin-login, log-stream), static/ (inline SPA templates)
├── tests/               # Vitest, flat directory, 59 files, `<module>.test.ts` naming
└── .github/workflows/   # CI: npm publish on release
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Message processing pipeline | `src/dispatcher/Dispatcher.ts` → `src/agent/Agent.ts` → `src/agent/AgentRuntime.ts` | `Dispatcher.dispatch(ctx)` → `Agent.processMessage` → `AgentRuntime.chat` (non-streaming; the new `Agent` has no streaming method) |
| Server startup / dependency wiring | `src/cli/server.ts` | `startWebServer()` constructs everything (ModelResolver, ConfigStore, AgentRegistry, Dispatcher, CronService, WebServer...); `buildAgentFactory()` is the per-(user,channel) Agent constructor — **this is the file to check first if a module seems "built but not doing anything"** |
| CLI commands | `src/cli/index.ts` | Commander: start/models/check/chat/onboard/kill/restart/status/logs |
| Add a new channel | `src/channels/` | Implement `ChannelAdapter` (`src/channels/ChannelAdapter.ts`); register via `ChannelRegistry` |
| Add a new tool | `src/tools/builtin/` | Export a `createXTool(...)`, then **wire it into `src/tools/builtin/index.ts`'s `createBuiltinTools()`** — this exact gap (tool built but never called from the assembler) was the single most common defect class found in this codebase |
| Config schema | `src/config/EffectiveConfig.ts` (resolved per-user shape) + `src/web/routes/config.ts` (`SystemConfig`, the raw/system-level shape the control panel edits) | **Two separate config types/pipelines** — don't conflate them. `ConfigStore.resolve(userId, channelId)` produces `EffectiveConfig`; `cli/config.ts`'s `loadConfig()` produces `SystemConfig` |
| Model providers | `src/providers/ModelResolver.ts` | Class-based: `init/resolveModel/getApiKeyForProvider/isProviderAvailable/getAllRegisteredModels`. Case-sensitive model-id matching — a mismatched-case id silently falls through to a fallback resolver that can guess the wrong API protocol (known issue, unfixed) |
| System prompt assembly | `src/agent/SystemPromptAssembler.ts` | 5-section assembler (persona/environment/toolRules/skills/...); `Agent.ts`'s `processMessage` is the only call site — check it directly to see which sections are actually populated |
| Plugin API | `src/plugins/index.ts`, `src/plugins/service.ts` | `definePlugin`/`defineToolPlugin`, `PluginService` (per-(user,channel) instance, constructed in `buildAgentFactory`) |
| Skills injection | `src/skills/SkillInjector.ts` (`buildPrompt`) + `src/agent/Agent.ts` (`skillsPrompt` field) | Bootstrap loads skills once per Agent build and pre-assembles the prompt string — the Agent never imports the skills module directly |
| WebChat UI | `src/web/static/index.ts` (`handleStaticRequest`) + `src/web/static/{client,styles,i18n}.ts` (inline template strings, ported verbatim from archive) | Server-rendered, no frontend build step |
| Web UI auth | `src/web/routes/auth.ts` | `WebAuthStore`: SQLite-backed users, timing-safe login, rate limiting, first-user-becomes-admin |
| Session persistence | `src/sessions/store.ts` (`FileSessionStore`) | Per-user instance, default `~/.vex/sessions/`. **Distinct from** `AgentRuntime`'s own pi-coding-agent session JSONL files (`config.sessionDir`, same default dir but a different persistence layer — they've drifted apart before when one side read `workingDirectory` instead of `config.sessionDir`; if these ever seem to disagree, check both sides read the same field) |
| Memory system | `src/memory/MemoryManager.ts` | Per-Agent instance (constructed in `buildAgentFactory`), vector+keyword hybrid recall, CJK-aware tokenization |
| Cron scheduling | `src/cron/service.ts` (`CronService`) | Process-wide scheduler (constructed once in `startWebServer`), multi-tenant via `CronJob.ownerId`, dispatches through an injected callback (never imports Agent/AgentRegistry directly) |
| Outbound delivery | `src/outbound/OutboundDeliver.ts` | Routes through `ChannelRegistry` (flat + per-user fallback), timeout-protected, never throws |

## CODE MAP

| Symbol | Type | Location | Role |
|--------|------|----------|------|
| `WebServer` | Class | `src/web/server.ts` | Express + WS bootstrap, channel lifecycle |
| `startWebServer` | Function | `src/cli/server.ts` | Top-level composition: constructs every dependency and starts `WebServer` |
| `buildAgentFactory` | Function | `src/cli/server.ts` | Returns the per-(user, channel) Agent constructor passed to `AgentRegistry` |
| `Agent` | Class | `src/agent/Agent.ts` | Owns Pipeline, Persona, AgentRuntime, skillsPrompt, pluginService; `processMessage`/`shutdown` |
| `AgentRuntime` | Class | `src/agent/AgentRuntime.ts` | pi-coding-agent wrapper: per-sessionKey lock-serialized sessions, `chat()`, `getLastAssistantError()` (error surfacing) |
| `AgentRegistry<T>` | Class | `src/agent/AgentRegistry.ts` | Generic (userId,channelId)-keyed cache: concurrent-build sharing, idle-TTL, LRU, dispose paths (shutdown/reset/idle/overflow) |
| `Dispatcher` | Class | `src/dispatcher/Dispatcher.ts` | `dispatch(ctx)` / `dispatchSynthetic(ctx)` — resolves userId → config → agent → deliver |
| `EffectiveConfig` | Interface | `src/config/EffectiveConfig.ts` | Per-(user,channel) resolved config; `BUILT_IN_DEFAULTS` for tier-1 defaults |
| `SystemConfig` | Interface | `src/web/routes/config.ts` | Raw system-level config shape the control panel edits (superset, not per-user) |
| `InboundMessageContext` / `ChannelAdapter` | Interface | `src/channels/ChannelAdapter.ts` | Normalized inbound message; the interface every channel implements |
| `ModelResolver` | Class | `src/providers/ModelResolver.ts` | `init/resolveModel/getApiKeyForProvider/isProviderAvailable/getAllRegisteredModels` |
| `PluginService` | Class | `src/plugins/service.ts` | `registerPlugin/loadFromCandidates/activateAll/unregisterPlugin/shutdown` |
| `MemoryManager` | Class | `src/memory/MemoryManager.ts` | `remember/recall/get/forget/list/clearAll/formatForContext` |
| `FileSessionStore` | Class | `src/sessions/store.ts` | Per-user session/transcript persistence, atomic writes |
| `CronService` | Class | `src/cron/service.ts` | Process-wide scheduler, multi-tenant via `ownerId` |
| `WebAuthStore` | Class | `src/web/routes/auth.ts` | SQLite-backed web user auth |
| `getChildLogger` | Function | `src/utils/logger.ts` | Returns a lazy proxy — see CONVENTIONS below, do not eagerly bind |

## CONVENTIONS

- **Strict TypeScript everywhere**: `strict`, `noUncheckedIndexedAccess`, `noImplicitReturns`, `noFallthroughCasesInSwitch` enabled (verify against `tsconfig.json`, don't trust this doc if it drifts)
- **ESM only**: `"type": "module"`, NodeNext resolution, `.js` extension required in imports (even for `.ts` files)
- **No process-global state** (see OVERVIEW): if you're about to write `let x` or a module-level `Map` that holds per-user data, it almost certainly belongs on a class instance instead. This is the single most-cited principle across the whole rewrite's review history.
- **Logger via pino, lazily bound**: `const logger = getChildLogger("moduleName")` at module top-level is safe and expected (nearly every file does this) — `getChildLogger` returns a proxy that resolves the *current* root logger on every call, not the one active at import time. This exists because `cli/server.ts`'s `setLogger(createLogger({level: config.logging.level, ...}))` runs after all modules have already imported and bound their `const logger`; if `getChildLogger` bound eagerly, the configured log level/format would never take effect (this was a real, shipped bug, fixed by making the proxy lazy).
- **TDD discipline throughout the rewrite**: every module was built red→green, and every review round independently re-ran `tsc`/`vitest` rather than trusting a "tests pass" claim. If you're extending this codebase, match that discipline — the review history is full of defects that automated tests alone didn't catch until someone read the actual diff or ran the real thing.
- **Two separate config pipelines, don't conflate them**: `EffectiveConfig` (per-user, via `ConfigStore.resolve`) vs `SystemConfig` (system-level, via `cli/config.ts`'s `loadConfig` and `web/routes/config.ts`). A field existing in one doesn't mean it's in the other — `weather` and `webAuth` live only in `SystemConfig`, for instance.
- **YAML config format**: `config.local.yaml`, resolved from an explicit `--config` path, then CWD, then `~/.vex/config.local.yaml`.
- **Chinese comments are fine in commit messages and planning notes; code comments are English-only, one-line, WHY not WHAT.**

## CHANGE HYGIENE

- Before finishing any change, check whether this file needs updating — it's the only technical doc in the repo. If a module's wiring status changes (e.g. you connect something that was previously dormant), update the KNOWN GAPS section below — that section exists specifically to stop this exact class of bug (a module built but never actually called from the assembly point) from recurring silently.
- **Verify claims, don't trust them.** This codebase's entire review history is built on the discipline of independently re-running tests, reading actual diffs instead of descriptions, and diffing against the pre-rewrite implementation (git history from `dfb0411` onward) for specific behavioral claims rather than accepting "matches archive" at face value. Several real defects were only caught this way. Apply the same standard to any future change.

## ANTI-PATTERNS

- **NEVER reconstruct or import the pre-rewrite implementation into new code** — it's gone from the tree on purpose; if you need to check its exact behavior, read it from git history (`git show dfb0411:src/...`), never copy it back in directly
- **NEVER add a module-level singleton for per-user/per-channel state** — the one sanctioned exception is `hooks/`'s `defaultBus`, and that's because hook subscription is genuinely broadcast semantics
- **NEVER assume a `tools/builtin/*` factory function is actually wired up** — check `tools/builtin/index.ts`'s `createBuiltinTools()` body directly; declaring an option in `BuiltinToolsOptions` doesn't mean the function uses it (this was true for memory/weather/cron/image tools for a long stretch of this rewrite)
- **NEVER assume a module with passing tests is connected to the running system** — `memory/`, `skills/`, and `plugins/` all had full test suites and passed review while being completely dormant (zero call sites outside their own module) until a dedicated integration pass found and fixed it
- **NEVER use `.ts` extensions in imports** — NodeNext resolution requires `.js`
- **NEVER use `any` or `@ts-ignore`** — strict mode is enforced project-wide

## BUILD & CI

| Stage | Detail |
|-------|--------|
| **Build** | `npm run build` = `clean` (rm dist/) → `tsc` → `scripts/copy-web-assets.mjs` (copies `src/web/static/assets` → `dist/web/static/assets`) |
| **Dev** | `npm run dev` = `tsx watch src/cli/index.ts` |
| **Test** | `npm test` = `vitest` |
| **Lint/type gate** | `npm run lint` = `tsc --noEmit` (no formatter configured) |
| **CI** | `.github/workflows/release.yml` — typecheck → test → build → npm pack smoke → npm publish (provenance); no Docker image is built or published |

## TEST INFRASTRUCTURE

- **Framework**: Vitest, flat `tests/` directory (59 files as of this writing), NOT colocated with source
- **Naming**: `<module>.test.ts`, e.g. `agent-runtime.test.ts`, `cli-server.test.ts`, `webchat-channel.test.ts`
- **Real integration over mocking where feasible**: the strongest tests in this codebase write real fixture files to temp dirs and exercise real code paths (e.g. `plugins-service.test.ts` writes and dynamically imports real CJS plugin modules; `webchat-channel.test.ts` opens real WebSocket connections over a real HTTP server) rather than asserting against mocked call shapes. When a heavy dependency genuinely needs mocking (ConfigStore, AgentRegistry in `web-server.test.ts`), the surrounding real components (WebAuthStore, FileSessionStore, ChannelRegistry) stay real.
- **Fixtures**: temp dirs under `os.tmpdir()`, created in `beforeEach`/cleaned in `afterEach`

## KNOWN GAPS (this list decays fast — verify against the actual code before relying on it)

- `ModelResolver`'s fallback path silently guesses a wrong API protocol for a case-mismatched model id, instead of failing clearly or matching case-insensitively.
- `tool_start`/`tool_end` hooks are declared in `hooks/types.ts` but nothing emits them — a plugin registering these hooks will silently never fire. Needs `PiAgent.setBeforeToolCall`/`setAfterToolCall` wired to pi-coding-agent's own hooks.

## COMMANDS

```bash
npm run build              # tsc → dist/ + copied web assets
npm run dev                 # tsx watch (auto-restart)
npm test                    # vitest
npx tsx src/cli/index.ts start --web-only   # run without building, WebChat-only (still honors channels.weixin if configured — see below)
vex onboard                 # interactive config wizard (after global install / npm link)
vex start --web-only        # NOTE: --web-only only relaxes the "must configure a channel" startup check — it does NOT disable a configured WeChat channel
vex logs -f                 # tail follow logs
```

## NOTES

- The agent engine is `@mariozechner/pi-coding-agent` — read its actual installed source (`node_modules/@mariozechner/pi-coding-agent/dist/`) before assuming its behavior, especially around system-prompt reset semantics (`session.prompt()` silently overwrites the system prompt with a private `_baseSystemPrompt` field whenever custom tools are present — `AgentRuntime.chat()`'s `setBaseSystemPrompt` call exists specifically to counter this).
- WeChat channel uses iLink OC API long-polling, not WebSocket.
- `PROVIDER_IDS` is derived (`PROVIDERS.map(p => p.id)`), not hardcoded in multiple places — this was a real bug in the archive that was fixed during the rewrite.
- Two session-file concepts share the default `~/.vex/sessions/` directory on purpose: `FileSessionStore`'s transcript/index files and `AgentRuntime`'s pi-coding-agent conversation JSONL files. `FileSessionStore.recoverIndexFromTranscripts()` is specifically built to recognize both formats.
- No sub-`AGENTS.md` files exist yet under `src/` (the pre-rewrite hierarchy referenced several; none were recreated). If this file grows unwieldy, splitting per-module knowledge bases following the old pattern is a reasonable next step, not yet done.
