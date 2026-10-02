# Vex 设计文档

## 1. 概述

Vex 是一个个人 AI 助手，只服务一个主人。它以常驻守护进程 `vexd` 运行，通过个人微信和 WebChat 两个窗口与主人对话，能调用工具、维护长期记忆、执行定时任务、委派子 agent，并接入 MCP 服务。

技术栈：TypeScript（ESM，strict），依赖 `@mariozechner/pi-ai`（模型抽象）与 `@mariozechner/pi-agent-core`（agent 循环），测试使用 Vitest。

## 2. 范围

**包含：**

- 单用户：系统只有一个主人；微信只响应主人本人的消息，其他联系人和群消息一律忽略
- 入口：个人微信（iLink OC API 长轮询）、WebChat（浏览器）
- 流式输出、插话（steering）与中断
- 上下文压缩
- 工具：内置工具、插件工具、MCP 工具、子 agent
- 工具审批
- 长期记忆、定时任务、Skills、人设
- 国产模型与 OpenAI/Anthropic 兼容端点

**不包含：** 多用户与账号体系、终端客户端、其他 IM 渠道。

## 3. 架构

```
  主人在微信发消息                         主人在网页发消息
        │                                       │
        ▼                                       ▼
  ┌───────────┐                          ┌────────────┐
  │ 微信接入   │                          │  WebChat   │
  │(vexd 内部) │                          │  (浏览器)   │
  └─────┬─────┘                          └─────┬──────┘
        │                                 WebSocket
        ▼                                       ▼
  ┌──────────────────────────────────────────────────┐
  │                 vexd（后台常驻）                   │
  │                                                  │
  │   会话 ── pi Agent 循环 ── 调用工具 / 记忆 / MCP    │
  │     │                                            │
  │     └─► 回复、流式片段、审批请求                    │
  └──────────────────────┬───────────────────────────┘
                         │
     回到发消息的窗口（审批请求发到微信和所有打开的网页）
```

`vexd` 是唯一的运行实体。微信接入在进程内运行；WebChat 通过 WebSocket 连接 `vexd`。两个窗口共享同一份长期记忆、工具集、配置与审批队列。

### 3.1 模块

| 模块 | 职责 |
|---|---|
| `core/` | `Session`：一个对话对应一个 pi `Agent`，负责消息串行、插话、中断。`SessionManager`：创建、缓存、持久化、恢复 Session。`Router`：把入站消息映射到会话并投递。`EventBus`：带类型的进程内事件总线 |
| `protocol/` | TypeBox 定义的 WebChat ↔ vexd 消息 schema（请求、事件、审批），两端共用 |
| `gateway/` | HTTP + WebSocket 服务，提供 WebChat 静态资源与协议端点 |
| `channels/wechat/` | iLink 长轮询接入、主人身份校验、消息收发 |
| `web/` | WebChat 前端：会话列表、聊天视图、审批交互、设置页 |
| `tools/` | 工具注册表、内置工具、MCP 桥、`delegate` 子 agent 工具 |
| `policy/` | 工具审批策略与挂起审批管理 |
| `context/` | system prompt 组装、记忆召回注入、上下文压缩 |
| `memory/` | 长期记忆存储与混合召回 |
| `cron/` | 定时任务调度与执行 |
| `skills/` | `SKILL.md` 加载与清单生成 |
| `plugins/` | 插件发现、加载、工具与钩子注册 |
| `providers/` | 模型解析（`ModelResolver`）与 API key 获取 |
| `store/` | 数据目录读写（JSONL 追加、原子写） |
| `cli/` | `vex` 命令：启动/停止/状态/日志、首次配置向导 |

依赖方向：`channels`、`gateway` → `core` → `tools`、`context`、`policy` → `pi-agent-core`。`core` 不依赖任何具体渠道。

## 4. 会话模型

| 窗口 | 会话 | 存储 |
|---|---|---|
| 微信 | 一条永久对话，不可重置，长度由压缩控制 | `~/.vex/sessions/wechat.jsonl` |
| WebChat | 多会话：新建、切换、重命名、删除；新会话标题由模型自动生成 | `~/.vex/sessions/web/<id>.jsonl` |

