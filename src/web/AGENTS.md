# Web Module

WebChat browser UI + WebSocket protocol layer. Server-rendered inline HTML SPAs (no frontend build). WebSocket server implements 16 methods for chat, sessions, config, and WeChat QR.

## STRUCTURE

```
web/
├── types.ts       # WsFrame union, ChatMessage, ChatDeltaEvent, SessionInfo, SystemStatus, ConfigInfo + 7-section params
├── websocket.ts   # WsServer class: connection mgmt, 16 method handlers, heartbeat, JSON5 config save
├── static.ts      # Two inline SPAs (getEmbeddedHtml, getControlHtml), handleStaticRequest route dispatcher
└── index.ts       # Barrel re-export
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| WebSocket frame protocol | `types.ts` | `WsFrame = WsRequestFrame \| WsResponseFrame \| WsEventFrame` |
| Add a WS method | `websocket.ts` | Add case in `handleRequest()`, Zod schema, private handler |
| Chat streaming | `websocket.ts:handleChatSend()` | `agent.processMessageStream()` → `chat.delta` events → client accumulates → `marked.js` render |
| Cancel in-flight chat | `websocket.ts:handleChatCancel()` | `AbortController.abort()` → `chat.delta` with `cancelled:true` |
| Config CRUD via WS | `websocket.ts:getConfigInfo/validateConfig/saveConfig()` | Reads existing JSON5, merges 7 sections, writes `~/.vex/config.local.json5` |
| QR login flow | `websocket.ts:handleWeixinQR/handleWeixinQRStatus()` | Generates QR; client polls status every 2s |
| Session lifecycle | `websocket.ts:ensureSession/handleSessionsRestore()` | Lazy-create via `store.getOrCreate()`, explicit restore loads transcript into agent |
| WebChat SPA | `static.ts:getEmbeddedHtml()` | Inline CSS/JS, `marked.js` via CDN, sidebar sessions, message list |
| Control UI | `static.ts:getControlHtml()` | Inline CSS/JS, config editor, QR scan, status panel |
| Route dispatch | `static.ts:handleStaticRequest()` | `/` → WebChat, `/control` → Control UI; skips `/ws`, `/api/*`, `/health` |
| HTML sanitization | `static.ts:sanitizeHtml()` (inline JS) | Blocks 7 tag types, strips `on*` attrs, `javascript:` URIs |
| Heartbeat | `websocket.ts:checkHeartbeat()` | 30s ping, 60s timeout → `ws.terminate()` |

## WEB SOCKET PROTOCOL

Frames: `{id, type:"req"|"res"|"event", method?, params?, ok?, payload?, error?}`

| Method | Direction | Params | Returns |
|--------|-----------|--------|---------|
| `chat.send` | req → stream | `{message, sessionKey?}` | `chat.delta` events + final `{messageId}` |
| `chat.cancel` | req | `{}` | `{cancelled}` |
| `chat.clear` | req | `{}` | `{success, sessionKey, sessionId}` |
| `sessions.list` | req | `{limit?, activeMinutes?, search?}` | `{sessions}` |
| `sessions.history` | req | `{sessionKey}` | `{sessionKey, sessionId, messages}` |
| `sessions.delete` | req | `{sessionKey}` | `{success}` |
| `sessions.reset` | req | `{sessionKey}` | `{success, sessionKey, sessionId}` |
| `sessions.restore` | req | `{sessionKey}` | `{sessionKey, sessionId, messages}` |
| `status.get` | req | `{}` | `{version, uptime, providers, channels, sessions}` |
| `session.info` | req | `{}` | `{sessionKey, sessionId, ...agentInfo}` |
| `config.get` | req | `{}` | `ConfigInfo` (7 sections, API keys redacted) |
| `config.validate` | req | `ConfigSaveParams` | `{valid, errors[], warnings[]}` |
| `config.save` | req | `ConfigSaveParams` | `{success, message, requiresRestart?}` |
| `ping` | req | `{}` | `{pong: timestamp}` |
| `weixin.qr` | req | `{}` | `{qrcode_url, qrcode}` or `{error}` |
| `weixin.qr.status` | req | `{qrcode}` | `{status, message, accountId?}` |

## KEY PATTERNS

- **Streaming**: `handleChatSend` runs `agent.processMessageStream()` in a for-await loop, emitting `chat.delta` events per token. Client accumulates deltas in a buffer, calls `marked.parse()` on `done:true`.
- **Lazy session binding**: Clients arrive sessionless. `ensureSession()` creates via `store.getOrCreate("webchat:${clientId}")` only on first `chat.send` or explicit `chat.clear`.
- **Config merge**: `saveConfig()` reads existing `config.local.json5`, merges 7 top-level sections, deletes providers that sent `hasApiKey:false`. Outputs JSON5 with unquoted keys via `generateJson5()`.
- **QR polling**: Client calls `weixin.qr` → gets QR URL → 2s interval polling `weixin.qr.status` until status resolves.
- **No filesystem for HTML**: Both SPAs are giant inline template strings with embedded CSS/JS. `handleStaticRequest` sets `Content-Length` via `Buffer.byteLength()`. `marked.js` loaded from CDN.

## ANTI-PATTERNS

- **NEVER duplicate `generateJson5()`** — 40-line JSON5 serializer is copy-pasted in `cli/index.ts`. Extract to shared utility before modifying either.
- **NEVER mix `ChatMessage` types** — `web/types.ts:ChatMessage` has `{id, role, content, timestamp}`; shared `types/index.ts:ChatMessage` has `{role, content, tool_calls?}`. Incompatible shapes.
- **NEVER write config without merge** — `saveConfig()` reads existing then merges. Blind overwrite destroys other sections.
- **NEVER add a third inline SPA to static.ts** — 2303 lines already. New UIs go in separate modules or serve external static files.
- **NEVER copy WebSocket client code between SPAs** — `getEmbeddedHtml()` and `getControlHtml()` duplicate WS connect/send/receive logic. Extract shared client before adding a third consumer.
- **NEVER change `validProviders` in only one place** — hardcoded list of 15 provider IDs appears in `validateConfig()`, `cli/index.ts:onboard`, and `static.ts:getControlHtml()`. All three must stay in sync.
- Config writes from WebSocket `saveConfig` race with CLI `onboard` on `~/.vex/config.local.json5` — no file locking exists.
