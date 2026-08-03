# Review Request — Integration Part 4/4: PluginService wiring — IMPLEMENTATION (code done, awaiting review)

**Branch:** `rewrite/full-architecture`
**Commit:** `4d06f91` `feat(cli): instantiate per-(user,channel) PluginService and wire plugin tools (part 4/4)`
**Status:** ⏸️ Code complete per the confirmed design (see `docs/review-results.md`). TDD done: 743/743 tests green, `tsc --noEmit` clean, `npm run build` passes. Awaiting review.
**Verified baseline:** 736/736 tests passing, `tsc --noEmit` clean (Part 3 `2722480`).

> **审查结果请写入 `docs/review-results.md`（覆盖写入），不要写回本文件。** 我会监控 `docs/review-results.md` 的改动来判断是否通过。

## What was built

Wired the previously-never-instantiated `PluginService` into the running system, per the four confirmed design answers:

1. **`src/plugins/service.ts`** — added ONE new public method `loadFromCandidates(candidates: PluginCandidate[]): Promise<LoadResult>`, a thin bridge over the class-free `loadPlugins(candidates, this.#deps, this.#registry)` (the `#registry` is private, so bootstrap code cannot populate it directly). No other change to the locked plugins module.
2. **`src/cli/server.ts` `buildAgentFactory`** — per-(user, channel) `PluginService`:
   - Fresh per-Agent `ToolRegistry` (plugin tools scoped to this agent — principle #5).
   - Shared `defaultBus` for hook subscriptions (broadcast semantics, not per-user state — as confirmed).
   - `config: effective`, `memoryManager` (the same per-user manager builtin memory tools use).
   - `getStateDir: (pluginId) => join(homedir(), ".vex", "plugins", userId, pluginId)` — per-user state dir.
   - `const candidates = await discoverPlugins()` (system-level 3-tier: bundled → global → workspace, no per-user plugin code dirs); `await pluginService.loadFromCandidates(candidates)`; `await pluginService.activateAll()`.
   - Tool merge into the runtime: `customTools: [...createBuiltinTools({...}), ...pluginToolRegistry.getAll()]` — plugin tools appended to builtin tools, same `Tool[]` type.
3. **`src/agent/Agent.ts`** — `AgentDependencies` gains optional `pluginService?: AgentPluginService` (a minimal structural interface `{ shutdown(): Promise<void> }` so the Agent tears it down without coupling to the plugins module), and `Agent.shutdown()` runs `await this.pluginService?.shutdown()` **before** `runtime.shutdown()`.

## Key design decisions

1. **`loadFromCandidates` on PluginService (not two methods)** — per the review correction: `activateAll()` already exists publicly, so the only new surface is the one loader bridge.
2. **Per-Agent ToolRegistry + shared defaultBus** — the ToolRegistry-isolation argument is the load-bearing one; plugin tools cannot leak across users. EventBus stays the shared `defaultBus` because `emit*` convenience functions fire there (broadcast semantics).
3. **System-level discovery only** — no `plugins` config section exists anywhere (verified: zero matches for `plugins` in `src/config/`), so discovery uses `discoverPlugins()` defaults; per-user isolation comes from the per-Agent ToolRegistry + per-user `getStateDir`. `enableConfig` is `undefined` (all discovered plugins enabled by default) — matching the confirmed "no new config surface" decision.
4. **`Agent.shutdown()` is the teardown choke point** — `AgentRegistry.disposeEntry` calls `entry.shutdown()` for all four reasons (`shutdown`/`reset`/`idle`/`overflow`), so wiring `pluginService?.shutdown()` only there (and not in `WebServer.shutdown()`) covers mid-process eviction too. Order: plugin service first (stops background services, fires cleanup/unsubscribe), then the LLM runtime.
5. **`AgentPluginService` is a structural interface** (not a hard import of the plugins module) — follows the codebase's existing pattern (`ModelResolverLike`, `LlmCompleteLike`, `MemoryManagerLike`); keeps the Agent decoupled and the test trivial.

## Tests (TDD — all written first, verified red, then green)

- **`tests/plugins-service.test.ts` (+3)** — `loadFromCandidates`:
  - loads a real fixture plugin module into the service's own registry, reports `loaded`, exposes the plugin's tool via the injected ToolRegistry;
  - reports a broken module as `failed` without throwing;
  - loaded plugins can then be `activateAll()`'d through the service API.
- **`tests/agent.test.ts` (+1)** — `Agent.shutdown()` tears down an injected plugin service before the runtime (both shutdown fns called once). The existing no-pluginService shutdown test still passes (optional field is a no-op when absent).
- **`tests/cli-server.test.ts` (+3)** — `buildAgentFactory` wiring (AgentRuntime constructor spied to capture `customTools`; `discoverPlugins` mocked for determinism):
  - a fixture plugin discovered on disk registers a tool that lands in the AgentRuntime's `customTools`, and its `getStateDir()` resolves to `~/.vex/plugins/{userId}/{pluginId}`;
  - the state dir is scoped per user (build u1 then u2 → different paths);
  - discovery finding nothing still yields a working agent with the builtin tools (graceful degradation, no plugin section required).

## Current Progress

- 743/743 tests green (736 baseline + 7 new).
- `tsc --noEmit` clean; `npm run build` passes.
- Committed as `4d06f91` (6 files: 2 src, 4 test — plugin wiring only).
- Pre-existing uncommitted worktree changes (sessionDir fix in `AgentRuntime.ts`, README/rewrite-plan doc updates) were **left untouched and unstaged** — they belong to the previous session's finding #4, not this Part.
- Known-deferred (pre-existing, not in this Part's scope): `tool_start`/`tool_end` hook emission is still unwired (rewrite-plan already records it as deferred to plugins work; the confirmed design didn't include it and rule #6 forbids adding scope — flagging so it isn't lost).

## Questions for review

1. `Agent.shutdown()` order — plugin service teardown **before** `runtime.shutdown()`. Rationale: stop plugin background services / fire cleanup / unsubscribe hooks before disposing the LLM session that the plugins' tools ran against. Acceptable, or do you want runtime first?
2. `getStateDir` implemented as `join(homedir(), ".vex", "plugins", userId, pluginId)` per the review's heads-up — confirm the exact path shape is as expected.
3. Is re-running `discoverPlugins()` + full load/activate on **every** agent build acceptable? (`buildAgentFactory` runs once per (user, channel) pair thanks to AgentRegistry caching, so the cost is bounded — matches Part 3's "rescan every time, no caching" choice.)
