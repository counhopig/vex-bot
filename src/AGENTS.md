# Runtime

## OVERVIEW

`daemon.ts` assembles shared services and `shutdown.ts` releases them in one order; `sessionFactory.ts` builds each session's prompt, tools, gate and link actions; SessionManager connects browser and WeChat turns to tools and approvals.

## STRUCTURE

```text
src/
├── cli/                   # Process lifecycle, onboarding and login
├── core/                  # Sessions, turn-controller hooks, event bus and browser session metadata
├── context/               # Request prompts and context compaction
├── gateway/               # Authentication, HTTP and WebSocket dispatch
├── protocol/              # Validated client messages and server contracts
├── channels/wechat/       # Polling, credentials and channel reconciliation
├── channels/device/       # Desk device: one session, send/stop only, turn replies and outbox
├── links/                 # Shared links: original-source reading and runtime-owned link actions
├── tools/                 # Agent tool factories and MCP connections
├── policy/                # Decisions, approval lifecycle and execution gate
├── config/                # Schema, editable settings and restart recovery
├── scheduler/             # Persistent schedules and temporary background turns
├── index/                 # Memory indexing, tokenization and search
├── persona/               # Mood, rest and proactive conversation state
├── vault/                 # Notes vault: git mirror or folder, note parsing, search tools
│   └── wiki/              # LLM wiki over the vault's single writable clone: transactions and tools
├── workspace/             # Owner files, templates and daily notes
├── skills/                # Skill discovery and prompt integration
├── store/                 # Atomic writes and append-only JSONL
├── trace/                 # Run traces: recording, store, retention
├── providers/             # Model registration and streaming
└── web/static/            # Browser handlers and presentation
```

## WHERE TO LOOK

| Change | Coordinated files |
|--------|-------------------|
| Add an agent tool | `tools/<name>.ts`, `tools/registry.ts`, `daemon.ts`, `sessionFactory.ts`, `policy/policy.ts`, `tools/summary.ts` |
| Change a streamed event | `core/events.ts`, `core/session.ts` (`turn_end` carries the reply that ends a run), `channels/wechat/channel.ts`, `channels/device/channel.ts`, `web/static/app.js` |
| Change session keys or schedule targets | `core/sessionKey.ts` (the only place `web:`/`run:` keys are built or parsed) |
| Add or change a kind of run | `sessionFactory.ts` (`profiles`: owner or background, model, prompt, tools, gate) |
| Add a browser command | `protocol/messages.ts`, `gateway/server.ts`, `daemon.ts`, `web/static/app.js` |
| Change editable settings | `config/schema.ts`, `config/settings.ts`, `daemon.ts`, `web/static/app.js` |
| Expose a workspace file in WebChat | `workspace/workspace.ts`, `protocol/messages.ts`, `gateway/server.ts`, `daemon.ts`, `web/static/app.js` |
| Change background delivery | `scheduler/index.ts`, `daemon.ts`, `core/session.ts`, `index/memory.ts` |
| Change the device protocol | `protocol/device.ts`, `channels/device/channel.ts`, `gateway/server.ts` (`/device/ws`), `docs/architecture.md` (Device channel) |
| Change WeChat lifecycle | `channels/wechat/setup.ts`, `channel.ts`, `store.ts`, `client.ts` |
| Change link actions | `links/actions.ts`, `core/turnController.ts`, `tools/requestOutcome.ts`, `sessionFactory.ts` (`LINK_ROUTES`) |
| Change link intent classification | `links/intent.ts`, `links/actions.ts`, `providers/jev.ts`, `sessionFactory.ts` (`linkClassifier`) |
| Change how provider failures reach the owner | `providers/errors.ts` (`withProviderFailures`), `core/session.ts`, `tools/delegate.ts` |
| Change the LLM wiki | `vault/wiki/service.ts`, `vault/wiki/tools.ts`, `vault/wiki/write.ts`, `vault/notes.ts`, `config/schema.ts` (`vault.wiki`), `config/settings.ts`, `scheduler/index.ts`, `context/prompt.ts`, `policy/policy.ts`, `tools/summary.ts`, `daemon.ts`, `sessionFactory.ts`, `web/static/app.js` |
| Change what a run trace records | `trace/types.ts`, `trace/observe.ts`, `trace/store.ts`, `core/session.ts`, `tools/delegate.ts`, `web/static/app.js` |
| Change the notes vault | `vault/git.ts`, `vault/parse.ts`, `vault/notes.ts`, `vault/tools.ts`, `config/schema.ts`, `config/settings.ts`, `daemon.ts`, `web/static/app.js` |

