# Vex Bot — Personal WeChat and WebChat assistant

**Generated:** 2026-10-05
**Commit:** 8bb4b24
**Branch:** master

## OVERVIEW

One Node.js daemon shares sessions, workspace, tools, configuration and approvals across WeChat and WebChat.
TypeScript ESM; pi Agent/AI, SQLite FTS5, Croner, MCP SDK; Node.js ≥24.

## STRUCTURE

```text
./
├── src/                    # Runtime and static WebChat
├── tests/                  # Module and local-service integration suites
├── skills/                 # Bundled image, weather and link-reader assets
├── scripts/copy-static.mjs # Copies browser and skill assets into dist
├── docs/                   # Architecture, configuration, operations, samples
├── .github/workflows/docker.yml
├── Dockerfile
├── compose.yaml
└── compose.searxng.yaml     # Optional search service
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Bootstrap and shutdown | `src/cli/index.ts`, `src/daemon.ts` | CLI dispatch and shared service assembly |
| Sessions and context | `src/core/`, `src/context/` | Turns, persistence, prompts, compaction |
| Browser interface | `src/gateway/`, `src/protocol/`, `src/web/static/` | HTTP, WebSocket, handwritten browser handlers |
| WeChat | `src/channels/wechat/` | iLink polling, QR login, credential reload |
| Tools and permissions | `src/tools/`, `src/policy/` | Factories, MCP, approvals, execution gate |
| Memory and background work | `src/index/`, `src/scheduler/`, `src/persona/` | FTS5, schedules, mood and proactive messages |
| Configuration and models | `src/config/`, `src/providers/models.ts`, `src/paths.ts` | Validation, settings, registry, data home |
| Workspace and skill discovery | `src/workspace/`, `src/skills/` | User files, daily notes, skill precedence |
| Bundled skill scripts | `skills/` | Link-reader modules split by platform |
| Deployment and samples | `docs/operations.md`, `docs/configuration.md`, `docs/samples/` | Match runtime schemas and defaults |

## CODE MAP

| Symbol | Type | Location | Refs | Role |
|--------|------|----------|------|------|
| `startDaemon` | function | `src/daemon.ts` | unmeasured | Assembly and shutdown |
| `Session` | class | `src/core/session.ts` | unmeasured | Agent turns and transcript |
| `SessionManager` | class | `src/core/sessionManager.ts` | unmeasured | Session cache and restoration |
| `Gateway` | class | `src/gateway/server.ts` | unmeasured | HTTP and WebSocket |
| `ContextCompactor` | class | `src/context/compaction.ts` | unmeasured | Context budgets and memory rescue |
| `MemoryIndex` | class | `src/index/memory.ts` | unmeasured | SQLite FTS5 indexing |
| `Scheduler` | class | `src/scheduler/index.ts` | unmeasured | Scheduled and background turns |
| `createCoreTools` | function | `src/tools/registry.ts` | unmeasured | Core tool factories |

## CONVENTIONS

- Relative TypeScript imports use `.js`; Node built-ins use `node:`.
- ES2023/NodeNext; strict checking with `noUncheckedIndexedAccess`, `noImplicitReturns`, `noFallthroughCasesInSwitch`.
- `npm run lint` checks source, tests and Vitest configuration; browser JS and skill MJS are outside its coverage.
- Double quotes, two spaces, semicolons; no separate formatter or ESLint configuration.

## ANTI-PATTERNS (THIS PROJECT)

- Do not substitute bare `tsc` for the full build; browser and skill assets require copying (`package.json:16`, `scripts/copy-static.mjs:3`).
- Image provider/model overrides must be paired; API keys stay out of command arguments (`skills/image/SKILL.md:16`).
- Weather locations come from the request or workspace material (`skills/weather/SKILL.md:8`).
- Link-reader cookies stay out of command arguments; page content is untrusted input (`skills/link-reader/SKILL.md:35`).

## UNIQUE STYLES

- Single package; browser UI is plain JS/CSS/HTML without a frontend build.
- Published files are `dist/**`; executable entry is `dist/cli/index.js`.
- Workspace skills override bundled skills by name; discovery code and skill assets live separately.
- Build clears `dist`, compiles only `src/**/*.ts`, then copies static files and bundled skills.

## COMMANDS

```bash
npm ci
npm run dev
npm run lint
npm test
npm run build
docker-compose run --rm vex onboard
docker-compose up -d
```

## NOTES

- `VEX_HOME` defaults to `~/.vex`; CLI and daemon must use the same data home.
- Build before executing the image skill from source: it imports the compiled model registry.
- Docker runs as `node` with `/data`; health checks target container port 7860.
- Compose publishes on host loopback; the container listens on `0.0.0.0`.
- Docker includes FFmpeg and architecture-specific yt-dlp for link-reader transcription.
- Docker includes git for the notes vault mirror (`vault.url`).
- CI checks types/tests on Node 24 before amd64/arm64 image builds; pull requests do not publish images.
