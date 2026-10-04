# Configuration

Vex reads one file, `config.yaml`, from the data directory (`~/.vex`, or `$VEX_HOME`). Create it with `vex onboard`, edit it by hand, or use WebChat settings (below). Saving in WebChat applies the change automatically (see below); after editing the file by hand, restart vexd.

Samples (`docs/samples/`):

| File | Contents |
|---|---|
| `config.minimal.yaml` | The smallest working configuration |
| `config.full.yaml` | Every setting with defaults and examples |
| `HEARTBEAT.md` | A heartbeat checklist |
| `skills/daily-brief/SKILL.md` | A workspace skill |

## WebChat settings

The settings page has six tabs:

| Tab | What it edits |
|---|---|
| 模型 | Main model (provider, model, thinking level, API key, and for a custom provider its protocol and `baseUrl`) and the background model, which can simply follow the main one |
| 微信 | Whether WeChat is on, the owner account, and the live connection state |
| 语音与链接 | Speech to text, the Bilibili `SESSDATA`, web search |
| 作息 | Heartbeat, daily memory consolidation, compaction threshold, rest hours and proactive chat |
| 人设与记忆 | `SOUL.md`, `USER.md`, `MEMORY.md` and `HEARTBEAT.md` |
| 高级 | The whole `config.yaml`, for everything the forms do not cover (tool policy, MCP servers, the web token) |

The forms change only the fields you touch and keep the rest of the file, comments included. A value that fails validation is rejected with the failing key and nothing is written. API keys and cookies are never sent back to the browser: a saved secret shows as "已设置，留空保持不变", typing replaces it, and "清除已保存的值" removes it. After saving, the change applies by itself (see Applying changes). Below the chat box a status line shows the model, the WeChat connection and the mood values; the sidebar button switches between light, dark and system themes.

## Applying changes

Saving in WebChat settings applies the change without a manual restart:

- `stt` and `links` settings are read by the skills on every run, so they apply instantly.
- Everything else (models, keys, WeChat, search, rest hours, tool policy, MCP servers, …) is applied by restarting vexd in place: it waits up to 30 seconds for running turns to finish, shuts down, and starts again as the same process (same pid, so Docker and `vex stop` keep working). The page shows "正在应用设置" and reconnects within a few seconds. Conversations, memory, mood and the WeChat link are kept; unanswered approvals are cancelled.
- Before writing, vexd checks that the main and background models can be resolved and rejects the save otherwise. If a saved configuration still cannot start (for example a port that is already taken), vexd restores the previous `config.yaml` on the next start, keeps running, and the status line under the chat box says why.
- Where the platform cannot re-execute a process (Windows), the page says "重启 vexd 后生效" instead.

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
| `webSearch.provider` | none | `tavily`, `searxng` or `brave`; without it `web_search` reports that no service is configured |
| `webSearch.apiKey` | none | Key for `tavily` or `brave`; may come from `TAVILY_API_KEY` / `BRAVE_API_KEY` |
| `webSearch.baseUrl` | none | Address of your SearXNG, required for `searxng` |
| `stt.baseUrl`, `stt.model` | none | Speech-to-text service: an OpenAI-compatible API root (for example `https://api.openai.com/v1`) and a model name. Both are required to enable it |
| `stt.apiKey` | none | Bearer token for the service; omit for a local service |
| `stt.language` | auto | Language hint such as `zh` |
| `stt.chunkMinutes` | `10` | Length of each audio part sent to the service (1–30); lower it for services with small upload limits |
| `stt.maxMinutes` | `90` | Longest video that will be transcribed (1–600) |
| `links.bilibili.sessdata` | none | Bilibili `SESSDATA` cookie; lets the `link-reader` skill fetch subtitles that need a login; the environment variable `BILIBILI_SESSDATA` also works (allow it through `bashEnvPassthrough`) |
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
| `VEX_LOG_LEVEL` | `trace`, `debug`, `info` (default), `warn`, `error`. `debug` adds ignored WeChat traffic, finished tool calls and disconnects |
| `VEX_LOG_STDOUT` | `1` also writes logs to standard output (set in the Docker image) |
| `TAVILY_API_KEY`, `BRAVE_API_KEY` | Search key when `webSearch.apiKey` is absent |
| Provider variables such as `DEEPSEEK_API_KEY` | API key when `providers.<name>.apiKey` is absent |

Vex does not load `.env` files. Inside the shell tool, `VEX_CONFIG_PATH` points to the active configuration for skill scripts.

