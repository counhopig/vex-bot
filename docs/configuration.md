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

The settings page has seven tabs:

| Tab | What it edits |
|---|---|
| Model | Main model (provider, model, thinking level, API key, and for a custom provider its protocol and `baseUrl`) and the background model, which can simply follow the main one; optional Jev tool routing |
| WeChat | Whether WeChat is on, the owner account, and the live connection state |
| Voice & links | Speech to text, the Bilibili `SESSDATA`, web search, the notes vault |
| Routine | Heartbeat, daily memory consolidation, compaction threshold, rest hours and proactive chat |
| Persona & memory | Four pages: Persona (`SOUL.md`), About me (`USER.md`), Memory (`MEMORY.md`, plus the daily notes in `memory/`, newest first) and Heartbeat (`HEARTBEAT.md`) |
| Schedules | Every scheduled task with its rule, next run and target: pause or resume, edit, delete, or create one (repeating cron rule, fixed interval, or a single date and time) |
| Advanced | The whole `config.yaml`, for everything the forms do not cover (tool policy, MCP servers, the web token) |

The forms change only the fields you touch and keep the rest of the file, comments included. A value that fails validation is rejected with the failing key and nothing is written. API keys and cookies are never sent back to the browser: a saved secret shows as "Set; leave empty to keep it", typing replaces it, and "Clear the saved value" removes it. After saving, the change applies by itself (see Applying changes). Below the chat box a status line shows the model, the WeChat connection and the mood values; the sidebar button switches between light, dark and system themes.

## Applying changes

Saving in WebChat settings applies the change without a manual restart:

- `stt` and `links` settings are read by the skills on every run, so they apply instantly.
- Everything else (models, keys, WeChat, search, rest hours, tool policy, MCP servers, …) is applied by restarting vexd in place: it waits up to 30 seconds for running turns to finish, shuts down, and starts again as the same process (same pid, so Docker and `vex stop` keep working). The page shows "Saved; applying the settings" and reconnects within a few seconds. Conversations, memory, mood and the WeChat link are kept; unanswered approvals are cancelled.
- Before writing, vexd checks that the main and background models can be resolved and rejects the save otherwise. If a saved configuration still cannot start (for example a port that is already taken), vexd restores the previous `config.yaml` on the next start, keeps running, and the status line under the chat box says why.
- Where the platform cannot re-execute a process (Windows), the page says "Saved; takes effect after vexd restarts" instead.

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
| `persona.outreach.quietHours` | `3` | Hours without an owner message, and since the last proactive chat |
| `persona.outreach.dailyLimit` | `3` | Proactive conversations per day |
| `webSearch.provider` | none | `tavily`, `searxng` or `brave`; without it `web_search` reports that no service is configured |
| `webSearch.apiKey` | none | Key for `tavily` or `brave`; may come from `TAVILY_API_KEY` / `BRAVE_API_KEY` |
| `webSearch.baseUrl` | none | Address of your SearXNG, required for `searxng` |
| `stt.provider` | `openai` | `openai` for any service with the OpenAI transcription API, `mimo` for Xiaomi MiMo speech recognition |
| `stt.baseUrl`, `stt.model` | none | Speech-to-text service: the API root (for example `https://api.openai.com/v1`) and a model name. Both are required to enable it |
| `stt.apiKey` | none | Bearer token for the service; omit for a local service |
| `stt.language` | auto | Language hint such as `zh`; MiMo accepts `auto`, `zh` and `en` |
| `stt.chunkMinutes` | `10` | Length of each audio part sent to the service (1–30; at most 15 with MiMo); lower it for services with small upload limits |
| `stt.maxMinutes` | `90` | Longest video that will be transcribed (1–600) |
| `links.bilibili.sessdata` | none | Bilibili `SESSDATA` cookie; lets the `link-reader` skill fetch subtitles that need a login; the environment variable `BILIBILI_SESSDATA` also works (allow it through `bashEnvPassthrough`) |
| `vault.path` | none | Folder of Markdown notes (an Obsidian vault works) as vexd sees it; set either this or `vault.url` |
| `vault.url` | none | `http` or `https` address of a git repository holding the notes; vexd keeps one copy, shared with the wiki. The address must not contain credentials |
| `vault.branch` | default branch | Branch of the repository to follow; only with `vault.url` |
| `vault.username`, `vault.token` | none | Credentials for a private repository: the account name your host expects and an access token (read-only without the wiki, write access with it; some hosts accept any username); only with `vault.url` |
| `vault.wiki.enabled` | `false` | Compile a git-backed vault into `wiki/` and `raw/` pages and push the result; requires `vault.url` |
| `vault.wiki.every` | `6h` | Wiki ingest cadence: a duration such as `6h` or a cron expression |
| `vault.wiki.notify` | `true` | Send a WeChat notification after each wiki batch |
| `vault.wiki.maxNotesPerRun` | `20` | Notes compiled per model call; a run processes every pending note and makes one commit |
| `jev.enabled` | `false` | Use TypeSafe Jev for tool suggestions and tool-evidence checks in owner conversations |
| `jev.apiKey` | none | Official TypeSafe API key; `TYPESAFE_API_KEY` also works |
| `jev.model` | `jev-latest` | TypeSafe decision model |
| `jev.confidence` | `0.8` | Minimum routing confidence and unsupported-claim probability for intervention (0.5–1) |
| `jev.timeoutMs` | `5000` | Timeout per TypeSafe API request in milliseconds (100–30000) |
| `mcpServers.<name>` | none | Server names: letters, digits, hyphens, at most 32 characters |

