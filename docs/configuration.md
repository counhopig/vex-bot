# Configuration

Vex reads one file, `config.yaml`, from the data directory (`~/.vex`, or `$VEX_HOME`). Create it with `vex onboard`, edit it by hand, or edit it in WebChat settings (choose `config.yaml` in the file selector). Changes take effect after a restart. Invalid files are rejected with the path of the failing key.

Samples (`docs/samples/`):

| File | Contents |
|---|---|
| `config.minimal.yaml` | The smallest working configuration |
| `config.full.yaml` | Every setting with defaults and examples |
| `HEARTBEAT.md` | A heartbeat checklist |
| `skills/daily-brief/SKILL.md` | A workspace skill |

## Settings

| Key | Default | Description |
|---|---|---|
| `model.provider`, `model.id` | required | Primary model. IDs are case-sensitive; an unknown ID fails and lists the valid ones |
| `model.thinking` | provider default | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `backgroundModel` | same as `model` | Titles, compaction summaries, heartbeat, consolidation, sub-agents in background runs |
| `providers.<name>.apiKey` | — | Falls back to the provider's environment variable |
| `providers.<name>.api` | — | `openai-completions` or `anthropic-messages`; required for custom providers |
| `providers.<name>.baseUrl` | — | Endpoint of a custom provider |
| `providers.<name>.models[]` | any id | `id`, `contextWindow`, `maxTokens`, `reasoning`, `input` (`[text]` or `[text, image]`). When present, only listed ids are accepted |
| `web.host` | `127.0.0.1` | A non-loopback host requires `web.token` |
| `web.port` | `7860` | |
| `web.token` | none | Access token for WebChat |
| `workspace` | `<data dir>/workspace` | Agent working directory |
| `wechat.enabled` | `true` | Set `false` to turn WeChat off |
| `wechat.ownerId` | the account that scanned the QR code | The only WeChat account Vex answers |
| `wechat.baseUrl` | `https://ilinkai.weixin.qq.com` | iLink API endpoint |
| `tools.policy.<tool>` | see below | `allow`, `ask` or `deny`; an MCP server name (`mcp__<server>`) covers its tools |
| `bashEnvPassthrough` | `[]` | Extra environment variables visible to shell commands |
| `compaction.threshold` | `0.7` | Share of the context window that triggers compaction (0–1) |
| `memory.consolidateAt` | `03:00` | Daily consolidation time, `HH:mm` |
| `heartbeat.every` | `30m` | Interval, a positive integer plus `s`, `m`, `h` or `d` |
| `heartbeat.activeHours` | `["08:00", "22:00"]` | Heartbeat window |
| `persona.sleep` | `["23:00", "07:00"]` | Rest hours; may cross midnight |
| `persona.outreach.enabled` | `true` | Proactive conversations |
| `persona.outreach.checkEvery` | `30m` | Same duration format as `heartbeat.every` |
| `persona.outreach.socialThreshold` | `70` | 0–100 |
| `persona.outreach.quietHours` | `3` | Hours without an owner message |
| `persona.outreach.dailyLimit` | `3` | Proactive conversations per day |
| `webSearch.provider`, `webSearch.apiKey` | none | `brave`; the key may come from `BRAVE_API_KEY` |
| `mcpServers.<name>` | none | Server names: letters, digits, hyphens, at most 32 characters |

Default tool policy: `read`, `grep`, `find`, `web_fetch`, `web_search`, `memory_search`, `feel`, `schedule` and `delegate` are `allow`; `write` and `edit` are `allow` inside the workspace and `ask` outside; `bash` and MCP tools are `ask`.

## Models

Built-in providers (DeepSeek, Kimi, MiniMax, Zhipu, Qwen, Xiaomi, OpenRouter and the others in the installed pi-ai registry) are referenced by `provider` and `id`. Any OpenAI- or Anthropic-compatible endpoint is declared under `providers` with `api` and `baseUrl`. A model can see images only when it declares `input: [text, image]`; the built-in image skill requires such a model.

## MCP servers

```yaml
mcpServers:
  local:                       # stdio
    command: node
    args: ["/absolute/path/to/server.js"]
    env: { KEY: value }
    cwd: /absolute/path
  remote:                      # Streamable HTTP
    url: "https://example.com/mcp"
    headers: { Authorization: "Bearer TOKEN" }
```

Tools appear as `mcp__<server>__<tool>`, sanitised to `[A-Za-z0-9_-]` and at most 64 characters. stdio servers receive a minimal environment; pass what they need through `env`.

## Environment variables

| Variable | Effect |
|---|---|
| `VEX_HOME` | Data directory (default `~/.vex`). Use the same value for every command that addresses an instance |
| `VEX_WEB_HOST` | Overrides `web.host`; when it is not a loopback address, `vex onboard` skips the port question and generates an access token |
| `VEX_WEB_TOKEN` | Overrides `web.token` |
| `VEX_LOG_STDOUT` | `1` also writes logs to standard output (set in the Docker image) |
| `BRAVE_API_KEY` | Brave Search key when `webSearch.apiKey` is absent |
| Provider variables such as `DEEPSEEK_API_KEY` | API key when `providers.<name>.apiKey` is absent |

Vex does not load `.env` files. Inside the shell tool, `VEX_CONFIG_PATH` points to the active configuration for skill scripts.

## Workspace files

Edit these Markdown files to shape Vex; the next message sees the change. WebChat settings edits `config.yaml`, `SOUL.md`, `USER.md`, `MEMORY.md` and `HEARTBEAT.md` through a file selector; you can also ask Vex in conversation to change them, or edit them on disk.

| File | Purpose | Loaded |
|---|---|---|
| `SOUL.md` | Persona, tone, rules (200 lines) | Every turn |
| `USER.md` | What Vex knows about the owner (200 lines) | Every turn |
| `MEMORY.md` | Distilled long-term facts and decisions (100 lines) | Every turn |
| `HEARTBEAT.md` | Checklist for periodic checks; empty skips the model call | At each heartbeat |
| `memory/YYYY-MM-DD.md` | Daily notes written by the agent | Through `memory_search` |
| `skills/<name>/SKILL.md` | Custom skills | Name and description every turn, body on demand |

Templates for the first four are created on first start.

## Skills

A skill is a directory with `SKILL.md` and optional scripts. Frontmatter requires `name` (lowercase letters, digits and hyphens, up to 64 characters) and `description` (up to 1024 characters). Built-in skills ship with Vex (`weather`, `image`); a workspace skill with the same name overrides a built-in one. Vex reads the body with `read` and runs scripts with `bash`, which follows the approval policy. Unreadable skills are skipped with a warning. See `docs/samples/skills/daily-brief/SKILL.md`.

The `image` skill uses the primary model unless its script receives `--provider` and `--model`; that model must accept image input. From a source checkout it needs `npm run build` first.

## Scheduled messages

Ask Vex in conversation: "remind me at 18:00 every weekday to stretch". The `schedule` tool accepts a unique `name`, a `prompt`, a `target` (the current conversation by default) and one rule: `cron` expression, `every` interval such as `30m`, or `once` as an ISO timestamp with a time zone (it must be in the future). Tasks are stored in `schedules.json`.
