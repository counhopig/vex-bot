# Vex Bot — Personal AI assistant

## OVERVIEW

One Node.js daemon serves personal WeChat and WebChat, sharing a workspace, tools, configuration and approval queue.
TypeScript ESM; pi Agent/AI, SQLite FTS5, Croner and MCP SDK; Node.js ≥24.

## STRUCTURE

```text
./
├── src/                 # Daemon, CLI, channels and static WebChat
├── tests/               # Module tests and local-service integration tests
├── skills/              # Bundled weather and image skills
├── scripts/copy-static.mjs
├── docs/                # Architecture, configuration, operations and samples
├── .github/workflows/docker.yml
├── Dockerfile
└── compose.yaml
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Bootstrap and service assembly | `src/cli/index.ts`, `src/daemon.ts` | CLI → configuration → daemon |
| Sessions and context | `src/core/`, `src/context/` | Lifecycle, prompts and compaction |
| Browser interface | `src/gateway/`, `src/protocol/`, `src/web/static/` | HTTP, WebSocket and browser code |
| WeChat integration | `src/channels/wechat/` | iLink, QR login and credential reload |
| Tools and permissions | `src/tools/`, `src/policy/` | Tool factories and approvals |
| Memory and background work | `src/index/`, `src/scheduler/`, `src/persona/` | FTS5, schedules and mood |
| Configuration and workspace | `src/config/`, `src/paths.ts`, `src/workspace/` | Schemas, paths and templates |
| Bundled skills | `skills/`, `src/skills/` | Scripts and SKILL.md discovery |
| Deployment and samples | `docs/operations.md`, `docs/configuration.md`, `docs/samples/` | Cross-check against runtime code |

## CODE MAP

| Symbol | Type | Location | Role |
|--------|------|----------|------|
| `startDaemon` | function | `src/daemon.ts` | Service assembly and shutdown |
| `Session` | class | `src/core/session.ts` | pi Agent conversation |
| `SessionManager` | class | `src/core/sessionManager.ts` | Session cache and restoration |
| `Gateway` | class | `src/gateway/server.ts` | HTTP and WebSocket |
| `ContextCompactor` | class | `src/context/compaction.ts` | Memory rescue and context budgets |
| `MemoryIndex` | class | `src/index/memory.ts` | SQLite FTS5 indexing |
| `Scheduler` | class | `src/scheduler/index.ts` | Scheduled and background turns |
| `createCoreTools` | function | `src/tools/registry.ts` | File, shell and search tools |

## CONVENTIONS

- Relative TypeScript imports use `.js` extensions; Node built-ins use `node:`.
- ES2023 target with NodeNext; `noUncheckedIndexedAccess`, `noImplicitReturns` and `noFallthroughCasesInSwitch` enabled.
- `npm run lint` checks types in src, tests and Vitest configuration; excludes `.js` and `.mjs`.
- Existing formatting: double quotes, two spaces, semicolons; no separate formatter or ESLint configuration.

## ANTI-PATTERNS (THIS PROJECT)

- Do not replace the full build with bare `tsc`: static assets and bundled skills require copying (`build` script in `package.json`).
- Image skill provider/model overrides must be supplied together; keep API keys out of command arguments (`skills/image/SKILL.md`, `main` in `skills/image/scripts/analyze.mjs`).
- Weather locations must come from the user request or workspace material (`skills/weather/SKILL.md`).

## UNIQUE STYLES

- Single package; browser code is plain JS/CSS/HTML with no frontend build.
- npm publishes only `dist/**`; CLI entry is `dist/cli/index.js`.
- Workspace skills override bundled skills by name; discovery code lives separately from skill assets.

## COMMANDS

```bash
npm ci
npm run dev
npm run lint
npm test
npm run build
docker compose run --rm vex onboard
docker compose up -d
```

## NOTES

- Data root is `VEX_HOME`, defaulting to `~/.vex`; CLI and daemon must use the same value.
- Build before running the image skill from source; it imports the compiled model registry.
- Docker uses a non-root user and `/data`; Compose publishes on host loopback while the container listens on `0.0.0.0`.
- Docker health checks use port 7860; port changes require matching container settings.
- CI checks types and tests on Node 24 before building amd64/arm64 images; PR builds do not publish.