## Workspace files

Edit these Markdown files to shape Vex; the next message sees the change. WebChat settings edits `config.yaml` (as forms or as text) and these four files; you can also ask Vex in conversation to change them, or edit them on disk.

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

A skill is a directory with `SKILL.md` and optional scripts. Frontmatter requires `name` (lowercase letters, digits and hyphens, up to 64 characters) and `description` (up to 1024 characters). Built-in skills ship with Vex (`weather`, `image`, `link-reader`); a workspace skill with the same name overrides a built-in one. Vex reads the body with `read` and runs scripts with `bash`, which follows the approval policy. Unreadable skills are skipped with a warning. See `docs/samples/skills/daily-brief/SKILL.md`.

The `image` skill uses the primary model unless its script receives `--provider` and `--model`; that model must accept image input. From a source checkout it needs `npm run build` first.

## Web search

`web_search` supports three services; pick one with `webSearch.provider` (or in the settings page, 语音与链接 tab):

| Service | Cost | Needs |
|---|---|---|
| `tavily` | 1000 searches a month free, no card | An account key from tavily.com |
| `searxng` | Free, no limit | A SearXNG you run yourself |
| `brave` | Paid since February 2026 ($5 of credit a month, card required) | An API key |

```yaml
webSearch:
  provider: tavily
  apiKey: "tvly-..."
```

For SearXNG, the repository ships `compose.searxng.yaml`, which adds a ready-to-use container whose settings enable the JSON format Vex needs:

```bash
docker compose -f compose.yaml -f compose.searxng.yaml up -d
```

Then set `webSearch: { provider: searxng, baseUrl: "http://searxng:8080" }`; the name resolves because both containers share the Compose network. The container is not published on any port. Set `SEARXNG_SECRET` in `.env` to use your own secret key. A SearXNG you already run works too, as long as `json` is listed under `search.formats` in its `settings.yml`; otherwise it answers 403 and Vex says so. Results depend on the engines behind SearXNG and can be thinner when an engine rate-limits it.

## Speech to text

`stt` points Vex at any service that implements the OpenAI transcription API (`POST <baseUrl>/audio/transcriptions` with `file` and `model`), such as OpenAI Whisper, Groq, SiliconFlow's SenseVoice, or a self-hosted faster-whisper server:

```yaml
stt:
  baseUrl: "https://api.openai.com/v1"
  model: whisper-1
  apiKey: "YOUR_API_KEY"
  language: zh
```

The `link-reader` skill uses it for Bilibili and YouTube videos that have no subtitles. Transcribing needs `ffmpeg` on the `PATH`, and for YouTube also `yt-dlp` plus Node.js (the Docker image has all three; for a source install add `ffmpeg` and `yt-dlp`, and update `yt-dlp` when YouTube changes). A long video takes minutes (download, re-encoding, service time), so the agent runs the skill with the shell tool's longest timeout. Audio is sent to the configured service; choose one you trust with the content.

## Reading share links

Send Vex a link, or paste a whole share text, from Bilibili, YouTube, Douyin or Xiaohongshu, and it runs the bundled `link-reader` skill. Because skill scripts run through `bash`, each read follows the `bash` approval policy (`/ya` allows it for the rest of a conversation). See the architecture guide for what each platform returns. Limits to know about:

- A Bilibili or YouTube video without subtitles is transcribed only when `stt` is set (see below); otherwise you get title, author, duration and description only. Douyin's work details need a login signature, so for Douyin only the pasted share text (author and caption, possibly cut) and the page's publish date and likes are available.
- Bilibili shows most subtitles only to logged-in users. Copy the `SESSDATA` cookie value of a logged-in browser session into `links.bilibili.sessdata`. It is sent only to `api.bilibili.com`; keep `config.yaml` private.
- Xiaohongshu may refuse pages without a login or a valid share token; paste the full share link rather than a bare note address.
- Platforms change their pages and APIs. A failure is reported as an error, and other web pages still work through `web_fetch`. Because the skill is a script, you can adjust it in a workspace copy (`skills/link-reader/`), which overrides the bundled one.

## Scheduled messages

Ask Vex in conversation: "remind me at 18:00 every weekday to stretch". The `schedule` tool accepts a unique `name`, a `prompt`, a `target` (the current conversation by default) and one rule: `cron` expression, `every` interval such as `30m`, or `once` as an ISO timestamp with a time zone (it must be in the future). Tasks are stored in `schedules.json`.
