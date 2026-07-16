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

## NOTES

- `common/index.ts` is a hybrid barrel+logic file. It re-exports everything from `common/base.ts` (`ChannelAdapter`, `BaseChannelAdapter`, `MessageHandler`) and defines the process-global channel registry functions `registerChannel()`, `getChannel()`, and `getAllChannels()`. Per-user Weixin channels are managed by the Gateway, not this registry.
- The **only external consumer** of the channel registry is the outbound module (`src/outbound/index.ts`), which imports `getChannel()` and `getAllChannels()` from `../channels/common/index.js` to resolve channels for message delivery. Every call path for outbound delivery flows through these two functions.

## ANTI-PATTERNS

- **NEVER import channel internals outside this module** — use `getChannel(id)` from `common/base.ts`
- **NEVER hardcode channel IDs in gateway** — channels are initialized from config presence
- **NEVER duplicate channel registry logic in outbound or web modules** — use `getChannel()` / `getAllChannels()` from `common/index.ts`. The outbound module already does this; do not build a parallel channel lookup in `web/` or anywhere else.
