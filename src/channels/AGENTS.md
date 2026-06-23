# Channels Module

Channel adapter layer — normalizes platform messages to `InboundMessageContext`, handles send/receive, manages connections.

## STRUCTURE

```
channels/
├── common/base.ts      # Channel interface contract, registerChannel, getChannel
├── common/index.ts     # Barrel
├── feishu/             # Feishu/Lark: WebSocket long-connection
│   ├── api.ts          # HTTP API client (token management, message send)
│   ├── events.ts       # Event subscription/dispatch
│   ├── websocket.ts    # WebSocket connection lifecycle
│   └── index.ts        # createFeishuChannel factory
├── dingtalk/           # DingTalk: Stream long-connection
│   ├── api.ts          # HTTP API client
│   ├── events.ts       # Event handler + dispatch
│   ├── stream.ts       # Stream connection via dingtalk-stream SDK
│   └── index.ts        # createDingtalkChannel factory
├── qq/                 # QQ Guild: WebSocket
│   ├── api.ts          # HTTP API client (qq-guild-bot SDK)
│   ├── websocket.ts    # WebSocket connection
│   └── index.ts        # createQQChannel factory
├── wecom/              # WeChat Work: HTTP webhook callback
│   ├── api.ts          # HTTP API client
│   ├── crypto.ts       # AES encryption/decryption for message verification
│   ├── events.ts       # Webhook event parsing + dispatch
│   └── index.ts        # createWeComChannel factory
└── index.ts            # Module barrel + API client re-exports
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Channel contract | `common/base.ts` | `Channel` interface: `start()`, `stop()`, `sendMessage()`, `setMessageHandler()` |
| Add new channel | Create subdir, implement `Channel` interface, register in `index.ts` |
| Message normalization | Each channel's `events.ts` | Converts platform format → `InboundMessageContext` |
| API clients | `<channel>/api.ts` | Token refresh, message send, user/group info |
| Connection mgmt | `<channel>/websocket.ts` or `<channel>/stream.ts` | Long-connection lifecycle, reconnection, error handling |
| WeCom crypto | `wecom/crypto.ts` | AES-256-CBC for message encryption/decryption, SHA1 signature |

## CONVENTIONS

- Each channel subdir exposes `createXxxChannel(config): Channel` factory function
- `setMessageHandler(handler)` receives `(context: InboundMessageContext) => Promise<void>`
- All channels register via `registerChannel()` from `common/base.ts` on construction
- API clients manage their own token lifecycle (fetch on start, refresh before expiry)
- Channel start/stop returns void; errors logged internally, not thrown

## ANTI-PATTERNS

- **NEVER import channel internals outside this module** — use `getChannel(id)` from `common/base.ts`
- **NEVER hardcode channel IDs in gateway** — channels are initialized from config presence
- Feishu/QQ: do NOT call HTTP APIs during WebSocket message loop (use queued approach)
- WeCom: do NOT skip signature verification in production
