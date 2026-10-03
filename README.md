# Vex

Vex is a personal AI assistant for a single owner. Its persistent daemon, `vexd`, connects to WeChat ClawBot and a browser-based WebChat. Both interfaces share a workspace, long-term memory, tool approvals, and mood state while keeping separate conversation histories.

## Features

- Multiple WebChat conversations with streaming responses, steering, interruption, automatic titles, and history recovery.
- QR-code WeChat linking, owner filtering, approval commands, and progress notices for long-running turns.
- File operations, shell commands, web fetching, Brave Search, and SQLite FTS5 memory search.
- Context compaction, silent memory rescue, daily notes, and scheduled memory consolidation.
- Scheduled messages, heartbeat checks, mood and sleep patterns, and proactive conversations.
- MCP integrations, isolated subagents, dynamic Skills, and built-in weather and image-analysis skills.

## Installation

Requires Node.js 24 or later. If a prebuilt `better-sqlite3` binary is unavailable, installation requires native C/C++ build tools.

```bash
git clone git@github.com:counhopig/vex-bot.git
cd vex-bot
npm ci
npm run build
node dist/cli/index.js onboard
node dist/cli/index.js start -d
```

The onboarding wizard asks for a provider, model, API key, and web port. It can also link WeChat by QR code. WebChat defaults to `http://127.0.0.1:7860`.

Optionally run `npm link` to use `vex` instead of `node dist/cli/index.js`.

## Commands

| Command | Description |
|---|---|
| `vex onboard [--force]` | Create configuration and workspace templates; `--force` overwrites existing configuration |
| `vex start` | Run in the foreground |
| `vex start -d` | Run in the background |
| `vex stop` | Stop the daemon |
| `vex status` | Show running status |
| `vex logs [-f]` | Show logs; `-f` follows new output |
| `vex wechat login` | Link WeChat by QR code; restart to apply |

WeChat commands:

- `/stop`: interrupt the current response.
- `/y`: allow the oldest pending approval.
- `/ya`: always allow that tool in the requesting conversation.
- `/n`: deny the oldest pending approval.

Approvals appear in WeChat and connected WebChat windows. The first answer wins; unanswered requests are denied after ten minutes.

## Configuration

Configuration lives in `~/.vex/config.yaml`. It can also be edited from WebChat settings. Restart after changes.

Minimal configuration:

```yaml
model:
  provider: minimax-cn
  id: MiniMax-M2.7
providers:
  minimax-cn:
    apiKey: "YOUR_API_KEY"
```

Built-in providers and models depend on the installed pi-ai registry. Model IDs are case-sensitive. API keys are read from `providers` first, then from the provider's supported environment variables. Vex does not automatically load `.env` files.

Optional settings to combine with the minimal configuration:

```yaml
web:
  host: 127.0.0.1
  port: 7860
wechat:
  enabled: true
  # ownerId defaults to the account that scanned the QR code.
compaction:
  threshold: 0.7
memory:
  consolidateAt: "03:00"
heartbeat:
  every: 30m
  activeHours: ["08:00", "22:00"]
persona:
  sleep: ["23:00", "07:00"]
  outreach:
    enabled: true
    checkEvery: 30m
    socialThreshold: 70
    quietHours: 3
    dailyLimit: 3
tools:
  policy:
    bash: ask
    mcp__browser: ask
bashEnvPassthrough: []
webSearch:
  provider: brave
  apiKey: "YOUR_BRAVE_SEARCH_API_KEY"
mcpServers:
  local:
    command: node
    args: ["/absolute/path/to/mcp-server.js"]
  remote:
    url: "https://example.com/mcp"
```

Configure `backgroundModel` with the same fields as `model` to select a separate model for titles, compaction summaries, heartbeats, and memory consolidation. It defaults to the primary model.

Custom provider configuration:

```yaml
model:
  provider: custom
  id: your-model
providers:
  custom:
    api: openai-completions
    baseUrl: "https://example.com/v1"
    apiKey: "YOUR_API_KEY"
    models:
      - id: your-model
        contextWindow: 32000
        maxTokens: 4096
```

Custom providers support `openai-completions` and `anthropic-messages`. When `models` is specified, only listed IDs are accepted.

Remote access requires `web.token`. Tool policies are `allow`, `ask`, and `deny`. By default, writes inside the workspace are allowed; external writes, shell commands, and MCP tools require approval. Shell commands inherit only an environment allowlist. Add specific variables to `bashEnvPassthrough` when needed.

## Workspace and Data

The default data directory is `~/.vex`. Set `VEX_HOME` to run an isolated instance:

```bash
export VEX_HOME=/absolute/path/to/vex-data
node dist/cli/index.js onboard
node dist/cli/index.js start -d
```

Use the same `VEX_HOME` for all commands addressing that instance. The `workspace` setting can independently select its working directory.

```text
~/.vex/
├── config.yaml
├── workspace/
│   ├── SOUL.md              # Persona and behavior
│   ├── USER.md              # Stable information about the owner
│   ├── MEMORY.md            # Long-term facts and decisions
│   ├── HEARTBEAT.md         # Checklist; empty files skip model calls
│   ├── memory/YYYY-MM-DD.md # Daily notes
│   └── skills/              # Custom skills
├── sessions/               # WeChat, WebChat, and background transcripts
├── index.sqlite            # Rebuildable search index
├── schedules.json          # Scheduled tasks
├── state/mood.json         # Mood and outreach state
├── wechat/                 # Login credentials and synchronization state
└── logs/vexd.log
```

Edit workspace Markdown files to adjust personality, owner information, memory, and heartbeat checks. Changes are read on the next turn. Compaction changes the model context while preserving original conversation records.

## Scheduling and Skills

Ask Vex to create, list, or delete scheduled tasks. The `schedule` tool supports cron expressions, fixed intervals such as `30m`, and one-time ISO timestamps with a time zone. Tasks target the current conversation by default. Deleted WebChat targets fall back to WeChat, and missed one-time tasks are reported after startup.

A Skill is a directory containing `SKILL.md` with `name` and `description` frontmatter, plus optional scripts and resources. Workspace skills override built-in skills with the same name. The weather skill retrieves forecasts; the image skill analyzes images using a configured model that supports image input. Script execution follows shell approval rules.

`web_search` requires a Brave Search API key, configured directly or through `BRAVE_API_KEY`. MCP supports stdio and Streamable HTTP, exposing tools as `mcp__<server>__<tool>`. The `delegate` tool runs an isolated subagent with inherited approvals and prevents nested delegation.

## Development

```bash
npm run dev
npm run lint
npm test
npm run build
```

Tests use scripted models and local mock services, so no real model, WeChat, or MCP credentials are required. Design documents and implementation plans are in [docs/superpowers](docs/superpowers).
