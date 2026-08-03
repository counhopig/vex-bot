# Vex

General-Purpose AI Agent Framework — Persona-Driven, Multi-Channel, Tool-Native

[![version](https://img.shields.io/badge/version-1.15.0-blue)](https://github.com/counhopig/vex-bot)
[![license](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D24-brightgreen)](https://nodejs.org)

Vex is a TypeScript ESM agent framework built on `@mariozechner/pi-coding-agent` and `@mariozechner/pi-ai`. It connects to personal WeChat, runs in the browser via a server-rendered WebChat UI, and supports Chinese LLM providers alongside OpenAI/Anthropic-compatible APIs. Forked from [OpenMozi](https://github.com/oujingzhou/openmozi) (Apache 2.0).

> The full architecture rewrite is complete on this branch. The legacy implementation remains in [`_archive/`](_archive/) for historical reference only; new runtime code lives under [`src/`](src/). See [`docs/rewrite-summary.md`](docs/rewrite-summary.md) for the rewrite record and known follow-up items.

**Vex is not just a chatbot.** It's a general agent framework where **Persona defines identity**, tools provide capabilities, and a unified Dispatcher routes every message — regardless of channel — through the same pipeline.

---

## Design

Vex is built on three pillars:

| Pillar | Role |
|--------|------|
| **Persona** | The agent's identity. Who it is, how it behaves, what it remembers. The system prompt starts here. |
| **Tools** | What the agent can do. File I/O, bash, browser, web search, memory — 13 built-in tools plus plugins. |
| **Channels** | Where messages come from and go to. WeChat, WebChat, CLI. Pure I/O, no business logic. |

```
Message → Dispatcher → Agent { Persona + Tools + Memory + Skills } → Outbound
                           ↑
                     EffectiveConfig(user, channel)
                           ↑
              YAML (system) + SQLite (user override)
```

Every message takes the same path. Every agent has a Persona. No shortcuts, no divergence.

---

## Features

- **Persona-first architecture** — identity, reply style, emotion, profile building, memory directives are core components, not afterthought extensions
- **Multi-channel** — personal WeChat (iLink OC API long-polling), WebChat (WebSocket SPA), CLI
- **Multi-user** — each user gets their own Agent, Persona state, Memory, Sessions, and WeChat account; zero cross-user state leakage
- **Chinese model coverage** — DeepSeek, MiniMax, Kimi (Moonshot), Doubao (ByteDance), Zhipu, LongCat, StepFun, ModelScope, DashScope, plus custom OpenAI/Anthropic-compatible providers and Western backends (OpenAI, Ollama, OpenRouter, Together, Groq, Azure OpenAI, vLLM)
- **13 built-in tools** — file read/write, bash execution, web search/fetch, browser automation, memory management, cron, weather, image analysis, and system utilities
- **CJK-native memory** — TF-IDF long-term memory with bigram tokenization for Chinese, Japanese, and Korean
- **Skills injection** — SKILL.md system (YAML frontmatter + Markdown body) parsed and injected at runtime
- **3-tier plugin architecture** — bundled (`dist/`) → user-level (`~/.vex/`) → workspace (`./.vex/`) auto-discovery with lifecycle hooks
- **Cron scheduling** — `at`, `every`, and standard cron expressions; triggers agent turns on schedule
- **Playwright browser automation** — screenshots, form filling, web interaction via headless Chromium
- **Event hook system** — 8 event types with registration and unsubscribe support
- **Docker support** — published GHCR image, multi-stage build (`node:24-alpine`), non-root user (`vex:vex`, UID/GID 1001)
- **YAML + SQLite config** — system defaults in YAML, per-user overrides in SQLite, resolved at runtime

---

## Architecture

```mermaid
flowchart TD
    WX[WeChat<br/>iLink OC API] --> DP
    WC[WebChat<br/>WebSocket + SPA] --> DP
    CLI[CLI] --> DP

    DP[Dispatcher<br/>resolve user, channel, config] --> AR
    DP --> CF

    CF[Config Store<br/>YAML + SQLite<br/>→ EffectiveConfig] --> AR

    AR[Agent Registry<br/>getOrCreate] --> AG

    subgraph Agent
        PS[Persona<br/>identity · style · emotion<br/>profile · history · memory]
        TL[Tools<br/>13 built-in + plugins]
        SK[Skills<br/>SKILL.md injection]
        MM[Memory<br/>CJK-aware TF-IDF]
        PL[Pipeline<br/>intercept · observe]
    end

    AG --> LLM[LLM Providers<br/>pi-ai abstraction<br/>DeepSeek · Kimi · MiniMax · etc.]
    AG --> OB[Outbound<br/>unified delivery]
    OB --> WX
    OB --> WC
```

| Module | Location | Role |
|--------|----------|------|
| Dispatcher | `src/dispatcher/` | Single entry point: resolve (user, channel) → Agent |
| Agent | `src/agent/` | Core: Persona + Tools + Skills + Memory + Pipeline |
| Persona | `src/agent/persona/` | Identity, emotion, profile facts, memory directives — system prompt base |
| Tools | `src/tools/` | LLM-callable capabilities, scoped per Agent |
| Skills | `src/skills/` | SKILL.md parsing and prompt injection |
| Memory | `src/memory/` | CJK-aware TF-IDF long-term memory, per-user scoped |
| Pipeline | `src/agent/Pipeline.ts` | Per-Agent message interceptors and response observers |
| Channels | `src/channels/` | Protocol adapters (WeChat OC API, WebSocket), pure I/O |
| Outbound | `src/outbound/` | Cross-channel unified message delivery |
| Config | `src/config/` | YAML loading + Zod validation, merged with SQLite overrides |
| Providers | `src/providers/` | LLM model resolution, API key management |
| Cron | `src/cron/` | at/every/cron schedule dispatching |
| Plugins | `src/plugins/` | 3-tier auto-discovery + lifecycle management |
| Browser tool | `src/tools/builtin/browser.ts` | Playwright headless browser automation |
| Hooks | `src/hooks/` | Event hook system |
| Sessions | `src/sessions/` | JSONL session persistence, per-user scoped |
| Web UI | `src/web/` | Server-rendered WebChat + control panel + auth |

> See [Architecture Document](./docs/architecture.md) for detailed module contracts, data flow, and design decisions.

---

## Quick Start

### Install

```bash
npm install -g vex-bot
vex --version
```

### Configure

```bash
vex onboard
```

The interactive configuration wizard walks you through: model providers, channels (personal WeChat), agent parameters, server port, and persona settings.

Config is stored at `~/.vex/config.local.yaml`. Per-user overrides are stored in SQLite (`web_user_settings`) and managed via the Web control panel.

### Start

```bash
# Full startup (WebChat + WeChat)
vex start

# WebChat only
vex start --web-only
```

Open `http://localhost:PORT` for the WebChat interface. Health check: `GET /health`.

### Docker

```bash
docker compose up -d
```

Pulls `ghcr.io/counhopig/vex-bot:latest`, starts WebChat-only, persists state in `vex-data` volume. Mount `config.local.yaml` into `/app/config.local.yaml` for production.

---

## CLI Commands

| Command | Description |
|---------|-------------|
| `vex onboard` | Interactive configuration wizard |
| `vex start` | Start gateway (`--web-only` for WebChat only, `-p` for port) |
| `vex status` | Service status and health |
| `vex logs` | View logs (`-f` tail, `-n` lines, `--level` filter) |
| `vex chat` | Terminal chat test (`-m` model, `-p` provider) |
| `vex check` | Validate configuration |
| `vex models` | List configured models |
| `vex kill` | Stop running service |
| `vex restart` | Restart service |

---

## Configuration

`config.local.yaml`:

```yaml
# ── Persona (core: defines the agent's identity) ──
persona:
  persona_name: PandaBot
  persona_base_prompt: |
    你是一个友好、专业、乐于助人的 AI 助手。
    耐心细致，逻辑清晰，善于分析问题。
  persona_reply_style: |
    用自然流畅的中文回复，适度使用 emoji。
    简洁但不简略，详细但不啰嗦。
  emotion_enabled: true
  profile_building_enabled: true
  profile_building_trigger_turns: 5

# ── Model Providers ──
providers:
  deepseek:
    apiKey: sk-xxx
  minimax:
    apiKey: xxx
  longcat:
    apiKey: ak-xxx
  custom-openai:
    baseUrl: https://api.example.com/v1
    apiKey: sk-xxx
    models:
      - id: qwen2.5-72b
        name: Qwen 2.5 72B

# ── Channels ──
channels:
  weixin:
    enabled: true

# ── Agent ──
agent:
  defaultProvider: longcat
  defaultModel: LongCat-2.0
  temperature: 0.7
  maxTokens: 4096
  workingDirectory: /path/to/workspace

# ── Server ──
server:
  port: 3000
  host: 0.0.0.0

# ── Memory ──
memory:
  enabled: true
  embeddingProvider: deepseek

# ── Web Auth ──
webAuth:
  enabled: true
  database: ~/.vex/web-auth.sqlite

# ── Logging ──
logging:
  level: info
  pretty: true
```

**Config resolution**: System defaults → `config.local.yaml` → SQLite `web_user_settings` (user overrides). Per-user overrides are set via the Web control panel and stored in the database automatically.

---

## Project Structure

```
.
├── src/
│   ├── agent/           # Agent core: Persona, Tools, Skills, Memory, Pipeline
│   ├── dispatcher/      # Message routing: resolve (user, channel) → Agent
│   ├── channels/        # Protocol adapters: WeChat (iLink OC), WebChat (WebSocket)
│   ├── tools/           # Tool registration, validation, execution (13 built-in)
│   ├── memory/          # CJK-aware TF-IDF long-term memory, per-user
│   ├── skills/          # SKILL.md parsing and prompt injection
│   ├── providers/       # LLM model resolution (pi-ai wrapper)
│   ├── config/          # YAML config loading + Zod validation + SQLite merge
│   ├── outbound/        # Cross-channel unified message delivery
│   ├── cron/            # at/every/cron scheduling
│   ├── plugins/         # 3-tier plugin discovery (bundled/global/workspace)
│   ├── web/             # Server-rendered WebChat SPA + control panel + auth
│   ├── hooks/           # Event hook system (8 event types)
│   ├── sessions/        # JSONL session persistence
│   ├── cli/             # Commander.js CLI (9 subcommands)
│   ├── vendor/          # Vendored dependencies used directly by the runtime
│   └── utils/           # Logger, path helpers
├── skills/              # Built-in skills
├── tests/               # Vitest tests
├── docs/                # Documentation
├── docker-compose.yml
└── Dockerfile
```

---

## Development

```bash
npm install
npm run build

# Dev mode (TSX auto-restart)
npm run dev

# Tests (non-watch)
npm test

# Tests in watch mode
npm run test:watch

# Start Gateway directly (bypass CLI)
npm run start:gateway
```

### Conventions

- **Strict TypeScript**: `noUncheckedIndexedAccess`, `noImplicitReturns`, `noFallthroughCasesInSwitch` enabled
- **ESM only**: `"type": "module"`, NodeNext module resolution, `.js` extensions in imports
- **Zod validation**: config schemas are defined in `src/config/schema.ts`
- **Pino logging**: `getChildLogger("moduleName")` pattern for structured, namespaced loggers
- **Node >= 24**: minimum supported runtime

---

## Documentation

- [Architecture](./docs/architecture.md) — design philosophy, module contracts, data flow, migration path
- [User Manual](./docs/user-manual.md)
- [Developer Guide](./docs/developer-guide.md)
- [API Reference](./docs/api-reference.md)

## License

[Apache-2.0](./LICENSE)

---

**Repository**: [https://github.com/counhopig/vex-bot](https://github.com/counhopig/vex-bot)
