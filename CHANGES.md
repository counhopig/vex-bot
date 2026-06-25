# Vex — Changes from OpenMozi

Vex was forked from [OpenMozi](https://github.com/oujingzhou/openmozi) (Apache 2.0) as a personal WeChat-specific version.

## 1. Full Project Rename

| Original | Changed To |
|----------|------------|
| `openmozi` / `mozi-bot` | `vex-bot` |
| `Mozi` | `Vex` |
| `mozi` CLI | `vex` CLI |
| `MOZI_` env var prefix | `VEX_` |
| `~/.mozi/` config directory | `~/.vex/` |

## 2. Removed Multi-Channel Support — WeChat Only

Removed channel modules and dependencies:

- `src/channels/feishu/` — Feishu (Lark)
- `src/channels/dingtalk/` — DingTalk
- `src/channels/qq/` — QQ
- `src/channels/wecom/` — WeCom (WeChat Work)

Removed npm dependencies:

- `@larksuiteoapi/node-sdk`
- `dingtalk-stream`
- `qq-guild-bot`
- `crypto-js`

Type simplifications:

- `ChannelId` narrowed from `"feishu" | "dingtalk" | "qq" | "wecom" | "weixin" | "webchat"` to `"weixin" | "webchat"`
- `MoziConfig.channels` now only holds `weixin?: WeixinConfig`
- Removed `FeishuConfig`, `DingtalkConfig`, `QQConfig`, `WeComConfig` types

## 3. New Personal WeChat Channel

Built on Tencent iLink OC API (`https://ilinkai.weixin.qq.com`), modeled after [AstrBot](https://github.com/Soulter/AstrBot)'s `weixin_oc` adapter.

New files:

```
src/channels/weixin/
├── client.ts    # iLink API HTTP client (QR fetch, polling, message send/receive)
├── login.ts     # QR code scan login flow
├── adapter.ts   # WeixinChannel adapter (long-polling, message handling)
└── index.ts     # Module barrel export
```

### QR Code Login Flow

1. Call `ilink/bot/get_bot_qrcode` to get QR code
2. Display QR link in terminal / WebUI
3. Scan with mobile WeChat to confirm login
4. Poll `ilink/bot/get_qrcode_status` until confirmed
5. Save `bot_token` to `config.local.json5`
6. Reuse token on next start

### Message Send/Receive

- Inbound: POST `ilink/bot/getupdates` long-polling
- Outbound: POST `ilink/bot/sendmessage` for replies
- Supports: text messages, image/video/file/voice placeholder extraction

## 4. WebUI QR Code Login

In the `/control` configuration page:

- Personal WeChat card: toggle, Bot Type, API Base URL
- "Scan QR Login" button → displays QR image directly in browser
- Polls QR status every 2 seconds → shows "Logged in ✓" on success
- New WebSocket methods: `weixin.qr`, `weixin.qr.status`

## 5. MiniMax M3 Support

- Fixed MiniMax baseUrl from `/v1/text/chatcompletion_v2` to `/v1`
- Added `MiniMax-M3` to preset model list (1M context / 65K tokens)

## 6. Fixes

- `thinkingLevel` changed from `"medium"` to `"low"` — no more `<think>` reasoning blocks in output
- Token persistence path moved from `~/.mozi/` to project-local `./config.local.json5`
- `mergeConfigs()` and `validateRequiredConfig()` include weixin channel
- `cron/executor.ts` and `tools/builtin/cron.ts` channel lists updated

## 7. Key File Modifications

| File | Change |
|------|--------|
| `src/types/index.ts` | Simplified ChannelId, removed old channel types, kept WeixinConfig |
| `src/config/index.ts` | Removed old channel schemas, simplified merge/validate/env |
| `src/gateway/server.ts` | Only init weixin channel, pass weixinChannel to WsServer |
| `src/channels/index.ts` | Removed old channel barrel exports |
| `src/index.ts` | Removed old channel public API exports |
| `src/cli/index.ts` | Onboard wizard only asks about Personal WeChat, check cmd only validates weixin |
| `src/web/websocket.ts` | Channel config return/validate/save only handles weixin |
| `src/web/static.ts` | Control panel UI only shows Personal WeChat card |
| `src/agents/runtime.ts` | thinkingLevel → low |
| `src/providers/model-resolver.ts` | MiniMax baseUrl fix, M3 added to presets |
| `package.json` | Renamed to vex-bot, removed old channel deps |

## 8. Full Internationalization to English (2026-06-25)

Translated ALL Chinese text across the entire codebase to English:

- **68 source files** — JSDoc comments, inline `//` comments, log messages, error strings, console output, tool descriptions, system prompts
- **WebChat UI** (`src/web/static.ts`) — all button labels, status messages, config panel text, QR login flow text
- **CLI** (`src/cli/index.ts`) — command descriptions, onboard wizard prompts, status/logs output, error messages
- **System prompts** (`src/agents/system-prompt.ts`) — changed from instructing AI to respond in Chinese to responding in English. Locale switched from `zh-CN` to `en-US`
- **WeChat channel** — placeholder labels (`[Image]`, `[Voice]`, `[File]`, `[Video]`) kept as English

## 9. Project Documentation (2026-06-25)

Created comprehensive English documentation:

| Document | Lines | Content |
|----------|-------|---------|
| `README.md` | ~220 | Project homepage with Mermaid architecture diagram, features, quick start, CLI reference, config overview |
| `docs/api-reference.md` | ~1,720 | Full API reference across 15 modules — Agent, Gateway, Types, Plugins, Tools, Skills, Memory, Cron, Outbound, Hooks, Config, Providers, Channels, CLI, top-level exports |
| `docs/developer-guide.md` | ~730 | Architecture deep dive, message flow (WeChat + WebChat), extension guides for channels/tools/plugins/skills/providers, build & test workflow, coding conventions, known issues |
| `docs/user-manual.md` | ~940 | Installation (npm/Docker/source), `vex onboard` wizard, config file reference, 9 CLI commands, WebChat usage, WeChat QR login, 8 Chinese provider configs, Docker deployment, FAQ |
| `AGENTS.md` | ~200 | AI agent knowledge base with project structure, code map, conventions, anti-patterns, cross-cutting concerns |

## 10. GitHub Repository Setup

- Fork source corrected to `github.com/oujingzhou/openmozi`
- Repository: `github.com/counhopig/vex-bot`
- Static badges (no npm dependency): version, license, Node.js
- Topics: `chatbot`, `wechat`, `ai-agent`, `typescript`, `deepseek`, `llm`, `weixin`
- Issues enabled, Wiki disabled