Default tool policy: `read`, `grep`, `find`, `web_fetch`, `web_search`, `memory_search`, `vault_search`, `vault_read`, `feel`, `schedule`, `delegate`, `wiki_write`, `wiki_edit`, `wiki_ingest` and `wiki_rollback` are `allow`; `wiki_bootstrap`, `bash` and MCP tools are `ask`; `write` and `edit` are `allow` inside the workspace and `ask` outside.

## Models

Built-in providers (DeepSeek, Kimi, MiniMax, Zhipu, Qwen, Xiaomi, OpenRouter and the others in the installed pi-ai registry) are referenced by `provider` and `id`. Any OpenAI- or Anthropic-compatible endpoint is declared under `providers` with `api` and `baseUrl`. A model can see images only when it declares `input: [text, image]`; the built-in image skill requires such a model.

## Jev tool routing

Enable Jev under **Settings → Model → Tool routing (Jev)** and enter your TypeSafe API key. Save to apply the configuration. The key is stored with the other secrets and is never returned in the settings response.

Jev uses the [official TypeSafe evaluation API](https://docs.typesafe.ai/api). It receives the bounded request, available tool names and descriptions, execution evidence, and a proposed reply; configuration secrets are excluded. Jev classifies link intent and gives advisory tool suggestions. The runtime owns fixed link actions and submits them through the normal tool and approval path. When Jev is disabled, unavailable, or uncertain, Vex tries a bounded main-model JSON intent classification; if that remains uncertain, it reports the action as deferred. Local evidence checks remain active regardless of Jev. Receipts distinguish a successful read from archival, Wiki compilation, publication, pending publication, and bootstrap review; a model summary or child-agent narration is not execution evidence.

Final replies are buffered until tool-operation claims are checked against current-turn results. Low-confidence routes do not force a tool. Jev API errors log a warning; the runtime still reports fixed actions as deferred when their intent cannot be classified. Each check adds an API request, and a corrective model request may also be needed. Background tasks use profile-specific tools and prompts.

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

Edit these Markdown files to shape Vex; the next message sees the change. WebChat settings edits `config.yaml` (as forms or as text) and every file below marked editable; you can also ask Vex in conversation to change them, or edit them on disk.

| File | Purpose | Loaded |
|---|---|---|
| `SOUL.md` | Persona, tone, rules (200 lines) | Every turn |
| `USER.md` | What Vex knows about the owner (200 lines) | Every turn |
| `MEMORY.md` | Distilled long-term facts and decisions (100 lines) | Every turn |
| `HEARTBEAT.md` | Checklist for periodic checks, and the place for any instructions to the heartbeat; empty skips the model call | At each heartbeat |
| `memory/YYYY-MM-DD.md` | Daily notes written by the agent; editable in WebChat under Memory | Through `memory_search` |
| `skills/<name>/SKILL.md` | Custom skills | Name and description every turn, body on demand |

The line limits in brackets are how much of each file the model sees; when a save in WebChat goes over a limit, the page says so (the file is still saved). Templates for these files are created on first start.

The heartbeat's fixed one-line instruction tells the agent to read `HEARTBEAT.md` and to answer `HEARTBEAT_OK` when there is nothing to report, a reply vexd relies on, so put your own heartbeat instructions in `HEARTBEAT.md`. The operating instructions at the top of every system prompt (workspace layout, memory conventions, approval rules, replying in the owner's language), the instructions for memory consolidation and proactive chat, and the internal prompts for compaction, conversation titles, the mood phrasing and the link summaries are built in; shape Vex's personality and habits through `SOUL.md` instead.

## Skills

A skill is a directory with `SKILL.md` and optional scripts. Frontmatter requires `name` (lowercase letters, digits and hyphens, up to 64 characters) and `description` (up to 1024 characters). Built-in skills ship with Vex (`weather`, `image`, `link-reader`, `llm-wiki`); a workspace skill with the same name overrides a built-in one. Vex reads skill bodies and runs their scripts according to their runtime interface and the applicable tool policy. The Wiki compiler receives `llm-wiki` directly with its restricted tool set. Unreadable skills are skipped with a warning. See `docs/samples/skills/daily-brief/SKILL.md`.

