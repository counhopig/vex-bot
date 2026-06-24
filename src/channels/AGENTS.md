# Channels Module

Channel adapter layer — normalizes platform messages to `InboundMessageContext`, handles send/receive, manages connections.

## STRUCTURE

```
channels/
├── common/base.ts      # Channel interface contract, registerChannel, getChannel
├── common/index.ts     # Barrel
├── weixin/             # Personal WeChat: iLink OC API long-polling
│   ├── client.ts       # iLink API HTTP client (QR code, polling, message send)
│   ├── login.ts        # QR code login flow
│   ├── adapter.ts      # WeixinChannel adapter (long-polling, message handling)
│   └── index.ts        # createWeixinChannel factory
└── index.ts            # Module barrel
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Channel contract | `common/base.ts` | `Channel` interface: `start()`, `stop()`, `sendMessage()`, `setMessageHandler()` |
| Add new channel | Create subdir, implement `Channel` interface, register in `index.ts` |
| Message normalization | `weixin/adapter.ts` | Converts iLink format → `InboundMessageContext` |
| iLink API client | `weixin/client.ts` | QR code, message polling, message send |
| QR login flow | `weixin/login.ts` | QR code scan login, token persistence |

## CONVENTIONS

- Each channel subdir exposes `createXxxChannel(config): Channel` factory function
- `setMessageHandler(handler)` receives `(context: InboundMessageContext) => Promise<void>`
- All channels register via `registerChannel()` from `common/base.ts` on construction
- Channel start/stop returns void; errors logged internally, not thrown

## ANTI-PATTERNS

- **NEVER import channel internals outside this module** — use `getChannel(id)` from `common/base.ts`
- **NEVER hardcode channel IDs in gateway** — channels are initialized from config presence
