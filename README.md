# Vex

Lightweight AI Chatbot Framework for the Chinese AI Ecosystem

[![version](https://img.shields.io/badge/version-1.12.0-blue)](https://github.com/counhopig/vex-bot)
[![license](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

Vex is a TypeScript ESM chatbot framework built on `@mariozechner/pi-coding-agent` and `@mariozechner/pi-ai`. It connects to personal WeChat, runs in the browser via a server-rendered WebChat UI, and supports Chinese LLM providers alongside OpenAI/Anthropic-compatible APIs. Forked from [OpenMozi](https://github.com/oujingzhou/openmozi) (Apache 2.0), stripped to weixin-only, and rebranded as Vex.

---

## Features

- **Chinese model coverage** — DeepSeek, MiniMax, Kimi (Moonshot), Doubao (ByteDance), Zhipu, StepFun, ModelScope, DashScope, plus custom OpenAI/Anthropic-compatible providers and Western backends (OpenAI, Ollama, OpenRouter, Together, Groq, Azure OpenAI, vLLM)
- **Personal WeChat** — connects to personal WeChat accounts via the iLink OC API long-polling channel for sending/receiving messages and files
- **WebChat UI** — built-in WebSocket-driven browser chat interface, server-rendered with no frontend build step
- **3-tier plugin architecture** — bundled (`dist/`) → user-level (`~/.vex/`) → workspace (`./.vex/`) auto-discovery with lifecycle hooks
- **25+ built-in tools** — file read/write, bash execution, web search/scrape, browser automation, cron job management, memory access, sub-agent delegation, and system utilities
- **TF-IDF long-term memory** — automatic memory storage with TF-IDF retrieval injected into the agent context
- **Cron scheduling** — supports `at`, `every`, and standard cron expressions; triggers agent turns and system events on schedule
- **Playwright browser automation** — screenshots, form filling, and web interaction via headless Chromium
- **Skills injection** — SKILL.md system (YAML frontmatter + Markdown body) parsed and injected into the agent system prompt at runtime
- **Event hook system** — 12 event types with `on`/`once`/`off` registration for extending agent behavior
- **Docker support** — multi-stage build (`node:20-alpine`), non-root user (`vex:vex`, UID/GID 1001), `docker-compose.yml` included
- **JSON5 config** — configuration files support comments and trailing commas; environment variable overrides take highest priority

## Architecture

```mermaid
flowchart TD
    WX[WeChat<br/>iLink OC API] --> GW
    WC[WebChat<br/>WebSocket + SPA] --> GW

    GW[Gateway<br/>Express + WebSocket] --> AG

    AG[Agent<br/>processMessage / processMessageStream<br/>wraps pi-coding-agent AgentRuntime] --> TO
    AG --> SK
    AG --> ME
    AG --> CR
    AG --> OB

    subgraph Subsystems
        TO[Tools<br/>25+ built-in]
        SK[Skills<br/>SKILL.md injection]
        ME[Memory<br/>TF-IDF]
        CR[Cron<br/>at / every / cron]
        OB[Outbound<br/>message delivery]
    end

    AG --> PR[LLM Providers<br/>DeepSeek · Kimi · MiniMax<br/>Doubao · Zhipu · StepFun · etc.<br/>pi-ai abstraction]
```

| Subsystem | Location | Role |
|-----------|----------|------|
| Tools | `src/tools/` | Tool registration, validation, and execution engine |
| Skills | `src/skills/` | SKILL.md YAML+Markdown parsing and injection |
| Memory | `src/memory/` | TF-IDF vectorized long-term memory |
| Cron | `src/cron/` | at/every/cron schedule dispatching |
| Outbound | `src/outbound/` | Cross-channel unified message delivery |
| Plugins | `src/plugins/` | 3-tier auto-discovery + lifecycle management |
| Browser | `src/browser/` | Playwright headless browser automation |
| Hooks | `src/hooks/` | 12 event type hook system |
| Sessions | `src/sessions/` | JSONL session persistence |

## Quick Start

### Install

```bash
npm install
npm run build
```

### Configure

```bash
vex onboard
```

The interactive configuration wizard walks you through: model providers (Chinese models, custom OpenAI/Anthropic endpoints), communication channels (personal WeChat), agent parameters (default model, temperature, max tokens), server port, and memory settings.

The config file is stored at `~/.vex/config.local.json5` in JSON5 format (supports comments and trailing commas).

### Start

```bash
# Full startup (WebChat + WeChat channel)
vex start

# WebChat only (no channel configuration required)
vex start --web-only
```

Once running, open `http://localhost:PORT` in a browser to access the WebChat interface. Health check: `GET /health`.

## CLI Commands

| Command | Description |
|---------|-------------|
| `vex onboard` | Interactive configuration wizard (models, channels, server, agent, memory) |
| `vex start` | Start the Gateway service (`--web-only` for WebChat only, `-p` to set port) |
| `vex status` | Check service status and health |
| `vex logs` | View logs (`-f` to tail, `-n` for line count, `--level` for severity filter) |
| `vex chat` | Terminal chat test (`-m` for model, `-p` for provider) |
| `vex check` | Validate configuration completeness |
| `vex models` | List configured available models |
| `vex kill` | Stop the running Vex service |
| `vex restart` | Restart the service |

## Configuration

`config.local.json5` structure:

```json5
{
  providers: {
    // Chinese models
    deepseek: { apiKey: "sk-xxx" },
    kimi: { apiKey: "sk-xxx" },
    minimax: { apiKey: "xxx" },
    // Custom OpenAI-compatible endpoint
    "custom-openai": { baseUrl: "https://api.example.com/v1", apiKey: "sk-xxx", models: [...] },
    // Custom Anthropic-compatible endpoint
    "custom-anthropic": { baseUrl: "...", apiKey: "...", models: [...] }
  },
  channels: {
    weixin: { /* iLink OC API configuration */ }
  },
  agent: {
    defaultProvider: "deepseek",
    defaultModel: "deepseek-chat",
    temperature: 0.7,
    maxTokens: 4096,
    workingDirectory: "/path/to/workspace"
  },
  server: {
    port: 3000,
    host: "0.0.0.0"
  },
  logging: {
    level: "info"
  },
  memory: {
    enabled: true,
    embeddingProvider: "deepseek"
  }
}
```

Config loading priority: environment variables > `config.local.json5` > defaults.

## Project Structure

```
.
├── src/
│   ├── agents/          # Agent orchestration + session management (pi-coding-agent wrapper)
│   ├── gateway/         # Express HTTP/WS server, route dispatch
│   ├── channels/        # Platform adapters: personal WeChat (iLink OC API)
│   ├── tools/           # Tool registration, validation, execution engine (25 built-in tools)
│   ├── skills/          # SKILL.md injection system (YAML frontmatter + Markdown)
│   ├── plugins/         # 3-tier plugin auto-discovery (bundled/global/workspace)
│   ├── memory/          # TF-IDF long-term memory with embedding
│   ├── cron/            # Scheduling: at/every/cron expressions
│   ├── outbound/        # Cross-channel unified message delivery
│   ├── web/             # Server-rendered WebChat SPA (inline HTML/CSS/JS)
│   ├── sessions/        # Session persistence (memory/file, JSONL transcripts)
│   ├── browser/         # Playwright headless browser automation
│   ├── hooks/           # Event hook system (12 event types, on/once/off)
│   ├── providers/       # Model resolution layer (pi-ai wrapper)
│   ├── config/          # Config loading (JSON5/YAML/env, Zod validation)
│   ├── cli/             # Commander.js CLI (9 subcommands, onboard wizard)
│   ├── commands/        # Chat command framework
│   ├── types/           # Shared TypeScript types
│   └── utils/           # Logger, crypto helpers
├── skills/              # Built-in skills
├── tests/               # Vitest tests
├── docs/                # Documentation
├── docker-compose.yml
└── Dockerfile
```

## Development

```bash
# Development mode (TSX with auto-restart)
npm run dev

# Build
npm run build

# Run tests
npm test

# Start Gateway directly (bypass CLI)
npm run start:gateway
```

### Conventions

- **Strict TypeScript**: `noUncheckedIndexedAccess`, `noImplicitReturns`, `noFallthroughCasesInSwitch` enabled
- **ESM only**: `"type": "module"`, NodeNext module resolution, `.js` extensions in imports
- **Zod validation**: all config schemas defined as Zod objects in `src/config/index.ts`
- **Pino logging**: `getChildLogger("moduleName")` pattern for structured, namespaced loggers
- **Node >= 18**: minimum supported runtime

## Documentation

- [User Manual](./docs/user-manual.md)
- [Developer Guide](./docs/developer-guide.md)
- [API Reference](./docs/api-reference.md)

## License

[Apache-2.0](./LICENSE)

---

**Repository**: [https://github.com/counhopig/vex-bot](https://github.com/counhopig/vex-bot)
