# Plan: Port AstrBot plugins (Persona, ShareLink, Skill Learner) into vex-bot

## Context

`/home/counhopig/workspace/astrbot/AstrBot-plugin` contains four Python AstrBot
plugins. We want to bring three of them — **Private Persona**, **ShareLink
Parser**, and **Skill Learner** — into **vex-bot** (TypeScript, ESM, built on
`pi-coding-agent`) with **full feature parity**. Weather is out of scope.

The reason this is non-trivial: the AstrBot plugins hook into framework events
that vex-bot does **not currently expose**. Specifically the Persona plugin
relies on AstrBot's `@filter.on_llm_request` to inject **dynamic, per-user,
per-message** content into the system prompt, `@filter.on_llm_response` to
observe the bot's reply, `@filter.command` for ~30 slash commands,
`context.llm_generate` for out-of-band LLM calls (reflection / profile / nudge),
`context.send_message` for proactive push, and `cron_manager` for background
jobs.

Investigation of vex-bot found:

- **`src/agents/runtime.ts:185-188`** sets a **static** system prompt at session
  creation (`_baseSystemPrompt`), with no per-message injection seam.
- **`src/gateway/server.ts:86-107`** `handleMessage` calls `agent.processMessage`
  directly — it emits **no hooks** and has **no command interception**.
- The hook `emit*` functions (`src/hooks/index.ts`) are **never called**
  anywhere, and **`PluginService` (`src/plugins/service.ts`) is never
  initialized** — the entire plugin/hook stack is dormant.
- Useful primitives that DO exist and we will reuse:
  `pi-ai`'s `complete()` / `completeSimple()` (one-shot LLM), outbound
  `sendText()` (`src/outbound/index.ts`), `CronService` (`src/cron/service.ts`),
  the tool registry + `AgentTool` pattern, and the skills loader which reads
  `~/.vex/skills/**/SKILL.md` (`src/skills/loader.ts:118-128`).

**Intended outcome:** the three behaviors work end-to-end over both inbound
paths (WeChat channel and WebChat) with the same commands, config, and engine
logic as the originals.

## Packaging decision (per feature)

The three features are implemented as **built-in TypeScript modules under
`src/extensions/`**, wired through a small new pipeline-extension layer — rather
than resurrecting the unproven on-disk plugin-discovery loader. Rationale: all
three need the *same* new core seams; built-in modules keep parity logic in TS,
testable under the existing Vitest setup, and avoid a compiled-`dist/plugins`
round trip. ShareLink additionally exposes its core as a normal **built-in
tool** so the agent can call it autonomously.

| Feature | Form in vex-bot |
|---|---|
| ShareLink | Built-in **tool** (`sharelink_parse`) + adapters + optional auto-detect interceptor |
| Skill Learner | Built-in **module**: command interceptor + message capture + `skills` deploy |
| Private Persona | Built-in **module**: prompt injector + response observer + commands + cron + outbound |

## Phase 0 — Pipeline extension seams (foundation, required by all three)

New directory `src/pipeline/` exposing a process-wide registry (mirrors the
existing `src/hooks` style — module-level `Map`s + register/emit functions):

1. **Prompt injectors** — `registerPromptInjector(fn: (ctx) => Promise<string|"">)`.
   In `runtime.ts`, just before `session.prompt(content)` in **both** `chat()`
   and `chatStream()`, gather injector output for the current
   `InboundMessageContext`, then set the session prompt to
   `base + "\n\n" + injected` for that turn via the existing override
   (`session.agent.setSystemPrompt(...)` + reassign `_baseSystemPrompt`; restore
   base afterwards). This is the seam that replaces `on_llm_request`.
   - Requires threading the full `InboundMessageContext` into `chat()` (already
     passed) and down to the prompt call.
