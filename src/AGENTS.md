# Runtime source

## OVERVIEW

`daemon.ts` assembles shared services; channels reach sessions, tools and approvals through SessionManager.

## STRUCTURE

```text
./
├── cli/             # Commands, process management, onboarding and WeChat login
├── core/            # Agent sessions, events, titles and Web session index
├── context/         # System prompts, compaction and memory rescue
├── gateway/         # Browser authentication, HTTP and WebSocket
├── protocol/        # Client runtime schemas and server message types
├── channels/wechat/ # iLink polling, message conversion, login and state
├── policy/          # Tool policy, execution gate and approval queue
├── tools/           # Tool factories, MCP and delegation
├── store/           # JSONL and atomic writes
└── web/static/      # Browser resources
```

## WHERE TO LOOK

| Task | Location | Constraint |
|------|----------|------------|
| Dependencies and shutdown | `daemon.ts` | Startup failure cleanup and normal shutdown |
| Busy state, interruption and queues | `core/session.ts` | Active turns steer; stopping turns queue new messages |
| Persistence and restoration | `core/sessionManager.ts`, `core/webSessions.ts`, `store/jsonl.ts` | Web index rebuilds from transcripts |
| Web message changes | `protocol/messages.ts`, `gateway/server.ts`, `web/static/app.js` | Coordinate schemas, dispatch and browser handlers |
| Tool permissions | `policy/policy.ts`, `policy/gate.ts`, `policy/approvals.ts` | Denial, session grants and single-use approvals |
| WeChat delivery | `channels/wechat/channel.ts`, `channels/wechat/client.ts` | Owner filtering, deduplication and context tokens |
| Tool assembly | `tools/registry.ts`, `daemon.ts` | Core factories versus session-specific tools |
| Model resolution and keys | `providers/models.ts` | Shared registry for CLI, sessions and tools |

## CONVENTIONS

- Session events live in `core/events.ts`; Gateway wraps them with a Web session ID.
- Tool factories accept workspace and injected dependencies; daemon assembles session-specific tools.
- Web session metadata writes are serialized and use atomic replacement from `store/atomic.ts`.
- Browser protocol handling is handwritten; check both history replay and live events when changing message shapes.
- Dynamic browser content uses `textContent` or DOM nodes built by `renderMarkdown`; never `innerHTML`. DOM IDs and state classes match the HTML and CSS.
- Background-task prompts live in the workspace files listed in `workspace/prompts.ts` (read fresh on every use, built-in default when missing); add a file there, to the protocol's file list and to `FILE_PAGES` in `web/static/app.js` together. The base instructions in `context/prompt.ts` are built in on purpose.
- Settings edits are limited to the keys in `config/settings.ts`; the form definition in `web/static/app.js` must stay in step with it.
- A saved change that needs a restart is applied by `process.execve` from `cli/index.ts` after `commitConfig` in `daemon.ts`; `config/reload.ts` keeps the rollback marker. Never log message text or secrets.

## ANTI-PATTERNS

- Session grants cannot override explicit deny (`createToolGate` in `policy/gate.ts`).
- Preserve cancellation of backoff, Agent queues and runs (`Session.stop` in `core/session.ts`); approval cancellation removes listeners and ends waits (`finish` in `ApprovalManager`, `policy/approvals.ts`).
- Reject non-owner WeChat messages and duplicate message IDs (`handleInbound` in `channels/wechat/channel.ts`).
- Path resolution is not a workspace sandbox; absolute paths and home expansion are supported (`resolveToolPath` in `tools/paths.ts`).
- Preserve real-path checks for write/edit policy, including symlinks (`decideByPath` in `policy/policy.ts`).
- Bash receives an environment allowlist rather than the full process environment (`BASE_ENV_ALLOWLIST` in `tools/bash.ts`).
- Preserve connection-time DNS checks and redirect validation for public-web fetching (`createPublicPageRequest` and `fetchPublicPage` in `tools/web.ts`).
- Delegated agents receive no parent history and cannot delegate recursively (`createDelegateTool` in `tools/delegate.ts`).
- Non-loopback binding requires a web token (`startDaemon` in `daemon.ts`).

## NOTES

- WeChat replies require a context token from an inbound message.
- `channels/wechat/setup.ts` (`runWeChat`) starts and stops the channel and reloads it when `credentials.json` changes; it also runs the in-daemon QR login while WeChat is unlinked or expired.
- Browser IDs become internal `web:` session keys in Gateway.
- Missing or corrupt Web indexes recover metadata from `.jsonl` files.
- Compaction changes model context while retaining transcripts; temporary runs are excluded from memory indexing.
- WeChat API errors may appear in HTTP 200 bodies; code -14 means the login session expired.