各会话的对话历史互相独立；长期记忆、工具、配置全局共享。不同会话可以同时运行。

## 5. Agent 循环

### 5.1 消息处理

- **会话空闲**：组装上下文，调用 `agent.prompt()` 开始一轮循环（模型回复 → 工具调用 → 再回复，直到结束）。
- **会话运行中收到新消息**：作为插话，通过 pi 的 steering 队列在下一次模型调用前注入。
- **中断**：微信发 `/stop`，或网页点击停止按钮，调用 `agent.abort()` 结束当前轮。

### 5.2 输出

- WebChat：逐字流式显示回复，实时显示工具调用状态与子 agent 进度。
- 微信：一轮结束后发送完整回复；一轮运行超过 15 秒时先发送一条“处理中”提示。

### 5.3 上下文组装

每轮开始前，system prompt 依次由以下部分组成：

1. 人设
2. Skills 清单
3. 按当前消息从长期记忆召回的相关条目

随后是本会话的历史消息。

### 5.4 上下文压缩

通过 `transformContext` 实现：当历史 token 数超过当前模型上下文窗口的 70% 时，把较早的消息交给模型生成摘要，用摘要替换这部分消息，保留最近若干轮原文。压缩只影响送入模型的上下文，JSONL 文件保留完整原始记录。

### 5.5 持久化与恢复

每条消息完成时追加写入对应 JSONL；压缩摘要作为特殊条目写入。`vexd` 启动时从 JSONL 恢复所有会话（从最近一次摘要开始重建上下文）。

## 6. 工具

### 6.1 来源

所有工具注册进同一个工具注册表，转换为 pi `AgentTool`：

1. **内置工具**：文件系统、bash、浏览器、记忆、天气、cron、图片、web 等。文件与 bash 的工作目录默认 `~/.vex/workspace/`，可配置。bash 只继承环境变量白名单。
2. **插件工具**：插件通过 `definePlugin` 注册工具和钩子；`tool_start`/`tool_end` 钩子分别挂接在 `beforeToolCall`/`afterToolCall` 上。
3. **MCP 工具**：`config.yaml` 的 `mcpServers` 声明服务，支持 stdio 与 Streamable HTTP。`vexd` 启动时连接，工具命名为 `mcp__<服务名>__<工具名>`。
4. **`delegate`**：子 agent 工具（见 6.3）。

### 6.2 审批

每个工具有一个策略：

| 策略 | 行为 |
|---|---|
| `allow` | 直接执行 |
| `ask` | 挂起，等待主人批准 |
| `deny` | 不注册给模型 |

默认值：只读类工具为 `allow`；bash、写文件、浏览器操作、MCP 工具为 `ask`。可在配置中按工具名覆盖。

`ask` 流程在 `beforeToolCall` 中实现：

1. 生成审批请求（工具名、参数摘要、来源会话），推送到微信和所有在线 WebChat。
2. 主人回复：
   - WebChat：允许 / 本会话总是允许 / 拒绝
   - 微信：`/y`（允许）、`/ya`（本会话总是允许）、`/n`（拒绝）
3. 任一窗口首先给出的答复生效，其他窗口的提示同步失效。
4. 10 分钟未答复视为拒绝。拒绝时返回 `{ block: true, reason }`，模型收到拒绝原因后继续回复。

cron 任务与子 agent 使用同一审批流程。

### 6.3 子 agent

`delegate(task: string, tools?: string[])`：

- 创建一个上下文为空的临时 pi `Agent`，system prompt 为人设加任务描述，工具集为指定子集（缺省为主 agent 工具集去掉 `delegate`）。
- 嵌套深度为 1：子 agent 不能调用 `delegate`。
- 继承审批策略。
- 只把子 agent 的最终回复文本作为工具结果返回给主 agent。
- 同一轮中的多个 `delegate` 调用借助 pi 的并行工具执行同时运行。
- 进度通过 `tool_execution_update` 推送给 WebChat。

## 7. 长期记忆

- 全局一份，存储于 `~/.vex/memory/`，索引原子写入。
- 中文感知分词；无状态哈希向量与关键词混合召回。
- 工具：`remember`、`recall`、`forget`。
- 每轮开始前按当前消息自动召回前 5 条注入 system prompt。

