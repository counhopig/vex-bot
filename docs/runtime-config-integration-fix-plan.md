# Runtime Configuration Integration Fix Plan

**Date:** 2026-08-03  
**Status:** Implemented — all seven parts landed on `rewrite/full-architecture` (parts 4/6 per the approved design decisions). Regression matrix: `tests/config-runtime-matrix.test.ts`; module ports: `src/tools/builtin/sharelink/`, `src/skills/learner/`.
**Trigger:** Authenticated control-panel settings are persisted and displayed, but are not consistently consumed by the running Agent.

## 1. Verified root cause

The intended resolution chain is:

```text
BUILT_IN_DEFAULTS -> config.local.yaml -> web_user_settings -> EffectiveConfig -> Agent assembly
```

The running chain stops before `web_user_settings`:

```text
Dispatcher.dispatch()
  -> ConfigStore.resolve(userId, channelId)
  -> no SQLite overrides passed
  -> AgentRegistry builds from YAML-only EffectiveConfig
```

`SqliteLoader` exists and has unit tests, but has no production call site. The control panel independently overlays `WebAuthStore.getUserConfigSettings()` for display, which makes saved settings look effective even though runtime resolution never reads them.

This was reproduced with the `counhopig` account: SQLite contains `persona.enabled = true` and `persona.persona_name = PandaBot`, while the live Agent answered as `MiniMax-M3`.

## 2. Audit findings

| Area | Saved/displayed | Runtime status | Classification |
|---|---:|---|---|
| Agent provider/model/temperature/maxTokens | Yes, per user | YAML only because SQLite tier is disconnected | Broken integration |
| Persona content | Yes, per user | YAML only because SQLite tier is disconnected | Broken integration |
| Persona `enabled: false` | Yes | A present persona object is instantiated even when explicitly disabled | Broken gate |
| Memory enabled/directory | Yes, per user | Consumer exists, but SQLite tier is disconnected | Broken integration |
| Agent `systemPrompt` | Yes | Passed into `AgentRuntimeConfig`, but never added to the prompt sent by `Agent.processMessage()` | Dead field |
| Agent `bashEnvPassthrough` | YAML schema only | Never passed to `createBashTools()` | Dead field |
| Memory embedding model/provider | Yes | `MemoryManager` always uses `SimpleEmbedding`; configured fields are ignored | Unsupported UI/config surface |
| Weather | Yes, per user | Agent factory captures system YAML once; per-user value is unavailable. UI uses snake_case while `WeatherToolOptions` expects camelCase | Broken integration + shape mismatch |
| Sessions type/directory/TTL | Yes, per user | Runtime and `FileSessionStore` use fixed defaults; settings are ignored | Unsupported UI/config surface |
| ShareLink | Yes, per user | No new-code implementation; `BuiltinToolsOptions.sharelink` is unused | Missing module/wiring |
| Skill Learner | Yes, per user | No new-code implementation or consumer | Missing module/wiring |
| Skills | Yes, system/admin | Loaded into each Agent and prompt | Connected |
| Providers/channels/server/logging | System/admin | Consumed through their system-level paths | Connected; intentionally not per-user |
| WebAuth and per-user WeChat credentials | Separate system/credential paths | Consumed | Connected |

## 3. Design decisions

1. `ConfigStore.resolve(userId, channelId)` remains the single source of truth. Callers must not manually merge user settings.
2. Inject a user-config loader into `ConfigStore`; do not make `Dispatcher` know about SQLite or `WebAuthStore`.
3. Keep the existing optional explicit override parameter only as a narrow test/migration escape hatch, or remove it after converting tests. Production resolution must load tier 3 automatically.
4. Normalize config shapes at the `EffectiveConfig` boundary. Runtime tools should receive typed runtime options, not raw UI/YAML records.
5. Do not claim a setting is supported merely because it can be saved. Each exposed setting needs a consumer test from saved config to observable runtime behavior.
6. Per-user directories must be scoped under a user-owned root and validated with `isPathInside`; a user override must never cause cross-user storage access.

## 4. Implementation plan

### Part 1 — Connect SQLite overrides to runtime resolution

**Goal:** Make the documented three-tier config chain real for every dispatch path.

- Introduce a small `UserConfigLoader` interface (`load(userId)`) in `config/`.
- Make `SqliteLoader` implement it.
- Extend `ConfigStore` construction with an optional loader and have `resolve()` load tier 3 by `userId`.
- Instantiate `SqliteLoader` from the same resolved auth database path in `startWebServer()`.
- Preserve synthetic/cron behavior: synthetic owners without a settings row resolve to `{}`.
- Keep corrupt/missing database behavior fail-safe and observable with a warning where appropriate.
- Ensure `WebServer.resetUserRuntime()` still disposes both WebChat and WeChat Agent entries after a save, so the next message rebuilds with the new effective config.

**Tests:**

- `ConfigStore.resolve()` automatically loads user overrides.
- Different users resolve different Agent/Persona/Memory values without state bleed.
- Missing and corrupt rows fall back to YAML.
- Dispatcher integration test proves the factory receives the SQLite-overlaid config without the Dispatcher performing the merge.
- CLI server composition test proves the configured auth DB path is also used by `SqliteLoader`.

### Part 2 — Fix core fields that already have runtime consumers

**Goal:** Make Agent, Persona, and Memory settings behave exactly as the control panel claims.

