# Vex — 从 OpenMozi 分叉的改动记录

Vex was forked from [OpenMozi](https://github.com/oujingzhou/openmozi) (Apache 2.0) as a personal WeChat-specific version.

## 1. 全项目改名

| 原名 | 改为 |
|------|------|
| `openmozi` / `mozi-bot` | `vex-bot` |
| `Mozi` | `Vex` |
| `mozi` CLI | `vex` CLI |
| `MOZI_` 环境变量 | `VEX_` |
| `~/.mozi/` 配置目录 | `~/.vex/` |

## 2. 删除多通道支持，只保留个人微信

删除以下通道模块及依赖：

- `src/channels/feishu/` — 飞书
- `src/channels/dingtalk/` — 钉钉
- `src/channels/qq/` — QQ
- `src/channels/wecom/` — 企业微信

移除的 npm 依赖：

- `@larksuiteoapi/node-sdk`
- `dingtalk-stream`
- `qq-guild-bot`
- `crypto-js`

类型简化：

- `ChannelId` 从 `"feishu" | "dingtalk" | "qq" | "wecom" | "weixin" | "webchat"` 简化为 `"weixin" | "webchat"`
- `MoziConfig.channels` 只保留 `weixin?: WeixinConfig`
- 移除 `FeishuConfig`、`DingtalkConfig`、`QQConfig`、`WeComConfig` 类型

## 3. 新增个人微信通道

基于腾讯 iLink OC API (`https://ilinkai.weixin.qq.com`)，参考 [AstrBot](https://github.com/Soulter/AstrBot) 的 `weixin_oc` 适配器实现。

新增文件：

```
src/channels/weixin/
├── client.ts    # iLink API HTTP 客户端（二维码获取、轮询、消息收发）
├── login.ts     # 二维码扫码登录流程
├── adapter.ts   # WeixinChannel 通道适配器（长轮询、消息处理）
└── index.ts     # 模块 barrel 导出
```

### 扫码登录流程

1. 调用 `ilink/bot/get_bot_qrcode` 获取二维码
2. 终端 / WebUI 显示二维码链接
3. 手机微信扫码确认登录
4. 轮询 `ilink/bot/get_qrcode_status` 等待确认
5. 获取 `bot_token` 后保存到 `config.local.json5`
6. 下次启动直接复用 token

### 消息收发

- 入站：POST `ilink/bot/getupdates` 长轮询拉取消息
- 出站：POST `ilink/bot/sendmessage` 发送回复
- 支持：文本消息、图片/视频/文件/语音的占位符提取

## 4. WebUI 二维码登录

在 `/control` 配置页面中：

- 个人微信卡片：开关、Bot Type、API Base URL
- 「扫码登录」按钮 → 前端直接显示二维码图片
- 每 2 秒轮询扫码状态 → 成功后显示「已登录 ✓」
- 新增 WebSocket 方法：`weixin.qr`、`weixin.qr.status`

## 5. MiniMax M3 支持

- 将 MiniMax baseUrl 从 `/v1/text/chatcompletion_v2` 修正为 `/v1`
- 将 `MiniMax-M3` 加入预设模型列表（1M 上下文 / 65K tokens）

## 6. 修复

- `thinkingLevel` 从 `"medium"` 改为 `"low"`，不再输出 `<think>` 推理块
- Token 持久化路径从 `~/.mozi/` 改为项目目录 `./config.local.json5`
- `mergeConfigs()` 和 `validateRequiredConfig()` 包含 weixin 通道
- `cron/executor.ts` 和 `tools/builtin/cron.ts` 通道列表更新

## 7. 关键文件修改

| 文件 | 改动 |
|------|------|
| `src/types/index.ts` | ChannelId 简化，移除旧通道类型，保留 WeixinConfig |
| `src/config/index.ts` | 移除旧通道 schema，简化 merge/validate/env |
| `src/gateway/server.ts` | 只初始化 weixin 通道，传递 weixinChannel 给 WsServer |
| `src/channels/index.ts` | 移除旧通道 barrel 导出 |
| `src/index.ts` | 移除旧通道的公开 API 导出 |
| `src/cli/index.ts` | onboard 向导只询问个人微信，check 命令只检查 weixin |
| `src/web/websocket.ts` | 通道配置返回/验证/保存只处理 weixin |
| `src/web/static.ts` | 控制台 UI 只显示个人微信卡片 |
| `src/agents/runtime.ts` | thinkingLevel 改为 low |
| `src/providers/model-resolver.ts` | MiniMax baseUrl 修正，M3 加入预设 |
| `package.json` | 改名 vex-bot，移除旧通道依赖 |