The `image` skill uses the primary model unless its script receives `--provider` and `--model`; that model must accept image input. From a source checkout it needs `npm run build` first.

## Web search

`web_search` supports three services; pick one with `webSearch.provider` (or in the settings page, Voice & links tab):

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
docker-compose -f compose.yaml -f compose.searxng.yaml up -d
```

Then set `webSearch: { provider: searxng, baseUrl: "http://searxng:8080" }`; the name resolves because both containers share the Compose network. The container is not published on any port. Set `SEARXNG_SECRET` in `.env` to use your own secret key. A SearXNG you already run works too, as long as `json` is listed under `search.formats` in its `settings.yml`; otherwise it answers 403 and Vex says so. Results depend on the engines behind SearXNG and can be thinner when an engine rate-limits it.

## Speech to text

With the default `provider: openai`, `stt` points Vex at any service that implements the OpenAI transcription API (`POST <baseUrl>/audio/transcriptions` with `file` and `model`), such as OpenAI Whisper, Groq, SiliconFlow's SenseVoice, or a self-hosted faster-whisper server:

```yaml
stt:
  baseUrl: "https://api.openai.com/v1"
  model: whisper-1
  apiKey: "YOUR_API_KEY"
  language: zh
```

Xiaomi MiMo speech recognition takes Base64 audio through its chat completions API; set `provider: mimo`:

```yaml
stt:
  provider: mimo
  baseUrl: "https://api.xiaomimimo.com/v1"
  model: mimo-v2.5-asr
  apiKey: "YOUR_API_KEY"
  language: zh
```

The `link-reader` skill uses it for Bilibili and YouTube videos that have no subtitles. Transcribing needs `ffmpeg` on the `PATH`, and for YouTube also `yt-dlp` plus Node.js (the Docker image has all three; for a source install add `ffmpeg` and `yt-dlp`, and update `yt-dlp` when YouTube changes). A long video takes minutes (download, re-encoding, service time), so the agent runs the skill with the shell tool's longest timeout. Audio is sent to the configured service; choose one you trust with the content.

## Reading share links

Send Vex a link, or paste a whole share text, from Bilibili, YouTube, Douyin, Xiaohongshu or a WeChat public account article (`mp.weixin.qq.com`). Owner-facing reads use the programmatic bundled reader; shared links selected for archival are read by the runtime and saved under `raw/` before Wiki compilation. A manual run of the `link-reader` skill script uses `bash` and follows the `bash` approval policy. See the architecture guide for what each platform returns. Limits to know about:

- A Bilibili or YouTube video without subtitles is transcribed only when `stt` is set (see below); otherwise you get title, author, duration and description only. Douyin's work details need a login signature, so for Douyin only the pasted share text (author and caption, possibly cut) and the page's publish date and likes are available.
- Bilibili shows most subtitles only to logged-in users. Copy the `SESSDATA` cookie value of a logged-in browser session into `links.bilibili.sessdata`. It is sent only to `api.bilibili.com`; keep `config.yaml` private.
- Xiaohongshu may refuse pages without a login or a valid share token; paste the full share link rather than a bare note address.
- For WeChat articles, copy the article link and send it as text. Reading returns the title, account name and article body; verification pages, deleted articles and articles without a readable body return an error.
- Platforms change their pages and APIs. A failure is reported as an error, and other web pages still work through `web_fetch`. For manual skill-script runs, you can adjust the script in a workspace copy (`skills/link-reader/`), which overrides the bundled one. Automatic owner-facing reads use the bundled programmatic reader.

## Notes vault

Vex can read an Obsidian vault, or any folder of Markdown notes, as a personal knowledge base. Access is read-only: Vex never changes your notes. Set exactly one source, `vault.path` or `vault.url`.

**A folder** (`vault.path`). Vex reads the folder directly and never updates it, so keep it current yourself: Syncthing, `git pull` on a timer, rclone, or Obsidian itself on the same machine. In Docker, mount the folder into the container, read-only:

```yaml
# compose.yaml
services:
  vex:
    volumes:
      - vex-data:/data
      - /path/to/vault:/vault:ro
```

```yaml
# config.yaml
vault:
  path: /vault
```

**A git repository** (`vault.url`). Vex keeps exactly one copy. With the wiki disabled it is a read-only mirror in `<data dir>/vault/<hash>/`; with the wiki enabled it is the wiki's working clone in `<data dir>/wiki/<hash>/`, which the vault tools read too:

```yaml
vault:
  url: https://git.example.com/me/notes.git
  branch: main            # optional
  username: me            # optional; some hosts require one together with the token
  token: "READ_ONLY_TOKEN"   # not needed for a public repository