- Change Persona construction to honor `persona.enabled === false`; remove the unsafe non-null assertion around `createPersonaConfig()`.
- Add the configured `agent.systemPrompt` to `SystemPromptAssembler` as a clearly ordered section. Persona must remain the sole identity section; document whether custom instructions follow identity or precede tool rules.
- Pass `agent.bashEnvPassthrough` into `createBuiltinTools({ bash: { envPassthrough } })`.
- Verify provider/model changes invalidate the cached Agent through the existing reset path and build a new `AgentRuntime`.
- Verify memory enabled/directory overrides build a user-scoped `MemoryManager` and cannot escape the allowed root.

**Tests:**

- Saved `PandaBot` appears in the actual prompt received by the Pi session factory.
- `enabled: false` produces the bare default identity and no Persona state.
- Custom system prompt is present exactly once and survives pi-coding-agent's base-prompt reset.
- Bash receives only the configured environment names.
- A config save followed by the next message uses the new model/persona rather than the cached Agent.

### Part 3 — Normalize and connect Weather

**Goal:** Support the already-exposed per-user Weather settings.

- Add a typed weather section to `EffectiveConfig` using one canonical naming convention.
- Convert raw YAML/SQLite snake_case fields to `WeatherToolOptions` in one adapter function.
- Stop capturing `config.weather` once in `BuildAgentSystemDeps`; create the weather tool from the resolved per-user config during Agent construction.
- Preserve Caiyun API-key redaction and merge semantics.
- Decide and test whether a blank per-user key inherits the system key (recommended) rather than deleting it.

**Tests:**

- Provider, default location, timeout, cache TTL, base URL, API version, and API key reach `createWeatherTool()`.
- Two users can have different default locations/providers.
- No API key is returned by `config.get`.

### Part 4 — Make Sessions settings honest and safe

**Goal:** Either fully support the control-panel session settings or stop presenting them as active.

- Define the ownership of both persistence layers: `FileSessionStore` transcript/index files and pi-coding-agent JSONL files.
- Make session directory resolution per user, with a deterministic scoped directory and path-containment validation.
- Define `type: memory | file` behavior. If memory mode is not being implemented now, remove/disable it in the UI and schema instead of silently accepting it.
- Define and implement `ttlMs` pruning semantics, including whether it applies to indexes, transcripts, Pi JSONL files, or all three.
- Rework server wiring only after the ownership contract is fixed; the current single process-wide `FileSessionStore` cannot directly honor arbitrary per-user directories.

**Tests:**

- User A cannot list/restore/delete User B's sessions even with crafted keys or directories.
- Custom directory affects both documented persistence layers consistently.
- TTL behavior uses fake time and cleans only eligible files.
- Restart recovery works for the selected store type.

### Part 5 — Resolve unsupported Memory embedding settings

**Goal:** Eliminate misleading configuration.

Choose one explicitly:

- **Recommended short-term:** remove/hide `embeddingModel` and `embeddingProvider` from the control panel and mark the local `SimpleEmbedding` implementation as fixed.
- **Long-term alternative:** introduce an `EmbeddingProvider` factory, validate provider credentials, instantiate it per Agent, and preserve graceful fallback to `SimpleEmbedding`.

Do not leave these fields saveable but inert.

### Part 6 — Treat ShareLink and Skill Learner as separate feature restorations

**Goal:** Avoid masking missing modules as a config-resolution fix.

- Remove the unused `BuiltinToolsOptions.sharelink` declaration until a real consumer lands, or implement the planned `tools/builtin/sharelink/` module and Pipeline interceptor from `docs/rewrite-plan.md`.
- Port Skill Learner as a per-Agent/per-user service with no module-global user state, or hide its settings until implemented.
- Each restoration requires its own design review, TDD series, lifecycle/disposal tests, and assembly test.
- Until then, label these settings “not available in this build” or remove them from the control panel.

### Part 7 — Regression matrix and real-environment QA

- Add a table-driven integration test covering every control-panel field and its consumer or explicit “unsupported” classification.
- Run `npm run lint`, the complete Vitest suite, and `npm run build` independently.
- On `home-server`, save a distinctive Persona and model override, send messages through both WebChat and WeChat, and verify logs show the resolved values.
- Restart the process and verify settings, sessions, Persona, and WeChat state persist.
- Confirm secrets remain redacted in WebSocket responses and logs.
- Update `docs/rewrite-summary.md` section 8, `docs/architecture.md`, and the user manual with the final supported-setting matrix.

## 5. Proposed commit sequence

1. `test(config): reproduce missing runtime user overrides`
2. `fix(config): load sqlite overrides during effective config resolution`
3. `fix(agent): honor persona gates and custom runtime instructions`
4. `fix(tools): wire bash environment and normalized weather config`
5. `fix(sessions): apply safe per-user persistence settings` (after design approval)
6. `fix(web): hide unsupported embedding and extension settings`
7. Separate feature commits for ShareLink and Skill Learner, if restoration is approved
8. `docs: document runtime configuration support matrix`

Every implementation commit should be independently reviewable and green before proceeding. Parts 4 and 6 must not be folded into Part 1 because they require separate architecture decisions rather than simple missing wiring.

## 6. Acceptance criteria

- A value shown as saved in the authenticated control panel either changes observable runtime behavior on the next Agent build or is explicitly marked unsupported.
- `ConfigStore.resolve(userId, channelId)` returns the same effective values shown to that user, excluding deliberately system-only/redacted fields.
- Persona `PandaBot` is visible in the actual Pi system prompt and the model no longer substitutes its provider identity when asked who it is.
- No user setting can alter another user's Agent, memory, tools, weather, or sessions.
- There are no production-only config loaders, factories, options, or schema fields with zero runtime consumers unless documented as compatibility-only.