## 8. 定时任务

- 通过 `cron` 工具创建、列出、删除任务，存储于 `~/.vex/cron.json`。
- 调度方式：cron 表达式、固定间隔、一次性时间点。
- 到点后在临时会话中执行任务，结果投递到创建时所在窗口：微信任务发到微信，WebChat 任务发到对应网页会话并显示通知。
- 执行超时（任务指定或默认 10 分钟）记为失败；服务停机期间错过的一次性任务在启动时报告错过并停用；正在运行的任务不会被重复触发；任务名唯一。

## 9. Skills

从 `~/.vex/skills/` 与内置 `skills/` 目录加载 `SKILL.md`。system prompt 只包含技能名称与简介；模型需要时用文件工具读取完整内容。

## 10. 模型

基于 pi-ai 的 `ModelResolver`：支持 DeepSeek、Kimi、MiniMax、StepFun 等国产模型预设，以及 `custom-openai` / `custom-anthropic` 兼容端点和 OpenRouter、Ollama 等动态模型提供方。模型 id 区分大小写，对有固定预设表的提供方，未声明的 id 解析失败而不猜测协议。

## 11. 配置

唯一配置文件 `~/.vex/config.yaml`：

```yaml
model:
  provider: deepseek
  id: deepseek-chat
  thinking: off
persona: |
  ...
wechat:
  enabled: true
  ownerId: <主人微信 id>
web:
  host: 127.0.0.1
  port: 7860
  token: <访问口令>
workspace: ~/.vex/workspace
tools:
  policy:
    bash: ask
    write_file: ask
bashEnvPassthrough: []
mcpServers:
  <name>:
    command: npx
    args: [...]
compaction:
  threshold: 0.7
```

WebChat 设置页可直接读写该文件；修改后需重启才生效的项在页面上标注。`vex onboard` 引导生成初始配置并完成微信扫码登录。

## 12. Gateway 与 WebChat

- 默认监听 `127.0.0.1`；远程访问需配置 `web.host` 并使用 `web.token` 口令登录（HttpOnly cookie）。
- WebSocket 协议由 `protocol/` 中的 TypeBox schema 定义：
  - 客户端 → vexd：发送消息、停止、新建/切换/重命名/删除会话、审批答复、读取/保存配置
  - vexd → 客户端：文本增量、消息完成、工具调用开始/结束、子 agent 进度、审批请求/失效、cron 通知、错误
- 前端为服务端直接输出的单页应用，无前端构建步骤。

## 13. 数据目录

```
~/.vex/
├── config.yaml
├── sessions/
│   ├── wechat.jsonl
│   └── web/<id>.jsonl
├── memory/
├── cron.json
├── skills/
├── plugins/
├── workspace/
├── wechat/          # 微信登录态
└── logs/
```

首次部署前清空旧版 `~/.vex/`。

## 14. 错误处理

| 场景 | 处理 |
|---|---|
| 模型调用失败 | 指数退避重试，最多 3 次；仍失败则把错误原因发回当前窗口 |
| 工具执行出错 | 作为错误工具结果返回模型，不中断本轮 |
| MCP 服务连接失败 | 跳过该服务并记录日志，`vexd` 正常启动 |
| 微信长轮询断开 | 自动重连（指数退避） |
| WebSocket 断开 | 前端自动重连并重新拉取当前会话状态 |
| 审批超时 | 视为拒绝 |
| 关闭 `vexd` | 依次中断运行中的会话、停止 cron、断开 MCP、关闭 HTTP 服务；单步失败不影响后续步骤 |

## 15. 测试

- Vitest，TDD（先写失败测试，再实现）。
- `core/` 测试通过 pi 的 `streamFn` 注入脚本化假模型，覆盖完整循环、插话、中断、审批挂起/超时、压缩、JSONL 恢复，无需真实 API。
- `gateway/` 测试使用真实 HTTP 服务与 WebSocket 连接。
- `channels/wechat/` 测试对 iLink HTTP 接口使用本地假服务器。
- `tools/` 测试在临时目录中执行真实文件与 bash 操作；MCP 桥使用本地 stdio 假服务。
- `npm run lint`（`tsc --noEmit`）与 `npm test` 为提交门槛。
