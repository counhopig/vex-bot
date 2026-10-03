# Tests

## OVERVIEW

Vitest Node suites cover module behavior, real local services, child processes and browser scripts.

## WHERE TO LOOK

| Coverage | Files |
|----------|-------|
| Sessions, restoration and compaction | `session.test.ts`, `session-manager.test.ts`, `compaction.test.ts` |
| Daemon and WeChat assembly | `daemon.test.ts`, `daemon-wechat.test.ts` |
| Gateway, authentication, protocol and approvals | `gateway.test.ts`, `auth.test.ts`, `protocol.test.ts`, `approvals.test.ts` |
| iLink, credentials, messages and login | `wechat-*.test.ts` |
| Tools and MCP transports | `tools-*.test.ts` |
| Scheduling, persona and retrieval | `scheduler.test.ts`, `persona.test.ts`, `memory-index.test.ts` |
| Workspace, skills and configuration samples | `workspace.test.ts`, `skills.test.ts`, `skill-scripts.test.ts`, `samples.test.ts` |
| Static WebChat interaction | `web-app.test.ts` |
| PID and CLI process behavior | `cli-process.test.ts` |

## CONVENTIONS

- `../vitest.config.ts` collects `tests/**/*.test.ts`; default test timeout is 20 seconds.
- Temporary workspaces use `makeTmpDir` / `removeTmpDir` from `helpers/tmp.ts`, paired in test hooks.
- Model fixtures use `helpers/faux.ts`: `createFaux`, `fauxModels`, `fauxStreamFn`; `lastUserText` extracts the final user text.
- WebSocket assertions use `TestClient` from `helpers/client.ts`; message polling has a 5-second timeout and 10-ms interval.
- WeChat fixtures use `FakeIlink` from `helpers/ilink.ts`; loopback port 0, recorded HTTP requests and queued updates.
- MCP suites launch real stdio processes and Streamable HTTP services; teardown closes the bridge.

## NOTES

- `web-app.test.ts` executes `../src/web/static/app.js` in `node:vm` with local Element and WebSocket stubs.
- `tools-mcp.test.ts` embeds ESM server scripts launched through `process.execPath --input-type=module -e`.
- `cli-process.test.ts` verifies PID identity records; a live PID alone does not establish process identity.
- Gateway and WeChat suites need local listening ports; MCP and CLI suites need child processes.
- Skill script tests import bundled `.mjs` functions with injected fetch/model dependencies.

## COMMANDS

Run from the repository root:

```bash
npm test -- tests/session.test.ts tests/compaction.test.ts
npm test -- tests/gateway.test.ts tests/auth.test.ts
npm test -- tests/wechat-client.test.ts tests/daemon-wechat.test.ts
npm test -- tests/tools-mcp.test.ts
npm test -- tests/web-app.test.ts
```
