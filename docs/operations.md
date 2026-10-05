# Deployment and operations

## Requirements

Node.js 24 or later, or Docker. Speech to text for videos (optional) needs `ffmpeg` and, for YouTube, `yt-dlp` on the `PATH`. Building from source needs C/C++ build tools when no prebuilt `better-sqlite3` binary exists for the platform.

## From source

```bash
git clone git@github.com:counhopig/vex-bot.git
cd vex-bot
npm ci
npm run build
node dist/cli/index.js onboard      # model, API key, port, optional WeChat link
node dist/cli/index.js start -d
```

`vex start` without a configuration, run in a terminal, starts the same guided setup.

| Command | Description |
|---|---|
| `vex onboard [--force]` | Create configuration and workspace templates |
| `vex start` / `vex start -d` | Run in the foreground / in the background |
| `vex stop` | Stop the background daemon |
| `vex status` | Show whether it is running and where |
| `vex logs [-f]` | Show or follow `logs/vexd.log` |
| `vex wechat login` | Link WeChat by QR code; a running daemon connects within seconds |

WebChat is at `http://127.0.0.1:7860` unless configured otherwise.

## Docker

Images are published for `linux/amd64` and `linux/arm64`:

- `ghcr.io/counhopig/vex-bot`
- `<DOCKERHUB_USERNAME>/vex-bot` on Docker Hub, when the repository secrets are set

Tags: `latest` and `sha-<commit>` on every push to `main`; `X.Y.Z` and `X.Y` on release tags.

```bash
# compose.yaml from the repository root
docker-compose run --rm vex onboard    # asks for model and API key; prints the WebChat token
docker-compose up -d
docker-compose logs -f
```

The commands use the standalone `docker-compose` binary; with the Compose plugin, `docker compose` takes the same arguments.

Without compose:

```bash
docker run -it --name vex -p 127.0.0.1:7860:7860 -v vex-data:/data ghcr.io/counhopig/vex-bot
# first run: guided setup, then vexd runs in the foreground; stop it, then
docker start vex
```

Container details:

- Data is in the volume mounted at `/data` (`VEX_HOME`). The process runs as the unprivileged `node` user.
- The image sets `VEX_WEB_HOST=0.0.0.0` and `VEX_LOG_STDOUT=1`. `compose.yaml` publishes the port on the loopback interface only; put a TLS reverse proxy in front for remote access.
- Set `TZ` (the compose file uses `Asia/Shanghai`): cron schedules, rest hours and heartbeat hours follow it.
- The image includes `ffmpeg` and `yt-dlp` (for the `link-reader` skill's speech to text); a new image carries the current `yt-dlp`, which YouTube support needs to stay up to date with.
- `compose.searxng.yaml` adds an optional SearXNG search container; see Web search in the configuration guide.
- A health check requests the WebChat port every 30 seconds.
- Update: `docker-compose pull && docker-compose up -d`. Build locally: `docker build -t vex-bot .` and point `image` at it.
- Back up the volume, for example `docker run --rm -v vex-data:/data -v "$PWD":/backup busybox tar czf /backup/vex-data.tgz -C /data .`

## Linking WeChat

1. Either answer yes to the question in `vex onboard`, or start `vexd` while WeChat is unlinked: it prints a QR code to its output (`vex logs -f`, `docker-compose logs -f`). `vex wechat login` prints one in the terminal; in Docker run `docker-compose run --rm vex wechat login`.
2. Scan it with the WeChat account that should own Vex. That account becomes the owner unless `wechat.ownerId` is set. Messages from anyone else are ignored.

A QR code expires after a few minutes and is refreshed up to three times. When the session expires later, vexd shows a new QR code; scanning it reconnects without a restart. Set `wechat.enabled: false` to disable the channel.

WeChat commands: `/stop` interrupts the current reply; `/y`, `/ya` and `/n` answer the oldest pending approval.

## Data directory

```text
<data dir>/                     ~/.vex, or $VEX_HOME, or /data in Docker
├── config.yaml                 0600
├── workspace/                  SOUL.md, USER.md, MEMORY.md, HEARTBEAT.md, memory/, skills/
├── sessions/
│   ├── wechat.jsonl
│   ├── web/<id>.jsonl
│   └── runs/                   transcripts of running temporary sessions
├── index.sqlite                search index; rebuildable
├── schedules.json              scheduled messages
├── state/mood.json             mood values and outreach counters
├── wechat/                     credentials.json, state.json (0600); directory 0700
├── logs/vexd.log
└── vexd.pid
```

Transcripts, workspace, `config.yaml`, `schedules.json`, `state/` and `wechat/` are the data worth backing up; the index is rebuilt from them. Compaction never removes transcript content.

## Logs

`vex logs -f` (or `docker-compose logs -f`) follows `logs/vexd.log`, one JSON object per line. At the default level it records: startup with a configuration summary (models, WeChat, MCP servers, search provider, speech to text), each message received (source and length), each run's start and duration, every tool call (name and a shortened summary), replies (length and stop reason), approvals requested and answered, scheduled messages, heartbeat and consolidation runs, context compaction, MCP connections, WeChat traffic (lengths only), saved settings (keys only) and restarts, plus all warnings and errors. Message and reply text, API keys and cookies are never logged. Set `VEX_LOG_LEVEL=debug` for more detail.

## Approvals

When a tool needs approval, the request appears in WeChat and in every open WebChat window. Answer in either; the first answer wins and the other prompts clear. Unanswered requests are denied after ten minutes. Adjust defaults with `tools.policy`.

## Security checklist

- Keep `web.host` on loopback, or set `web.token` and terminate TLS in a reverse proxy.
- Keep `config.yaml` private; it holds API keys and the web token.
- Leave `bash` and MCP tools on `ask` unless you trust the prompts reaching Vex; `web_fetch` cannot reach private networks.
- Pass secrets to shell commands only through `bashEnvPassthrough`.

## Troubleshooting

| Symptom | Check |
|---|---|
| `vexd` does not start | `vex logs`; configuration errors name the failing key |
| Unknown model error | IDs are case-sensitive; the message lists valid IDs for built-in providers |
| WebChat asks for a token | `web.token` in `config.yaml`, or `VEX_WEB_TOKEN` |
| No WeChat replies | `vex logs -f`; the account must be the owner; the session may have expired and need a new QR scan |
| Port already in use | Change `web.port`, or stop the other instance (`vex status`) |
| Container restarts in a loop | No configuration in the volume: run `docker-compose run --rm vex onboard` |
| Search finds nothing after upgrade | The index rebuilds itself on first start; wait for the first run to end |
| Heartbeat never fires | `HEARTBEAT.md` must have content and the time must be inside `heartbeat.activeHours` |
| Image skill fails | Use a model that accepts images; from source run `npm run build` first |

## Development

```bash
npm run dev        # run from source
npm run lint       # tsc --noEmit
npm test           # Vitest
npm run build
```

Pushing to `main` runs lint and tests, then publishes the image. Pushing a tag such as `v3.0.0` publishes versioned image tags.
