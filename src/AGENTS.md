# Runtime

## OVERVIEW

`daemon.ts` assembles shared services; SessionManager connects browser and WeChat turns to tools and approvals.

## STRUCTURE

```text
src/
├── cli/                   # Process lifecycle, onboarding and login
├── core/                  # Sessions, event bus and browser session metadata
├── context/               # Request prompts and context compaction
├── gateway/               # Authentication, HTTP and WebSocket dispatch
├── protocol/              # Validated client messages and server contracts
├── channels/wechat/       # Polling, credentials and channel reconciliation
├── tools/                 # Agent tool factories and MCP connections
├── policy/                # Decisions, approval lifecycle and execution gate
├── config/                # Schema, editable settings and restart recovery
├── scheduler/             # Persistent schedules and temporary background turns
├── index/                 # Memory indexing, tokenization and search
├── persona/               # Mood, rest and proactive conversation state
├── workspace/             # Owner files, templates and daily notes
├── skills/                # Skill discovery and prompt integration
├── store/                 # Atomic writes and append-only JSONL
├── providers/             # Model registration and streaming
└── web/static/            # Browser handlers and presentation
```

## WHERE TO LOOK

| Change | Coordinated files |
|--------|-------------------|
| Add an agent tool | `tools/<name>.ts`, `tools/registry.ts`, `daemon.ts`, `policy/policy.ts`, `tools/summary.ts` |
| Change a streamed event | `core/events.ts`, `core/session.ts`, `channels/wechat/channel.ts`, `web/static/app.js` |
| Add a browser command | `protocol/messages.ts`, `gateway/server.ts`, `daemon.ts`, `web/static/app.js` |
| Change editable settings | `config/schema.ts`, `config/settings.ts`, `daemon.ts`, `web/static/app.js` |
| Expose a workspace file in WebChat | `workspace/workspace.ts`, `protocol/messages.ts`, `gateway/server.ts`, `daemon.ts`, `web/static/app.js` |
| Change background delivery | `scheduler/index.ts`, `daemon.ts`, `core/session.ts`, `index/memory.ts` |
| Change WeChat lifecycle | `channels/wechat/setup.ts`, `channel.ts`, `store.ts`, `client.ts` |

## LOCAL CONVENTIONS

- Session events use `kind`; bus events and wire messages use `type`. Keep all consumers aligned with the discriminated unions.
- Tools are `create*Tool` factories returning pi `AgentTool` objects with TypeBox parameters; pass workspace, dependencies and cancellation through factory options and execution signals.
- `createCoreTools` contains filesystem, shell and search tools; `daemon.ts` assembles memory, persona, web, schedules, MCP and delegation per session.
- Validate incoming browser messages with `parseClientMessage`; keep outgoing responses in `ServerMessage`.
- Browser Markdown uses text nodes and validated links; dynamic content uses `textContent` or constructed DOM nodes.
- Settings forms accept only `ALLOWED` paths, return secret presence separately, preserve unknown YAML keys/comments and validate the complete resulting configuration.
- Workspace file names in `WorkspaceFileName` (fixed names plus the `memory/YYYY-MM-DD.md` pattern) are the only paths WebChat can read or write; `listDailyNotes` uses the same pattern. Keep both and the browser pages in step.
- Rebuild the system prompt before each model request so workspace content, time and window labels remain current.

## INVARIANTS AND ANTI-PATTERNS

- Keep the complete transcript separate from compacted model context; compaction records append to JSONL and history reads the full transcript (`core/session.ts:73`, `core/session.ts:184`).
- Stop must abort retry backoff and the agent, clear steering queues and retain messages received while stopping for a subsequent turn; disposal waits for queued transcript writes (`core/session.ts:105`, `core/session.ts:135`).
- Explicit policy denial precedes session approval reuse; denied tools are also filtered from model visibility (`policy/gate.ts:14`, `policy/policy.ts:33`).
- Non-loopback binding requires a web token (`daemon.ts:75`).
- Workspace write/edit permissions use real paths, including the nearest existing ancestor for new files. Never allow a dangling symlink as a new path segment (`policy/policy.ts:46`, `policy/policy.ts:60`).
- Shell children inherit only the environment allowlist, configured passthrough and locale keys; preserve process-group cancellation and bounded output collection (`tools/bash.ts:15`, `tools/bash.ts:68`, `tools/bash.ts:90`).
- Web requests validate public URLs and every resolved address at connection lookup; preserve redirect validation and response limits (`tools/web.ts:44`, `tools/web.ts:58`, `tools/web.ts:82`).
- Delegates have no conversation history and cannot receive the `delegate` tool; reuse the parent's execution gate (`tools/delegate.ts:26`, `tools/delegate.ts:31`, `daemon.ts:165`).
- WeChat accepts only the owner, deduplicates message IDs and persists context tokens/sync state. Sending requires a context token; expiry ends polling and clears sync state (`channels/wechat/channel.ts:112`, `channels/wechat/channel.ts:128`, `channels/wechat/channel.ts:247`).
- Credential changes are reconciled by stopping the previous channel before starting its replacement; missing/expired login triggers the runtime QR flow (`channels/wechat/setup.ts:93`).
- Restarting configuration saves retain the previous configuration; failed startup restores it and records the reload error (`config/reload.ts:19`, `config/reload.ts:34`, `cli/index.ts:104`).
- Persist a schedule's advanced trigger/one-time disable state before launching delivery; serialize mutations and restore in-memory state on save failure (`scheduler/index.ts:76`, `scheduler/index.ts:160`).
- Each proactive-chat prompt carries the current time and quiet-period facts; an identical repeated prompt makes the model copy its previous reply from the history (`persona/index.ts:141`, `daemon.ts:241`).
- Memory indexing excludes temporary `sessions/runs` transcripts and messages with `vexSource`; temporary heartbeat/consolidation transcripts are removed on disposal (`index/memory.ts:74`, `index/memory.ts:105`, `daemon.ts:229`).
