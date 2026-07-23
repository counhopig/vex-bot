# Web Module

WebChat browser UI + WebSocket protocol layer. Server-rendered inline HTML SPAs (no frontend build). WebSocket server implements 18 methods for chat, sessions, config, live logs, and WeChat QR.

## STRUCTURE

```
web/
├── types.ts       # WsFrame union, ChatMessage, ChatDeltaEvent, SessionInfo, SystemStatus, ConfigInfo + 7-section params
├── auth.ts        # SQLite-backed local Web UI users, login sessions, per-user Weixin login records
├── websocket.ts   # WsServer class: auth, connection mgmt, 16 method handlers, heartbeat, YAML config save
├── static.ts      # Login page + two inline SPAs, handleStaticRequest route dispatcher
├── assets/        # Runtime-served Web UI image assets copied to dist/web/assets during build
└── index.ts       # Barrel re-export
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| WebSocket frame protocol | `types.ts` | `WsFrame = WsRequestFrame \| WsResponseFrame \| WsEventFrame` |
| Web UI auth | `auth.ts` | Local register/login sessions in SQLite; first registered user becomes admin; default DB `~/.vex/web-auth.sqlite` |
| Add a WS method | `websocket.ts` | Add case in `handleRequest()`, Zod schema, private handler |
| Chat streaming | `websocket.ts:handleChatSend()` | `UserRuntimeManager.getAgent(userId).processMessageStream()` → `chat.delta` events → client accumulates → `marked.js` render |
| Cancel in-flight chat | `websocket.ts:handleChatCancel()` | `AbortController.abort()` → `chat.delta` with `cancelled:true` |
| Config CRUD via WS | `websocket.ts:getConfigForClient/saveConfigForClient()` | Authenticated user-owned settings go to SQLite; admin/system settings still merge into YAML |
| QR login flow | `websocket.ts:handleWeixinQR/handleWeixinQRStatus()` | Generates QR; client polls status every 2s |
| Session lifecycle | `websocket.ts:ensureSession/handleSessionsRestore()` | Lazy-create via `store.getOrCreate()`; restore repoints the client at a sessionKey (pi reloads that key's LLM context on the next turn) and returns the transcript for the UI |
| WebChat SPA | `static.ts:getEmbeddedHtml()` | Inline CSS/JS, `marked.js` via CDN, sidebar sessions, message list |
| Control UI | `static.ts:getControlHtml()` | Inline CSS/JS, config editor, QR scan, status panel |
| Route dispatch | `static.ts:handleStaticRequest()` | `/login` → auth page, `/` → WebChat, `/control` → Control UI, `/assets/*` → copied Web UI assets; skips `/ws`, `/api/*`, `/health` |
| HTML sanitization | `static.ts:sanitizeHtml()` (inline JS) | Blocks 7 tag types, strips `on*` attrs, `javascript:` URIs |
| Heartbeat | `websocket.ts:checkHeartbeat()` | 30s ping, 60s timeout → `ws.terminate()` |

## WEB SOCKET PROTOCOL

Frames: `{id, type:"req"|"res"|"event", method?, params?, ok?, payload?, error?}`

| Method | Direction | Params | Returns |
|--------|-----------|--------|---------|
| `chat.send` | req → stream | `{message, sessionKey?}` | `chat.delta` events + final `{messageId}` |
| `chat.cancel` | req | `{}` | `{cancelled}` |
| `chat.clear` | req | `{}` | `{success, sessionKey, sessionId}` |
| `sessions.list` | req | `{limit?, activeMinutes?, search?}` | `{sessions}` (WebChat sessions only; Weixin sessions are not exposed to the webpage) |
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
| `logs.subscribe` | req | `{}` | `{entries: BackendLogEntry[]}` + `log.entry` events |
| `logs.unsubscribe` | req | `{}` | `{ok: true}` |
| `weixin.qr` | req | `{}` | `{qrcode_url, qrcode}` or `{error}` |
| `weixin.qr.status` | req | `{qrcode}` | `{status, message, accountId?}` |

## KEY PATTERNS

- **Streaming**: `handleChatSend` resolves the authenticated user's agent from `UserRuntimeManager`, then runs `agent.processMessageStream()` in a for-await loop, emitting `chat.delta` events per token. Client accumulates deltas in a buffer, calls `marked.parse()` on `done:true`.
- **Lazy session binding**: Clients arrive sessionless. `ensureSession()` creates via `store.getOrCreate("webchat:${clientId}")` only on first `chat.send` or explicit `chat.clear`.
- **Web session scope**: `sessions.list` filters the shared store to `webchat:` session keys before returning data to the browser UI, so Personal WeChat transcripts remain stored but do not appear on the webpage.
- **Authenticated session scope**: when `webAuth.enabled` is true, WebChat session keys include the web user id (`webchat:{userId}:{clientId}`) and session list/history/delete/restore reject other users' keys.
- **Admin bootstrap**: Vex does not create a fixed default admin password. The first registered Web user gets role `admin`; admins can manage all other accounts from the Control Panel Users view and `/api/admin/users`.
- **Weixin login state**: QR login for authenticated users stores the confirmed token/account id under the current web user in SQLite and asks the Gateway to activate a user-scoped `WeixinChannel`. Startup restores stored user Weixin channels from SQLite.
- **Config merge**: authenticated `config.save` splits user-owned settings (`agent`, `memory`, `persona`, `skillLearner`, `sharelink`, `weather`, `sessions`) into SQLite and admin/system settings (`providers`, `channels`, `server`, `logging`, `skills`, `rawYaml`) into YAML. Legacy single-user mode still calls `saveConfig()` directly.
- **Log streaming**: `LogStreamer` tails `~/.vex/logs/vex-YYYY-MM-DD.log`, returns a recent backlog on `logs.subscribe`, then emits normalized `log.entry` events.
- **QR polling**: Client calls `weixin.qr` → gets QR URL → 2s interval polling `weixin.qr.status` until status resolves.
- **No filesystem for HTML**: Both SPAs are giant inline template strings with embedded CSS/JS. `handleStaticRequest` sets `Content-Length` via `Buffer.byteLength()`. `marked.js` loaded from CDN. Image assets live in `src/web/assets/` and are copied to `dist/web/assets/` by `scripts/copy-web-assets.mjs`.

## ANTI-PATTERNS

- **NEVER mix `ChatMessage` types** — `web/types.ts:ChatMessage` has `{id, role, content, timestamp}`; shared `types/index.ts:ChatMessage` has `{role, content, tool_calls?}`. Incompatible shapes.
- **NEVER write config without merge** — `saveConfig()` reads existing then merges. Blind overwrite destroys other sections.
- **NEVER add a third inline SPA to static.ts** — 2303 lines already. New UIs go in separate modules or serve external static files.
- **NEVER copy WebSocket client code between SPAs** — `getEmbeddedHtml()` and `getControlHtml()` duplicate WS connect/send/receive logic. Extract shared client before adding a third consumer.
- **NEVER change `validProviders` in only one place** — hardcoded list of 15 provider IDs appears in `validateConfig()`, `cli/index.ts:onboard`, and `static.ts:getControlHtml()`. All three must stay in sync.
- Config writes from WebSocket `saveConfig` and CLI `onboard` have no file locking; concurrent writes to the same selected config file can race.
