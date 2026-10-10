# Test suites

## OVERVIEW

Vitest runs `**/*.test.ts` here in the Node environment with a 20-second default timeout.
Suites combine module tests with real local HTTP, WebSocket, SQLite and subprocess integration.

## WHERE TO LOOK

| Concern | Suites | Focus |
|---------|--------|-------|
| Sessions and context | `session`, `session-manager`, `compaction`, `store`, `events`, `title` | Turns, restore, transcript ordering, budgets and persistence |
| Configuration | `config`, `config-secrets`, `settings`, `models`, `paths`, `reload`, `samples` | Defaults, validation, credentials, model selection and runtime reload |
| Onboarding and CLI | `onboard`, `cli-process`, `daemon`, `logging` | Initial files, process identity, service lifecycle and secret-free logs |
| Link-reader and skills | `link-skill`, `skill-scripts`, `skills` | Platform responses, redirects, subtitles, script inputs and discovery |
| WebChat | `gateway`, `protocol`, `auth`, `web-app` | HTTP/WS contracts, authentication and browser event handlers |
| WeChat | `wechat-client`, `wechat-login`, `wechat-channel`, `wechat-messages`, `wechat-store`, `daemon-wechat` | iLink requests, QR state, polling, delivery and credentials |
| Tools and approvals | `tools-*`, `policy`, `approvals` | Execution, access boundaries, cancellation and approval lifecycle |
| Background work | `scheduler`, `persona`, `memory-index` | Scheduled delivery, persona state and FTS memory |
| Workspace and prompts | `workspace`, `prompt` | File boundaries, templates, daily notes and prompt composition |
| Notes vault | `vault-parse`, `vault-git`, `vault`, `vault-tools` | Note parsing, git mirror, search, tool output and path safety |
| LLM wiki | `wiki-*`, `daemon-wiki` | Repo transactions, markers, reconciliation, scheduling gates, tools, review and daemon delivery |
| Agent execution | `agent-workflow`, `execution`, `jev`, `context-budget`, `link-source` | Link actions, evidence checks, decision judge, request budgets and original-source reading |

Suite names in the table omit `.test.ts`.

## LOCAL HELPERS

- `helpers/tmp.ts`: pair `makeTmpDir()` with awaited `removeTmpDir()` in teardown.
- `helpers/faux.ts`: `createFaux`, `fauxModels` and `fauxStreamFn` provide deterministic model responses without external providers; `lastUserText` extracts the latest user input.
- `helpers/client.ts`: `TestClient` records typed server messages, sends protocol messages or raw input, and waits for a matching message with a five-second polling deadline. Close each connected client.
- `helpers/ilink.ts`: `FakeIlink` binds a loopback HTTP server on an ephemeral port, records requests, queues update batches and supplies configurable routes. Await `stop()` after use; `textMessage` builds incoming text fixtures.
- `helpers/gitRemote.ts`: `makeRemote` creates a bare repository plus a working copy; `commit` writes files, commits at a fixed date and force-pushes. Used with the real `git` binary and local paths, never the network.

## TEST BOUNDARIES

- Configuration and onboarding tests use temporary data homes. Restore `vi.stubEnv` changes with `vi.unstubAllEnvs()` in `finally` or teardown.
- Session and daemon suites inject faux model implementations while exercising persistence and service assembly.
- Gateway tests use real local WebSockets; release clients and listening servers before removing temporary files.
- `tools-mcp.test.ts` starts actual Node stdio servers and SDK-backed Streamable HTTP services. Close bridges and transports even when assertions fail.
- `web-app.test.ts` executes `src/web/static/app.js` in `node:vm` with local DOM, WebSocket, storage and timer stubs. Extend those stubs only for browser behavior needed by the assertion.
- `link-skill.test.ts` imports source MJS modules and injects `PageRequest` routes and summary callbacks. Fixtures inspect cookie routing, redirects and unsupported destinations without contacting platform services.
- `skill-scripts.test.ts` injects weather fetch responses and an image registry, and removes temporary image fixtures after each test.
- `cli-process.test.ts` checks PID records against process start time and command identity, including legacy records and reused PIDs. Liveness alone does not establish daemon ownership.
- Scheduler and polling assertions use observable messages or state; follow existing `vi.waitFor` patterns for asynchronous completion.

## TARGETED RUNS

Run from the repository root:

```bash
npm test -- tests/session.test.ts tests/session-manager.test.ts
npm test -- tests/gateway.test.ts tests/web-app.test.ts
npm test -- tests/wechat-client.test.ts tests/wechat-channel.test.ts
npm test -- tests/tools-mcp.test.ts
npm test -- tests/link-skill.test.ts tests/skill-scripts.test.ts
```