```

The first time a vault tool runs, Vex clones the repository; later, when you ask about your notes, it fetches again if the last update is more than a minute old. Without the wiki the copy is a mirror, so force pushes are fine. With the wiki, the shared clone only fast-forwards: it is not moved while a wiki run is queued or in progress, while a batch is in flight, or while a local bootstrap preview awaits review, and a rewritten remote history is reported instead of applied. Startup makes no network request. If an update fails, Vex keeps using the last copy and says so in the tool result. Only `http://` and `https://` addresses are supported; if you sync over SSH, use a folder instead. Over plain `http://` the token travels unencrypted, so use it only on a private network.

Create a read-only token for the repository: on GitHub a fine-grained token with *Contents: Read-only*, on GitLab a token with the `read_repository` scope, on Gitea one with *repository: Read*. The token reaches git through the environment, so it never appears in a command line, a log or the repository's configuration. Vex sends `vault.username` as the account name, or `git` when you leave it empty.

The agent gets two tools. `vault_search` takes `query` (keywords separated by spaces; matching is by case-insensitive substring and works for Chinese), `tag` (a parent tag also matches its children), `folder`, `since`, `before` and `limit` (default 10, maximum 30); without a query it lists notes by last change, newest first, which is how to review a period or browse a tag. `vault_read` returns one note with its tags, outgoing links and backlinks, truncated at 30,000 characters, understanding `[[wikilinks]]`, `[[note|alias]]`, `[[note#heading]]`, frontmatter `tags` and `aliases`, inline `#tags` and relative Markdown links. A note's date is its last git commit time for a git copy (or a folder that is itself a git repository) and its file modification time otherwise.

Files and folders whose names start with `.`, symlinks, non-Markdown files (`.md`, case-insensitive) and notes over 1 MB are ignored, and at most 20,000 notes are used. Searches read the notes on every call; in a measured run, a search over 1,000 notes took about 0.1 s, and over 5,000 notes about 0.46 s warm and about 1 s cold. Note text reaches your model provider like any other message, so only give Vex notes you are comfortable sharing with it.

Treat note text as untrusted input, not as instructions: a page you clipped into the vault can carry text aimed at the model. If the vault holds third-party content, set `tools.policy.web_fetch: ask` so a note cannot make Vex fetch an address silently, and set `tools.policy.write` and `tools.policy.edit` to `ask` too if you want the same for files.

## Notes wiki

With a git-backed vault (`vault.url`), set `vault.wiki.enabled: true` to have Vex compile your notes into a wiki inside the same repository. A scheduled ingest reads the notes that changed since the last run, writes synthesized pages under `wiki/` (and fetched material under `raw/`), updates `wiki/_index.md`, and commits and pushes the batch. When you ask a question, the agent reads `wiki/` first and cites the pages it used.

```yaml
vault:
  url: https://git.example.com/me/notes.git
  token: "WRITE_TOKEN"
  wiki:
    enabled: true
    every: 6h             # a duration, or a cron expression
    notify: true          # a WeChat message after each batch
    maxNotesPerRun: 20    # notes per model call; a run still makes a single commit
```

The first ingest is a preview: Vex commits it locally, tells you which pages it generated and withholds the push. Say "approve the Wiki preview" or "reject the Wiki preview"; Vex then calls `wiki_bootstrap`, and you confirm that call in the ordinary approval prompt (`/y` publishes, `/n` keeps the preview). After a restart Vex reminds you of a preview that is still waiting. The cadence stays paused until review. Afterwards, each batch is one commit. Ask Vex to roll back the last batch, and it reverts that commit (or discards it locally when it was never pushed). Completion messages list archived raw paths and compiled Wiki pages separately, then state whether publication completed or remains pending. A raw-only commit does not count as a compiled Wiki page.

With Wiki enabled, Vex writes only inside `wiki/` and `raw/`; every other note stays read-only, and general file writes are kept out of the whole vault. Its `vault.token` must have write access to the repository. With the wiki disabled, the mirror remains read-only and can use a read-only token. Owner-approved shell and MCP commands are outside this boundary, so treat note text as untrusted input.

## Scheduled messages

Ask Vex in conversation: "remind me at 18:00 every weekday to stretch". The `schedule` tool accepts a unique `name`, a `prompt`, a `target` (the current conversation by default) and one rule: `cron` expression, `every` interval such as `30m`, or `once` as an ISO timestamp with a time zone (it must be in the future). Tasks are stored in `schedules.json`; the Schedules tab in WebChat settings lists them and can pause, edit, delete or create them.
