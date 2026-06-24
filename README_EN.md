<p align="center">
  <img src="./docs/images/mascot.svg" width="80" alt="Vex Mascot" />
</p>

<p align="center">
  <a href="./README.md">中文</a> | English
</p>

**An Intelligent Assistant Framework Supporting Chinese AI Models and Personal WeChat**

Vex is a lightweight AI assistant framework focused on the Chinese ecosystem. Built on [pi-coding-agent](https://github.com/nicemicro/pi-coding-agent) for the Agent runtime (with built-in session management, context compression, and tool execution), and [pi-ai](https://github.com/nicemicro/pi-ai) as the unified multi-model calling layer (supporting 25+ providers), it natively supports Function Calling and integrates with personal WeChat via the iLink OC API.

> Forked from [OpenMozi](https://github.com/King-Chau/mozi) (Apache 2.0), stripped to WeChat-only and rebranded as Vex.

## Core Features

- **Multi-Model Support** — Built on pi-ai unified calling layer, supporting DeepSeek, Doubao, DashScope (Qwen), Zhipu AI, Kimi, StepFun, MiniMax, plus OpenAI/Anthropic/OpenRouter/Groq and 25+ providers
- **Personal WeChat Channel** — Via iLink OC API, QR code login, long-polling for messages
- **Function Calling** — Based on pi-coding-agent runtime, native support for tool calling loops
- **25 Built-in Tools** — File read/write, Bash execution, code search, web fetch, image analysis, browser automation, memory system, scheduled tasks, etc.
- **Skills System** — Extend Agent capabilities through SKILL.md files, supporting custom behaviors and domain knowledge injection
- **Memory System** — Cross-session long-term memory, automatically remembers user preferences and important information
- **Scheduled Tasks (Cron)** — Supports one-time, periodic, and Cron expression scheduling
- **Plugin System** — Extensible plugin architecture with auto-discovery and loading
- **Browser Automation** — Playwright-based browser control with multi-profile and screenshot support
- **Session Management** — Context compression, session persistence, multi-turn conversations
- **WebChat** — Built-in web chat interface and control console

## Quick Start

### Requirements

- Node.js >= 18
- npm / pnpm / yarn
- **Cross-platform Support**: macOS, Linux, Windows

### 1. Installation

```bash
# Global installation (recommended)
npm install -g vex-bot

# Or clone for development
git clone https://github.com/King-Chau/vex.git
cd vex && npm install && npm run build
```

### 2. Configuration

Run the configuration wizard (recommended):

```bash
vex onboard
```

The wizard will guide you through:
- **Chinese Models** — DeepSeek, Doubao, Zhipu AI, DashScope, Kimi, StepFun, MiniMax, ModelScope
- **Custom OpenAI-Compatible Interface** — Supports any OpenAI API format service (e.g., vLLM, Ollama)
- **Custom Anthropic-Compatible Interface** — Supports any Claude API format service
- **Personal WeChat** — Enable and scan QR code on first launch
- **Memory System** — Enable/disable long-term memory, custom storage directory

Configuration will be saved to `~/.vex/config.local.json5`.

You can also use environment variables (for quick testing):

```bash
export DEEPSEEK_API_KEY=sk-your-key
```

### 3. Start

```bash
# WebChat only (no communication channel needed)
vex start --web-only

# Full service (WebChat + Personal WeChat)
vex start

# If cloned from repository
npm start -- start --web-only
```

Open your browser and visit `http://localhost:3000` to start chatting.

## Supported Model Providers

> Built on [pi-ai](https://github.com/nicemicro/pi-ai), supporting 25+ model providers. Below are pre-configured providers. You can also connect any OpenAI/Anthropic compatible service via custom interfaces.

### Chinese Models

| Provider | Environment Variable | Description |
|----------|---------------------|-------------|
| DeepSeek | `DEEPSEEK_API_KEY` | Strong reasoning, cost-effective |
| Doubao | `DOUBAO_API_KEY` | ByteDance Volcano Engine, Seed deep thinking series, 256k context |
| DashScope | `DASHSCOPE_API_KEY` | Alibaba Cloud Bailian, Qwen commercial version, stable high concurrency |
| Zhipu AI | `ZHIPU_API_KEY` | GLM-Z1/GLM-4/GLM-5 series, Tsinghua tech team, free tier available |
| ModelScope | `MODELSCOPE_API_KEY` | Alibaba ModelScope community, Qwen open source, free tier available |
| Kimi | `KIMI_API_KEY` | Kimi K2.5/Moonshot series, long context support |
| StepFun | `STEPFUN_API_KEY` | Step-2/Step-1 series, reasoning and multimodal |
| MiniMax | `MINIMAX_API_KEY` | MiniMax M2.5/M2.1/M3 series, strong reasoning |

### International Models

| Provider | Environment Variable | Description |
|----------|---------------------|-------------|
| OpenAI | `OPENAI_API_KEY` | GPT-4o, o1, o3 series |
| Anthropic | `ANTHROPIC_API_KEY` | Claude 4 series (via pi-ai built-in support) |
| OpenRouter | `OPENROUTER_API_KEY` | Multi-model aggregation, unified API |
| Together AI | `TOGETHER_API_KEY` | Open source model hosting, Llama, Mixtral, etc. |
| Groq | `GROQ_API_KEY` | Ultra-fast inference speed |
| Google | `GOOGLE_API_KEY` | Gemini series (via pi-ai built-in support) |

### Local Deployment

| Provider | Environment Variable | Description |
|----------|---------------------|-------------|
| Ollama | `OLLAMA_BASE_URL` | Run open source models locally |
| vLLM | `VLLM_BASE_URL` | High-performance local inference server |

## Personal WeChat Integration

Based on the iLink OC API (`https://ilinkai.weixin.qq.com`), personal WeChat is connected via QR code login:

1. Enable WeChat channel in config (`vex onboard` or manually set `channels.weixin.enabled: true`)
2. Start the service with `vex start`
3. A QR code appears in the terminal or WebUI console
4. Scan with your phone's WeChat to confirm login
5. The `bot_token` is saved automatically and reused on next startup

The WebUI console (`http://localhost:3000/control`) also provides a QR code login button.

## Configuration Reference

<details>
<summary>Complete Configuration Example</summary>

```json5
{
  providers: {
    deepseek: {
      apiKey: "sk-xxx"
    },
    dashscope: {
      apiKey: "sk-xxx"
    },
    zhipu: {
      apiKey: "xxx"
    }
  },

  channels: {
    weixin: {
      enabled: true,
      baseUrl: "https://ilinkai.weixin.qq.com",
      botType: "3"
    }
  },

  agent: {
    defaultProvider: "deepseek",
    defaultModel: "deepseek-chat",
    temperature: 0.7,
    maxTokens: 4096,
    systemPrompt: "You are Vex, an intelligent assistant."
  },

  server: {
    port: 3000,
    host: "0.0.0.0"
  },

  logging: {
    level: "info"
  },

  skills: {
    enabled: true,
    userDir: "~/.vex/skills",
    workspaceDir: "./.vex/skills"
  },

  memory: {
    enabled: true,
    storageDir: "~/.vex/memory"
  }
}
```

</details>

## CLI Commands

```bash
# Configuration
vex onboard            # Configuration wizard
vex check              # Check configuration
vex models             # List available models

# Start service
vex start              # Full service (WebChat + Personal WeChat)
vex start --web-only   # WebChat only
vex start --port 8080  # Specify port

# Service management
vex status             # View service status
vex restart            # Restart service
vex kill               # Stop service (alias: vex stop)

# Chat
vex chat               # Command line chat

# Logs
vex logs               # View latest logs (default 50 lines)
vex logs -n 100        # View latest 100 lines
vex logs -f            # Follow logs in real-time
vex logs --level error # Show only error logs
```

## Project Structure

```
src/
├── agents/        # Agent core (based on pi-coding-agent, message loop, session management)
├── channels/      # Channel adapters (Personal WeChat iLink OC API)
├── providers/     # Model resolution (based on pi-ai, maps config to unified Model objects)
├── tools/         # Built-in tools (file, Bash, network, scheduled tasks, etc.)
├── skills/        # Skills system (SKILL.md loading, registration)
├── sessions/      # Session storage (memory, file)
├── memory/        # Memory system
├── cron/          # Scheduled task system (scheduling, storage, executor)
├── outbound/      # Proactive message delivery (unified outbound interface)
├── plugins/       # Plugin system (discovery, loading, registration)
├── browser/       # Browser automation (config, sessions, screenshots)
├── web/           # WebChat frontend + console
├── config/        # Configuration loading
├── gateway/       # HTTP/WebSocket gateway
├── cli/           # CLI tool
├── hooks/         # Hook event system
├── utils/         # Utility functions
└── types/         # TypeScript type definitions
```

## Docker Deployment

```bash
# Docker Compose (recommended)
docker compose up -d --build

# Direct Docker run
docker run -d -p 3000:3000 \
  -e DEEPSEEK_API_KEY=sk-xxx \
  -v vex-data:/home/vex/.vex \
  vex-bot:latest start --web-only
```

After startup, access:

| Service | URL |
|---------|-----|
| WebChat | http://localhost:3000/ |
| Console | http://localhost:3000/control |
| Health Check | http://localhost:3000/health |

## Development

```bash
npm run dev            # Development mode (auto-restart)
npm run build          # Build
npm test               # Test
```

## License

Apache 2.0