2. **Message interceptors** — `runMessageInterceptors(ctx): Promise<string|null>`.
   Gateway `handleMessage` (and `web/websocket.ts`'s chat handler) call this
   **before** `agent.processMessage`; a non-null return short-circuits and is
   sent as the reply. Handles all slash commands + ShareLink auto-detect +
   Skill Learner capture.
3. **Response observers** — `runResponseObservers(ctx, replyText)` called after a
   reply is produced (both paths). Replaces `on_llm_response`.
4. **LLM-complete helper** — `src/providers/llm.ts`:
   `llmComplete({ system?, prompt, providerId?, model? }): Promise<string>` built
   on `resolveModel()` + `getApiKeyForProvider()` + pi-ai `complete()`. Replaces
   `context.llm_generate`.
5. **Wire startup** — call the extension registration from
   `createAgent`/`Gateway.initialize` so the three modules register their
   injectors/interceptors/observers/cron.

Critical files: `src/agents/runtime.ts`, `src/agents/agent.ts`,
`src/gateway/server.ts`, `src/web/websocket.ts`, new `src/pipeline/index.ts`,
new `src/providers/llm.ts`, new `src/extensions/index.ts` (registers all three).

A shared per-user JSON store helper (`src/extensions/common/json-store.ts`)
mirrors the Python `PersonaStorage`/`SkillStorage` pattern (one file per key,
LRU cache, atomic write) under `~/.vex/extensions/<feature>/`.

## Phase 1 — ShareLink (`src/extensions/sharelink/` + tool)

Port `astrbot_plugin_sharelink_counhopig` faithfully.

- **Adapters** (`platforms/base.ts`, `bilibili.ts`, `youtube.ts`, `registry.ts`)
  mirroring the Python `BasePlatformAdapter` / `VideoMetadata` / `PlatformRegistry`.
  Bilibili: b23.tv resolve, BV/AV extract, metadata, subtitles (with
  SESSDATA/bili_jct cookie), audio-download + STT fallback. YouTube: id extract,
  metadata, transcript.
  - JS deps: replace `bilibili-api-python` with direct Bilibili web API calls via
    `axios` (already a dep); replace `yt-dlp` shell-out for audio fallback
    (spawn `yt-dlp` if present — gate via a binary check). YouTube transcript via
    the timedtext endpoint.
- **Tool** `sharelink_parse` (alias of `bilibili_parse_link`) registered in
  `src/tools/builtin/` and added to `createBuiltinTools` — same detailed/simple
  output, description/cover toggles, subtitle→STT fallback, and LLM map-reduce
  summarization (via `llmComplete`).
- **Auto-detect interceptor**: when `auto_detect` config is on and a message
  contains a supported link/BV, parse and reply (short-circuit).
- Config block `sharelink` in `VexConfig` (Zod schema in `src/config/index.ts`)
  with parity keys: `responseMode`, `includeDescription`, `includeCover`,
  `descriptionMaxLength`, `bilibiliCookie.{sessdata,biliJct}`,
  `summarizeProviderId`, `sttProviderId`, `audioDownloadTimeout`,
  `subtitleMaxLength`, `llmShortContentThreshold`, `llmChunkSize`, `autoDetect`.

## Phase 2 — Skill Learner (`src/extensions/skilllearner/`)

Port `astrbot_plugin_skill_learner_counhopig`.

- **Models/storage**: `LearningSession`, `LearnedSkill`, `LearningConfig`;
  sessions under `~/.vex/extensions/skilllearner/sessions/`, skills backed up
  there and **deployed to `~/.vex/skills/<name>/SKILL.md`** (the dir the vex
  skills loader already scans, `loader.ts:127`).
- **Engine** (`learner.ts`): `checkAutoTrigger`, `buildAnalysisPrompt`,
  `parseAnalysisResult`, `buildSkillGenerationPrompt`, `parseSkillMd`, name
  sanitizer — using `llmComplete`.
- **Commands** via message interceptor: `/skill_learn`, `/skill_cancel`,
  `/skill_status`, `/skill_save [name]`, `/skill_list`, `/skill_view <name>`,
  `/skill_delete <name>` (admin), `/skill_export <name>`, `/skill_help`
  (keep Chinese aliases). Capture-mode message recording + aggregate
  encouragement at message counts {1,3,5,10,15} and max-turn cap.
- **Deploy caveat**: vex loads skills once at startup (`createAgent` →
  `initSkills`). Document that a newly saved skill needs a restart (or add an
  optional `agent.reloadSkills()` that re-runs `initSkills` + `setSkillsRegistry`
  — recommended small addition for parity with AstrBot auto-deploy).
- Config block `skillLearner` with parity keys: `autoTriggerKeywords`,
  `maxLearningTurns`, `enableAutoLearn`, `enableProactiveSuggest`,
  `proactiveThreshold`, `autoDeployToSkills`.

## Phase 3 — Private Persona (`src/extensions/persona/`)

Port `astrbot_plugin_private_persona_counhopig` — the largest piece. Mirror the
Python module layout: `models.ts`, `storage.ts`, `config.ts`,
`engine/{promptBuilder,interaction,effectEngine,todoEngine,reflectionEngine,profileBuilder,utils}.ts`,
`commands.ts`, `index.ts`.

- **Models** (parity): `EmotionState` (energy/mood/social_need + decay/on_interact/
  narrative), `UserProfile` (incl. affinity), `ChatTurn`, `Effect`
  (intensity-decay curves), `Todo`, `InteractionEvent`, `Consolidation`,
  `ProfileFact`, `ReflectionRecord`; enums `TodoType`/`InteractionMode`/
  `InteractionOutcome`. Forward-compatible `fromDict` that ignores unknown keys.
- **Storage**: per-user JSON (emotion, profile, history, effects, todos,
  interactions, consolidations, reflections, profile_facts, turn_counters, umo,
  proactive_failure) with LRU cache — full method parity with `storage.py`.
- **Prompt injector** (`promptBuilder.build_all`): registers a prompt injector
  (Phase 0 seam) that, per private-chat message, applies emotion decay, cleans
  expired effects, touches profile, and returns the layered blocks: persona,
  first-chat hint, time, rest/sleep, consolidation, emotion, effect, todo,
  reflection, profile, history, style, goodnight. Honors `ignoreGroupChat`.
- **Message handling** (capture, via interceptor or a dedicated capture hook):
  append user turn, save UMO, `judge_outcome`, auto-trigger effects/todos
  **before** `record_interaction`, increment reflection/profile turn counters
  and fire `_run_reflection` / `_run_profile_building` (via `llmComplete`).
- **Response observer**: append bot turn + emotion recovery (`on_llm_response`
  parity).
- **Commands** (~30) via message interceptor, keeping Chinese aliases:
  `/persona`, `/persona_effects`, `/persona_todo`, `/persona_today`,
  `/persona_consolidate`, `/persona_apply`, `/persona_add_effect`,
  `/persona_add_todo`, `/persona_done_todo`, `/persona_reset`, `/persona_note`,
  `/persona_affinity`, `/persona_set_emotion`, `/persona_remove_effect`,
  `/persona_clear_effects`, `/persona_clear_todos`, `/persona_set_affinity`,
  `/persona_set_nickname`, `/persona_history`, `/persona_debug`,
  `/persona_set_config`, `/persona_reflections`, `/persona_facts`,
  `/persona_clear_reflections`, `/persona_remove_fact`, `/persona_help`.
- **Cron** (reuse `CronService`): periodic reflection, proactive nudge (lonely
  push via outbound `sendText`, with per-channel "can push" guard + failure
  cooldown), emotion decay. Register/cleanup by name like the Python version.
- **First-chat greeting** + **proactive nudge** use outbound `sendText` and
  `llmComplete`.
- **LLM tool** `upsert_cognitive_memory` registered in the tool registry
  (parity with the AstrBot `@filter.llm_tool`).
- Config block `persona` with all `_conf_schema.json` keys (persona_name,
  base_prompt, reply_style, time/emotion/effect/todo/consolidation/memory/
  reflection/profile/rest/proactive/storage/debug groups), Zod-validated, with
  the same defaults.

## Verification

- **Unit tests (Vitest)** mirroring the originals' `tests/`:
  `tests/persona-*.test.ts` (models decay/effect curves, storage round-trip,
  interaction judging, effect/todo engines, prompt builder, cron cleanup),
  `tests/sharelink.test.ts` (id extraction, registry match, output formatting),
  `tests/skilllearner.test.ts` (auto-trigger, name sanitize, session lifecycle,
  SKILL.md parse). Run: `npm test`.
- **Pipeline seams**: tests asserting a registered prompt injector mutates the
  per-turn system prompt and a message interceptor short-circuits the agent.
- **Build/typecheck**: `npm run build` clean.
- **End-to-end (manual, WebChat)**: `npm run build && vex start`, open WebChat:
  1. ShareLink: paste a Bilibili link → structured reply (+ summary if a
     summarize provider is set); also ask the agent to "解析这个视频" to exercise
     the tool path.
  2. Skill Learner: `/skill_learn` → send teaching messages → `/skill_save 测试` →
     confirm `~/.vex/skills/测试/SKILL.md` written; `/skill_list`, `/skill_view`.
  3. Persona: send a few private messages, then `/persona` and `/persona_help`
     to view emotion/effects/todos; confirm the injected persona tone appears in
     replies; verify cron jobs registered in logs.
- **WeChat path**: smoke-test the same interceptor/injector wiring through
  `gateway.handleMessage` (commands + auto-detect) once a WeChat session is
  available.

## Notes / risks

- Biggest risk is the **per-message system-prompt injection seam** in
  `runtime.ts` — it must set and then restore `_baseSystemPrompt` cleanly per
  turn so injected persona state never leaks between users sharing a runtime.
- Bilibili/YouTube scraping without the Python libs (`bilibili-api`, `yt-dlp`)
  is the most fragile parity area; cookie-gated subtitles and audio-STT fallback
  may need iteration.
- Skill hot-deploy requires the small `agent.reloadSkills()` addition for true
  parity; otherwise restart-to-activate.