## LOCAL CONVENTIONS

- Session events use `kind`; bus events and wire messages use `type`. Keep all consumers aligned with the discriminated unions.
- Tools are `create*Tool` factories returning pi `AgentTool` objects with TypeBox parameters; pass workspace, dependencies and cancellation through factory options and execution signals.
- `createCoreTools` contains filesystem, shell and search tools; `daemon.ts` builds the shared memory, persona, web and vault tools; `sessionFactory.ts` adds schedules, MCP, wiki and delegation per session.
- Validate incoming browser messages with `parseClientMessage`; keep outgoing responses in `ServerMessage`.
- Browser Markdown uses text nodes and validated links; dynamic content uses `textContent` or constructed DOM nodes.
- Settings forms accept only `ALLOWED` paths, return secret presence separately, preserve unknown YAML keys/comments and validate the complete resulting configuration.
- Workspace file names in `WorkspaceFileName` (fixed names plus the `memory/YYYY-MM-DD.md` pattern) are the only paths WebChat can read or write; `listDailyNotes` uses the same pattern. Keep both and the browser pages in step.
- Rebuild the system prompt before each model request so workspace content, time and window labels remain current.

## INVARIANTS AND ANTI-PATTERNS

- Keep the complete transcript on disk separate from the bounded model window and rendered history cache. Compaction records use absolute message indices; old unsummarized prefixes recover from disk in batches. WebChat pages history with rendered-item cursors (`core/session.ts`, `core/history.ts`, `context/compaction.ts`).
- Idle WebChat sessions are evicted after 30 minutes without use: only a fully idle session (`Session.idle`) that no pending approval retains. It leaves the cache before `dispose()` starts; the next `get()` waits for that disposal and reopens from the flushed JSONL, and a lookup that raced the eviction is re-resolved rather than handed the disposing instance. WeChat is never evicted (`core/sessionManager.ts`, `daemon.ts`).
- Stop must abort retry backoff and the agent, clear steering queues and retain messages received while stopping for a subsequent turn; disposal waits for queued transcript writes (`core/session.ts:105`, `core/session.ts:135`).
- Explicit policy denial precedes session approval reuse; denied tools are also filtered from model visibility (`policy/gate.ts:14`, `policy/policy.ts:33`).
- A run the runtime starts (`Session.unattended`: a source and no joined owner message) never raises an approval: the gate refuses an `ask` tool at once (`policy/gate.ts`, `core/session.ts`, `sessionFactory.ts`).
- Non-loopback binding requires a web token (`daemon.ts:83`).
- The device token is separate from the web token and reaches only `device` session send/stop; `/device/ws` refuses requests with an `Origin` header and does not exist without `device.token` (`gateway/server.ts`, `channels/device/channel.ts`).
- Read/grep/find and write/edit permissions use real paths, including the nearest existing ancestor for new files; reads are free inside the workspace and the bundled skills directory, writes only inside the workspace. Never allow a dangling symlink as a new path segment (`tools/paths.ts:19`, `policy/policy.ts:43`, `policy/policy.ts:61`).
- Shell children inherit only the environment allowlist, configured passthrough and locale keys; preserve process-group cancellation and bounded output collection (`tools/bash.ts:15`, `tools/bash.ts:68`, `tools/bash.ts:90`).
- Web requests validate public URLs and every resolved address at connection lookup; preserve redirect validation and response limits (`tools/web.ts:44`, `tools/web.ts:58`, `tools/web.ts:82`).
- Delegates have no conversation history and cannot receive the `delegate` tool; reuse the parent's execution gate (`tools/delegate.ts:26`, `tools/delegate.ts:31`, `sessionFactory.ts:171`).
- WeChat accepts only the owner, deduplicates message IDs and persists context tokens/sync state. Sending requires a context token; expiry ends polling and clears sync state (`channels/wechat/channel.ts:112`, `channels/wechat/channel.ts:128`, `channels/wechat/channel.ts:247`).
- Credential changes are reconciled by stopping the previous channel before starting its replacement; missing/expired login triggers the runtime QR flow (`channels/wechat/setup.ts:93`).
- Restarting configuration saves retain the previous configuration; failed startup restores it and records the reload error (`config/reload.ts:19`, `config/reload.ts:34`, `cli/index.ts:104`).
- Persist a schedule's advanced trigger/one-time disable state before launching delivery; serialize mutations and restore in-memory state on save failure (`scheduler/index.ts:76`, `scheduler/index.ts:160`).
- Each proactive-chat prompt carries the current time and quiet-period facts; an identical repeated prompt makes the model copy its previous reply from the history (`persona/index.ts:141`, `daemon.ts:222`).
- Memory indexing excludes temporary `sessions/runs` transcripts and messages with `vexSource`; temporary heartbeat/consolidation transcripts are removed on disposal (`index/memory.ts:74`, `index/memory.ts:105`, `sessionFactory.ts:219`).
- The repository is cloned once. With `vault.wiki` the vault takes `wiki.notesCopy` as its `copy` and creates no mirror; `WikiReadCopy` fast-forwards that clone only when nothing holds or waits for `WikiLock`, no batch is in flight and the tree is clean, so reads during a compile run never wait (`vault/notes.ts`, `vault/wiki/readCopy.ts`, `vault/wiki/lock.ts`).
- The vault tools are read-only and have no write path. Git credentials travel only in `GIT_CONFIG_*` environment variables and are scrubbed from errors (`vault/git.ts`); `vault_read` accepts only relative `.md` paths found by the scan and re-checks the real path against the vault root; symlinks and dot-names are skipped (`vault/notes.ts`).
- The wiki plugs in through the existing seams: the scheduler owns only its cadence and asks `hooks.wikiWork`/`hooks.runWiki`; `Wiki.dueWork` decides bootstrap, backoff and review gating (`scheduler/index.ts`, `vault/wiki/service.ts`). Compiler runs are ordinary temporary `run:` sessions built by the session factory's temporary-session helper, with a `SystemPromptBuilder` prompt and the `llm-wiki` skill resolved through skill discovery (`sessionFactory.ts`, `skills/discovery.ts`).
- Wiki writes go only through `writeWikiFile` under an in-flight marker, inside `wiki/` and `raw/`; the clone is a policy protected root, so general `write`/`edit` cannot reach it. `wiki/tools.ts` depends on the service for types only; the service never builds agent tools (`vault/wiki/write.ts`, `policy/policy.ts`).
- `Session` knows no tool or business rule; runtime sources that stay silent until the owner joins (proactive chat) are passed in as `quietSources`. Runtime behaviour reaches it only through a `TurnController` (tools, stream wrapper, a gate in front of the owner's gate, lifecycle hooks); link actions are one such controller (`core/turnController.ts`, `links/actions.ts`).
- Decide at intake, never inspect replies: a shared link's intent is classified once (Jev, else the main model), the routed tool runs through the owner's gate before the model answers, and the owner hears refusals and unarchived outcomes from the runtime. Text sent to Jev is redacted with `redactSecrets` (`links/actions.ts`, `sessionFactory.ts`).
- Every model request passes the budget check; a provider's raw error goes to the log and the owner sees only its cause (`context/budget.ts`, `providers/errors.ts`).
- Run traces observe without steering: `trace/observe.ts` wraps the provider stream beneath the budget layer, the tool gate and agent events; a trace failure is a warning, never a turn failure. Every payload is redacted with the configured secrets and bounded before it is written or sent to a watching WebChat client (`trace/store.ts`).
- A bootstrap preview has one publishing entry: `wiki_bootstrap` behind its `ask` policy. The runtime only notifies the owner and never raises approvals for non-tool events; the tool returns a `publication` receipt (`vault/wiki/tools.ts`).
