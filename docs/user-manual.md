# Vex User Manual

## 1. Introduction

Vex is a lightweight AI chatbot framework built for personal use. It connects to your personal WeChat account, turning a large language model into your always-available assistant. It's CLI-driven with a built-in WebChat UI, and it supports all major Chinese LLM providers out of the box.

What you can do with Vex:

- Talk to DeepSeek, Kimi (Moonshot), MiniMax, Doubao (ByteDance), Zhipu AI, StepFun, Qwen (Alibaba ModelStudio / DashScope), and more
- Connect to custom OpenAI-compatible endpoints (Ollama, vLLM, OpenAI, Azure, etc.)
- Connect to custom Anthropic-compatible endpoints (Claude, Bedrock, etc.)
- Reply to WeChat messages automatically via the iLink OC API
- Chat through a browser-based WebChat UI over WebSocket
- Use long-term memory, scheduled tasks, browser automation, and plugins

Vex runs on `@mariozechner/pi-coding-agent` (the agent runtime) and `@mariozechner/pi-ai` (the LLM abstraction layer). It was forked from [OpenMozi](https://github.com/oujingzhou/openmozi), stripped down to WeChat-only, and rebranded.

In one sentence: install Vex, configure your model API keys, and your WeChat account gains an AI persona.

---

## 2. Installation

### 2.1 Prerequisites

- **Node.js >= 18**
- npm (ships with Node.js)

Check your versions:

```bash
node -v   # Should print v18.x or higher
npm -v
```

### 2.2 Install via npm (recommended)

```bash
npm install -g vex-bot
```

After installation, the `vex` command is available globally:

```bash
vex version
```

### 2.3 Install from source

```bash
git clone https://github.com/counhopig/vex-bot.git
cd vex
npm install
npm run build
```

When installed from source, run commands with `npx vex` or `node dist/cli/index.js`. For development, use `npm run dev` (auto-restart via tsx watch).

### 2.4 Docker

Vex ships with ready-to-use Docker Compose files. See [Section 9 - Docker Deployment](#9-docker-deployment) for details.

---

## 3. Initial Setup (`vex onboard`)

After installation, run the interactive setup wizard:

```bash
vex onboard
```

The wizard walks you through 5 steps.

### Step 1: Choose provider type

```
1. Chinese models (DeepSeek, Doubao, Zhipu AI, DashScope, Kimi, StepFun, MiniMax, ModelScope)
2. Custom OpenAI-compatible endpoint (OpenAI, vLLM, Ollama, etc.)
3. Custom Anthropic-compatible endpoint (Claude, Bedrock, etc.)
```

You can select multiple types with a comma, e.g. `1,2`.

**Option 1** asks for API keys for each Chinese provider in turn. Only fill in the ones you have registered for. Press Enter to skip any you don't need. The first provider you enter becomes the default.

**Option 2** prompts for the API endpoint URL, API key, and then lets you add models one by one. Each model can specify an ID, display name, context window size, max output tokens, and whether it supports vision.

**Option 3** works like Option 2 but adapts to the Anthropic message format.

### Step 2: Configure channels

```
Enable Personal WeChat? (y/n)
```

Type `y` to enable the WeChat channel. WeChat uses QR code login at startup, so no credentials are needed during configuration.

### Step 3: Configure server

```
Server port (default 3000):
```

Press Enter for the default port 3000, or type a custom one.

### Step 4: Configure agent

The wizard auto-detects the default model from Step 1 and asks whether you want to change it. You can override the default provider and model ID.

### Step 5: Configure memory

The memory system lets the agent remember information across sessions (user preferences, important facts, etc.). It defaults to enabled, stored in `~/.vex/memory/`. Press Enter to accept the defaults.

### Saving the configuration

At the end, the wizard prints the generated JSON5 configuration and asks for confirmation. Confirming writes it to `~/.vex/config.local.json5`.

```
Configuration complete!

Next steps:
   1. Check config: vex check
   2. Start service: vex start
   3. Test chat:     vex chat
```

---

## 4. Configuration File Reference

The configuration file lives at `~/.vex/config.local.json5` (or a `config.local.json5` in your current directory). It uses JSON5 format, so comments and trailing commas are fine.

**Load priority**: environment variables > `config.local.json5` > built-in defaults.

### Full configuration structure

```json5
{
  // === Model providers ===
  providers: {
    deepseek: {
      apiKey: "sk-xxxxxxxxxxxxxxxx",       // API key (required)
      // baseUrl and models use presets; typically no need to set manually
    },
    kimi: {
      apiKey: "sk-xxxxxxxxxxxxxxxx",
    },
    minimax: {
      apiKey: "xxxxxxxxxxxxxxxx",
      groupId: "xxxxxxxx",                 // MiniMax-specific: Group ID
    },
    // Custom OpenAI-compatible endpoint example
    "custom-openai": {
      id: "custom-openai",
      name: "My vLLM Service",
      baseUrl: "https://my-server.com/v1",
      apiKey: "sk-xxx",
      models: [
        { id: "qwen2.5-72b", name: "Qwen 2.5 72B", contextWindow: 32768, maxTokens: 4096 },
      ],
    },
  },

  // === Channels ===
  channels: {
    weixin: {
      enabled: true,                        // Enable WeChat
    },
  },

  // === Agent ===
  agent: {
    defaultProvider: "deepseek",           // Default model provider
    defaultModel: "deepseek-chat",         // Default model ID
    temperature: 0.7,                      // Generation temperature (0-2); lower = more deterministic
    maxTokens: 4096,                       // Maximum tokens per response
    workingDirectory: "/path/to/workspace", // Working directory for tool execution
  },

  // === Server ===
  server: {
    port: 3000,                            // HTTP / WebSocket port
    host: "0.0.0.0",                       // Listen address
  },

  // === Logging ===
  logging: {
    level: "info",                         // Log level: trace | debug | info | warn | error | fatal
  },

  // === Memory ===
  memory: {
    enabled: true,                         // Enable long-term memory
    directory: "/path/to/memory",          // Memory storage directory (default: ~/.vex/memory)
  },

  // === Sessions ===
  sessions: {
    directory: "/path/to/sessions",        // Session storage directory (default: ~/.vex/sessions)
  },

  // === Skills ===
  skills: {
    enabled: true,                         // Enable skill injection
    // disabled: ["skill-name"],           // Skills to disable
    // only: ["skill-name"],               // Limit to only these skills
  },
}
```

### Field reference

| Field | Description |
|---|---|
| `providers.<id>.apiKey` | API key for the provider |
| `providers.<id>.baseUrl` | Custom API endpoint (Chinese providers use presets; leave blank) |
| `channels.weixin.enabled` | `true` connects to WeChat on start; `false` or omitted enables only WebChat |
| `agent.defaultProvider` | Default provider for `vex chat` and WebChat |
| `agent.defaultModel` | Default model ID, e.g. `deepseek-chat`, `kimi-k2.5` |
| `agent.temperature` | 0 through 2; lower is more predictable, higher is more creative |
| `agent.maxTokens` | Cap on output tokens per reply |
| `agent.workingDirectory` | Working directory the agent uses for file operations |
| `server.port` | Port for HTTP / WebSocket, default 3000 |
| `server.host` | Listen address; `0.0.0.0` allows remote access |
| `logging.level` | Log verbosity; set to `debug` or `trace` when troubleshooting |
| `memory.enabled` | Whether the agent remembers cross-session information |
| `memory.directory` | Where memory files are stored |
| `sessions.directory` | Where session transcripts (JSONL format) are stored |
| `skills` | Controls SKILL.md injection; `disabled` and `only` take skill name arrays |

### Environment variable overrides

You can override configuration values through environment variables. They take highest priority and are especially useful in Docker or CI/CD environments.

**Provider API keys:**

```bash
export DEEPSEEK_API_KEY="sk-xxx"
export MINIMAX_API_KEY="xxx"
export MINIMAX_GROUP_ID="xxx"       # MiniMax only
export KIMI_API_KEY="sk-xxx"
export STEPFUN_API_KEY="xxx"
export MODELSCOPE_API_KEY="xxx"
export DASHSCOPE_API_KEY="sk-xxx"
export ZHIPU_API_KEY="xxx"
export OPENAI_API_KEY="sk-xxx"
export OPENROUTER_API_KEY="sk-xxx"
export TOGETHER_API_KEY="xxx"
export GROQ_API_KEY="xxx"
```

**Server and logging:**

```bash
export PORT=3000
export LOG_LEVEL=debug
```

**WeChat (iLink OC):**

```bash
export WEIXIN_OC_TOKEN="xxx"
export WEIXIN_OC_ACCOUNT_ID="xxx"
export WEIXIN_OC_BASE_URL="https://ilinkai.weixin.qq.com"
```

---

## 5. CLI Command Reference

All commands start with `vex`. Run `vex --help` to see the full list.

### `vex onboard` — Interactive configuration wizard

Guides you step by step through configuring providers, channels, server, agent, and memory. Saves to `~/.vex/config.local.json5`.

```bash
vex onboard
```

No additional options.

### `vex start` — Start the service

Starts the Express HTTP server, WebSocket endpoint, and configured channels.

```bash
# Full start (WebChat + WeChat channel)
vex start

# WebChat only (no WeChat connection)
vex start --web-only

# Custom port
vex start -p 8080

# Custom config file
vex start -c /path/to/config.local.json5

# Combined
vex start --web-only -p 8080
```

After starting, open `http://localhost:PORT` for the WebChat UI.

**Options:**

| Option | Description |
|---|---|
| `-c, --config <path>` | Path to configuration file |
| `-p, --port <port>` | Override server port |
| `--web-only` | Start WebChat only, skip channel connections |

### `vex check` — Validate configuration

Checks configuration completeness and correctness. Lists configured providers, channels, and agent parameters.

```bash
vex check

# With custom config path
vex check -c /path/to/config.local.json5
```

Example output:

```
Model providers:
   deepseek: Configured
   kimi: Configured
   zhipu: Not configured
   ...

Channels:
   WeChat: Configured

Agent:
   Default model: deepseek-chat
   ...

Configuration check passed!
```

### `vex models` — List available models

Shows all configured providers and their models.

```bash
vex models
```

Output is grouped by provider and includes model IDs, display names, and capability indicators (vision, reasoning).

### `vex chat` — Terminal chat test

Chat with an AI model directly in the terminal. This mode bypasses the full agent system (no tools, no memory retrieval) and is intended for quick connectivity testing.

```bash
# Use default model
vex chat

# Specify model
vex chat -m deepseek-chat

# Specify both provider and model
vex chat -p deepseek -m deepseek-reasoner
```

Type `exit` to quit the chat session.

**Options:**

| Option | Description |
|---|---|
| `-m, --model <model>` | Model ID |
| `-p, --provider <provider>` | Provider ID |

### `vex status` — View service status

Checks whether Vex is running, shows process info, CPU / memory usage, and health check status.

```bash
vex status
```

Example output:

```
Vex service status

Status: Running
Processes: 1

  PID: 12345
  CPU: 2.1%  Memory: 3.5%
  Uptime: 1:23:45
  Command: node dist/cli/index.js start...

Health check: OK
Service URL: http://localhost:3000
```

### `vex logs` — View logs

Displays Vex runtime logs. Logs are structured JSON (Pino format) stored in `~/.vex/logs/`, rotated daily as `vex-YYYY-MM-DD.log`.

```bash
# Show last 50 lines (default)
vex logs

# Show last 100 lines
vex logs -n 100

# Follow logs in real time
vex logs -f

# List all log files
vex logs --list

# Show logs for a specific date
vex logs --date 2026-06-25

# Filter by level (warn and above)
vex logs --level warn
```

**Options:**

| Option | Description |
|---|---|
| `-f, --follow` | Follow log output (like `tail -f`) |
| `-n, --lines <number>` | Show last N lines (default: 50) |
| `-l, --list` | List all available log files |
| `--date <date>` | Show logs for a specific date (format: YYYY-MM-DD) |
| `--level <level>` | Filter by severity (debug, info, warn, error) |

### `vex kill` — Stop the service

Stops the running Vex process.

```bash
vex kill

# Alias
vex stop
```

### `vex restart` — Restart the service

Stops the current service, then starts a new one.

```bash
# Restart with current config
vex restart

# Restart with custom config and port
vex restart -c new-config.json5 -p 8080

# Restart in web-only mode
vex restart --web-only
```

### `vex version` — Show version

```bash
vex version
```

---

## 6. WebChat Usage

After running `vex start`, open a browser and go to `http://localhost:PORT` (default `http://localhost:3000`).

### Interface overview

Vex WebChat contains two server-rendered single-page applications:

**Main chat (`/`)**
- Shows the current model name at the top
- Central chat area with streaming response output (typewriter effect)
- Input box and send button at the bottom
- Action buttons: clear session, switch model

**Control panel (`/control`)**
- View Vex service status
- Edit your `config.local.json5` file online
- Manage WeChat QR code login
- Restart the service

### Basic operations

1. **Send a message**: type in the input box, press Enter or click Send.
2. **Clear session**: click the "Clear Session" button to reset the conversation context.
3. **Streaming responses**: AI replies appear character by character; no need to wait for full generation.
4. **Session isolation**: each WeChat contact and the WebChat UI each have their own independent agent session.

### WeChat QR login

If you enabled the WeChat channel, the control panel displays a WeChat login QR code. The QR code also appears in the terminal when you start Vex.

1. Open WeChat on your phone, use "Scan" to scan the QR code.
2. Confirm login. Vex is now connected.
3. When contacts send you WeChat messages, Vex processes and replies automatically.

### Health check

A health check endpoint is available at `GET /health`, returning:

```json
{"status":"ok","timestamp":"2026-06-25T12:00:00.000Z"}
```

---

## 7. Personal WeChat Setup

### Prerequisites

- **iLink OC API account**: Vex connects to personal WeChat via the iLink OC API long-polling mechanism. You need a valid API account.
- Your WeChat account must be in good standing.

### Enabling the WeChat channel

In `~/.vex/config.local.json5`:

```json5
{
  channels: {
    weixin: {
      enabled: true,
    },
  },
}
```

You can also enable it during `vex onboard` by answering `y` at the channel prompt.

### QR code login flow

1. Run `vex start` (without `--web-only`).
2. A login QR code appears in the terminal and in the WebChat control panel.
3. Scan the QR code with your phone's WeChat app.
4. After confirming, Vex enters listening mode.
5. When a contact sends you a WeChat message, Vex processes and replies automatically.

### Message flow

```
Contact sends WeChat message
    → iLink OC API delivers it to Vex
    → Agent processes (tools, memory retrieval, model inference)
    → Vex generates a reply
    → Reply sent back through iLink OC API as a WeChat message
```

### Session isolation

Conversations with different WeChat contacts are fully isolated. Your chat with Contact A won't leak into your chat with Contact B. Each contact gets an independent agent session.

WebChat is also a separate session, never sharing context with any WeChat contact.

### Important notes

- The WeChat channel uses long-polling (not WebSocket), so expect 1-3 seconds of message latency.
- To use both WebChat and WeChat simultaneously, run `vex start` without `--web-only`.
- If the WeChat connection drops, restart Vex and re-scan the QR code.
- Consider using a spare WeChat account rather than your primary one.

---

## 8. Model Provider Configuration

### Built-in Chinese providers

Vex ships with preset configurations for these Chinese providers. You only need to supply the API key:

| Provider | Config Key | Default Model | Env Variable |
|---|---|---|---|
| DeepSeek | `deepseek` | `deepseek-chat` | `DEEPSEEK_API_KEY` |
| Kimi (Moonshot) | `kimi` | `kimi-k2.5` | `KIMI_API_KEY` |
| MiniMax | `minimax` | `MiniMax-M2.1` | `MINIMAX_API_KEY` |
| Doubao (ByteDance) | `doubao` | `doubao-seed-1-8-251228` | config file only |
| Zhipu AI | `zhipu` | `glm-z1-flash` | `ZHIPU_API_KEY` |
| DashScope (Alibaba) | `dashscope` | `qwen3-235b-a22b` | `DASHSCOPE_API_KEY` |
| StepFun | `stepfun` | `step-2-mini` | `STEPFUN_API_KEY` |
| ModelScope (Alibaba) | `modelscope` | `Qwen/Qwen2.5-72B-Instruct` | `MODELSCOPE_API_KEY` |

Refer to each provider's official platform for API key registration.

### Configuration via config file

```json5
{
  providers: {
    deepseek: { apiKey: "sk-xxx" },
    kimi: { apiKey: "sk-xxx" },
    minimax: { apiKey: "xxx", groupId: "xxx" },
  },
}
```

### Configuration via environment variables

```bash
export DEEPSEEK_API_KEY="sk-xxxxxxxxxxxxxxxx"
export MINIMAX_API_KEY="xxxxxxxxxxxxxxxx"
export KIMI_API_KEY="sk-xxxxxxxxxxxxxxxx"
export STEPFUN_API_KEY="xxxxxxxxxxxxxxxx"
export ZHIPU_API_KEY="xxxxxxxxxxxxxxxx"
export DASHSCOPE_API_KEY="sk-xxxxxxxxxxxxxxxx"
export MODELSCOPE_API_KEY="xxxxxxxxxxxxxxxx"
```

### Custom OpenAI-compatible endpoints

Use this for vLLM, Ollama, OpenAI, Azure, or any service with an OpenAI-compatible API:

```json5
{
  providers: {
    "custom-openai": {
      id: "custom-openai",
      name: "My Local Service",
      baseUrl: "http://localhost:11434/v1",
      apiKey: "ollama",
      models: [
        { id: "qwen2.5:72b", name: "Qwen2.5 72B", contextWindow: 32768, maxTokens: 4096 },
      ],
    },
  },
}
```

### Custom Anthropic-compatible endpoints

Use this for Claude, Bedrock, or services with Anthropic-compatible APIs:

```json5
{
  providers: {
    "custom-anthropic": {
      id: "custom-anthropic",
      name: "Bedrock Claude",
      baseUrl: "https://bedrock.example.com/v1",
      apiKey: "xxx",
      apiVersion: "2023-06-01",
      models: [
        { id: "claude-3-5-sonnet-20241022", name: "Claude 3.5 Sonnet", contextWindow: 200000, maxTokens: 8192 },
      ],
    },
  },
}
```

### Switching the default model

Edit the `agent` section in your config:

```json5
{
  agent: {
    defaultProvider: "kimi",
    defaultModel: "kimi-k2.5",
  },
}
```

Restart Vex for the change to take effect. You can also test a new model temporarily with `vex chat -p kimi -m kimi-k2.5`.

---

## 9. Docker Deployment

### Option 1: Default Compose (web-only mode)

```bash
docker-compose up -d
```

This uses `docker-compose.yml` and starts in `--web-only` mode (WebChat only, no WeChat). Good for quick testing or web-interface-only use.

Port mapping:
- Host `3000` → Container `3000`

Resource limits:
- CPU: 1 core max
- Memory: 512 MB max

### Option 2: Environment-variable Compose (full config mode)

```bash
docker-compose -f docker-compose.env.yml up -d
```

This uses `docker-compose.env.yml`, which supports `.env` files and config file mounting. Suitable for production or when you need the WeChat channel.

Before starting:

1. Create a `.env` file in the project directory with your API keys:
   ```
   DEEPSEEK_API_KEY=sk-xxx
   KIMI_API_KEY=sk-xxx
   PORT=3000
   LOG_LEVEL=info
   ```
2. Create a `config.local.json5` file in the project directory.
3. Adjust the compose file's `command` field if needed (default is the image's entrypoint).

The `.env.yml` compose file mounts your local config:

```yaml
volumes:
  - ./config.local.json5:/app/config.local.json5:ro
```

### Docker details

- **Non-root user**: the container runs as `vex:vex` (UID/GID 1001).
- **Persistent data**: the `vex-data` named volume persists logs, memory, sessions, and cron job data at `/home/vex/.vex/`.
- **Health check**: `GET /health` is checked every 30 seconds; returns `{"status":"ok","timestamp":"..."}`.

### Enabling WeChat in Docker

1. Change the compose file's `command` to `["start"]` (remove `--web-only`).
2. Make sure `channels.weixin.enabled` is `true` in your `config.local.json5`.
3. Start the container and check the logs for the QR code: `docker logs vex-bot`.
4. Scan the QR code with your phone.

### Common Docker commands

```bash
# Check running status
docker-compose ps

# View logs
docker-compose logs -f

# Restart
docker-compose restart

# Stop and remove
docker-compose down
```

---

## 10. Logging and Debugging

### Log output

Vex uses Pino for logging. Logs are structured JSON output to stdout and to log files under `~/.vex/logs/`.

Log files rotate daily and are named `vex-YYYY-MM-DD.log`.

### Log levels

From most verbose to least:

| Level | Description | Typical use |
|---|---|---|
| `trace` | Maximum detail | Full function call chains |
| `debug` | Debug information | Variable values, intermediate states |
| `info` | Normal events | Service startup, connection established |
| `warn` | Warnings | Recoverable issues, degraded performance |
| `error` | Errors | Problems needing attention (may not stop service) |
| `fatal` | Critical | Severe errors requiring immediate action |

Set the level in your config:

```json5
{
  logging: {
    level: "debug",   // Use debug or trace when troubleshooting
  },
}
```

Or via environment variable:

```bash
export LOG_LEVEL=debug
```

### Viewing logs

```bash
# Recent logs
vex logs

# Follow in real time
vex logs -f

# Errors only
vex logs --level error

# List all log files
vex logs --list
```

### Session files

Session transcripts are stored as JSONL files (one JSON object per line) under `~/.vex/sessions/`. Each contact or channel gets its own session file.

You can inspect them with a text editor or command-line tools:

```bash
cat ~/.vex/sessions/*.jsonl | tail -20
```

### Common debugging scenarios

**Service won't start:**

```bash
# Check configuration first
vex check

# Start with debug logging
LOG_LEVEL=debug vex start
```

**Model not responding:**

```bash
# Test connectivity with vex chat
vex chat -p deepseek -m deepseek-chat
```

**WeChat connection issues:**

```bash
# Check WeChat-related logs
vex logs --level debug

# If errors appear, restart and re-scan
vex restart
```

**Port already in use:**

```bash
# Start on a different port
vex start -p 3001
```

---

## 11. FAQ

### Q: The WeChat QR scan didn't work. What should I check?

- Verify your iLink OC API account is active (not expired or restricted).
- Check network connectivity to the iLink OC API servers.
- Confirm `channels.weixin.enabled` is `true` in your config.
- Try restarting Vex to get a fresh QR code: `vex restart`.

### Q: How do I switch AI models?

Edit `~/.vex/config.local.json5` and update the `agent` section:

```json5
{
  agent: {
    defaultProvider: "kimi",
    defaultModel: "kimi-k2.5",
  },
}
```

Restart Vex. You can also test a model first with `vex chat -p kimi -m kimi-k2.5`.

### Q: How do I reset a conversation (clear context)?

- **WebChat**: click the "Clear Session" button in the UI.
- **WeChat contact**: clear the session in the WebChat control panel, or delete the corresponding JSONL file under `~/.vex/sessions/`.
- **Full reset**: stop Vex, delete the session files, and restart.

### Q: Where is config.local.json5?

Vex searches in this order:

1. The path you pass with `-c` (e.g. `vex start -c /path/to/config.json5`).
2. `config.local.json5` in the current working directory.
3. `~/.vex/config.local.json5` (this is where `vex onboard` writes it).

Run `vex check` to see which config file is actually loaded.

### Q: How do I mount a config file in Docker?

Use `docker-compose.env.yml`:

```bash
# 1. Copy your config into the project directory
cp ~/.vex/config.local.json5 ./config.local.json5

# 2. Create .env file (optional)
echo "DEEPSEEK_API_KEY=sk-xxx" > .env

# 3. Start
docker-compose -f docker-compose.env.yml up -d
```

The Docker environment variable names use the short form (`DEEPSEEK_API_KEY`, `KIMI_API_KEY`, etc.), matching the code's `loadConfigFromEnv` function.

### Q: Which models are supported? How do I add a new one?

Run `vex models` to see all currently configured models.

To add more:
- **Chinese providers**: add a `providers.<key>` entry with `apiKey`. Model lists are preset.
- **Custom endpoints**: add a `custom-openai` or `custom-anthropic` provider with `baseUrl`, `apiKey`, and a `models` array.

### Q: How much memory does Vex use?

- Runtime memory is typically under 200 MB (model inference runs in the cloud).
- Docker Compose defaults cap at 512 MB.
- Vex does not run large models locally; the main resource usage is Node.js runtime and Playwright (if you use browser automation tools).

### Q: Can I use multiple models at the same time?

Yes. Configure API keys for multiple providers and switch between them in WebChat or via the CLI. Each agent session uses one fixed model; different sessions can use different models.

### Q: Can I access the WebChat UI remotely?

Yes. `vex start` binds to `0.0.0.0` by default. Other devices on your LAN can connect via your machine's IP (e.g. `http://192.168.1.x:3000`). Use this only on trusted networks, or place a reverse proxy (Nginx, Caddy) in front with HTTPS.

### Q: My `doubao` API key isn't being picked up from the environment. Why?

The Doubao (ByteDance) provider is configured through the config file only. Unlike other Chinese providers, there is no `DOUBAO_API_KEY` environment variable in the current `loadConfigFromEnv` implementation. Use the configuration file or `vex onboard` to provide your Doubao API key instead.

---

## Appendix

- **Repository**: [https://github.com/counhopig/vex-bot](https://github.com/counhopig/vex-bot)
- **License**: Apache 2.0
- **Forked from**: [OpenMozi](https://github.com/oujingzhou/openmozi)
