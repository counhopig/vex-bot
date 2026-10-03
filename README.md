# Vex

Vex is a personal AI assistant for one owner. A single daemon, `vexd`, answers on personal WeChat and in a browser-based WebChat. Both windows share one workspace, long-term memory, tool set and approval queue; each keeps its own conversation history.

## Features

- **Two windows.** WeChat is one permanent conversation. WebChat has many, with streaming replies, interruption, automatic titles and history recovery.
- **Agent tools.** Files, shell, web fetch, Brave Search, memory search, isolated sub-agents, MCP servers (stdio and Streamable HTTP) and Skills, including bundled weather, image and share-link skills (Bilibili, YouTube, Douyin and Xiaohongshu links are read and summarised).
- **Approvals.** Shell commands, MCP tools and writes outside the workspace ask first, on WeChat or in WebChat, whichever answers first.
- **Memory.** Plain Markdown in the workspace, a full-text search index, context compaction with silent memory rescue, and a nightly consolidation pass.
- **Presence.** Scheduled messages, heartbeat checks, a mood and rest-hours model, and proactive conversations on WeChat.
- **Self-hosted.** One Node.js process or one container; all data stays in one directory.

## Quick start

### Docker

```bash
curl -O https://raw.githubusercontent.com/counhopig/vex-bot/main/compose.yaml
docker compose run --rm vex onboard    # model, API key, optional WeChat QR; prints the WebChat token
docker compose up -d
```

Open <http://127.0.0.1:7860> and sign in with the printed token. While WeChat is unlinked, `docker compose logs -f` shows a QR code to scan.

Images for `linux/amd64` and `linux/arm64`: `ghcr.io/counhopig/vex-bot`, and `<DOCKERHUB_USERNAME>/vex-bot` on Docker Hub when the repository secrets are set.

### From source

Requires Node.js 24 or later. Installation compiles `better-sqlite3` when no prebuilt binary exists, which needs C/C++ build tools.

```bash
git clone git@github.com:counhopig/vex-bot.git
cd vex-bot
npm ci
npm run build
node dist/cli/index.js onboard
node dist/cli/index.js start -d
```

`npm link` provides the `vex` command used below.

## Using Vex

| Command | Description |
|---|---|
| `vex onboard [--force]` | Guided setup: provider, model, API key, port, optional WeChat link |
| `vex start [-d]` | Run in the foreground or the background |
| `vex stop` / `vex status` | Stop the daemon / show its state |
| `vex logs [-f]` | Show or follow the log |
| `vex wechat login` | Link WeChat by QR code; a running daemon connects automatically |

WebChat is at <http://127.0.0.1:7860> by default. On WeChat only the owner's messages are answered; `/stop` interrupts a reply, and `/y`, `/ya` and `/n` answer the oldest pending approval.

Shape Vex by editing Markdown files in the workspace: `SOUL.md` (persona), `USER.md` (what it knows about you), `MEMORY.md` (long-term facts), `HEARTBEAT.md` (periodic checks). Ask it in conversation to schedule messages or write new Skills.

A minimal `~/.vex/config.yaml`:

```yaml
model:
  provider: minimax-cn
  id: MiniMax-M2.7
providers:
  minimax-cn:
    apiKey: "YOUR_API_KEY"
```

## Documentation

- [Architecture](docs/architecture.md): components, sessions, memory, mood, scheduler, security.
- [Configuration](docs/configuration.md): every setting, environment variables, workspace files, skills.
- [Deployment and operations](docs/operations.md): source and Docker deployment, WeChat linking, data directory, troubleshooting.
- [Samples](docs/samples/): minimal and full `config.yaml`, a heartbeat checklist, a skill.

## Development

```bash
npm run dev      # run from source
npm run lint     # type check
npm test         # Vitest; scripted models and local mock services, no credentials needed
npm run build
```

Pushing to `main` runs lint and tests and publishes the image; pushing a `v*` tag publishes versioned image tags.
