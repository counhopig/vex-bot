# Vex 设计文档

## 1. 概述

Vex 是一个个人 AI 助手，只服务一个主人。它以常驻守护进程 `vexd` 运行，通过个人微信和 WebChat 两个窗口与主人对话。

Vex 有随时间变化的情绪与作息：没人理会时会疲惫、想找人说话，并会在微信里主动找主人聊天。

Vex 的长期状态——人设、关于主人的认知、记忆、技能、主动检查清单——都以 Markdown 文件形式存放在工作区中，agent 用普通文件工具读写它们；`vexd` 额外提供检索索引、调度器与情绪状态。

技术栈：TypeScript（ESM，strict），依赖 `@earendil-works/pi-ai` 1.x（模型抽象）、`@earendil-works/pi-agent-core` 1.x（agent 循环）、`better-sqlite3`（检索索引）、`croner`（时间规则）、`@modelcontextprotocol/sdk`（MCP 客户端），测试使用 Vitest。

## 2. 范围

**包含：**

- 单用户：系统只有一个主人；微信只响应主人本人的消息，其他联系人和群消息一律忽略
- 入口：个人微信（iLink OC API 长轮询）、WebChat（浏览器）
- 流式输出、插话（steering）与中断
- 上下文压缩
- 工具：核心内置工具、MCP 工具、子 agent
- Skills（Agent Skills 标准）
- 工具审批
- 文件化长期记忆与后台整理
- 定时投递与心跳
- 情绪状态、作息、主动发起聊天
- 国产模型与 OpenAI/Anthropic 兼容端点

**不包含：** 多用户与账号体系、终端客户端、其他 IM 渠道、自定义插件 API。

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
  │   会话 ── pi Agent 循环 ── 工具 / Skills / MCP     │
  │     │            │                               │
  │     │            └── 读写工作区 Markdown 文件       │
  │     └─► 回复、流式片段、审批请求                    │
  │                                                  │
  │   调度器 ──► 定时投递 / 心跳 / 记忆整理 / 主动聊天   │
  └──────────────────────┬───────────────────────────┘
                         │
     回到发消息的窗口（审批请求发到微信和所有打开的网页）
```

`vexd` 是唯一的运行实体。微信接入在进程内运行；WebChat 通过 WebSocket 连接 `vexd`。两个窗口共享同一个工作区、工具集、配置与审批队列。

### 3.1 模块

| 模块 | 职责 |
|---|---|
| `core/` | `Session`：一个对话对应一个 pi `Agent`，负责消息串行、插话、中断。`SessionManager`：创建、缓存、持久化、恢复 Session，支持临时会话。`Router`：把入站消息映射到会话并投递。`EventBus`：带类型的进程内事件总线 |
| `protocol/` | TypeBox 定义的 WebChat ↔ vexd 消息 schema（请求、事件、审批），两端共用 |
| `gateway/` | HTTP + WebSocket 服务，提供 WebChat 静态资源与协议端点 |
| `channels/wechat/` | iLink 长轮询接入、主人身份校验、消息收发 |
| `web/` | WebChat 前端：会话列表、聊天视图、审批交互、设置页 |
| `context/` | system prompt 组装（常驻工作区文件、Skills 清单）、上下文压缩、压缩前记忆抢救 |
| `tools/` | 工具注册表、核心内置工具、MCP 桥、`delegate` 子 agent 工具 |
| `policy/` | 工具审批策略与挂起审批管理 |
| `index/` | SQLite FTS5 检索索引：记忆文件与会话记录的增量索引、`memory_search` 查询 |
| `scheduler/` | 定时投递、心跳、记忆整理、主动聊天检查的调度 |
| `persona/` | 情绪状态（数值、衰减、短时情绪）、作息判断、主动聊天决策、情绪描述生成 |
| `skills/` | `SKILL.md` 发现与清单生成 |
| `providers/` | 模型解析（`ModelResolver`）与 API key 获取 |
| `store/` | 数据目录读写（JSONL 追加、原子写） |
| `cli/` | `vex` 命令：启动/停止/状态/日志、首次配置向导 |

依赖方向：`channels`、`gateway`、`scheduler` → `core` → `context`、`tools`、`policy`、`index`、`persona` → `pi-agent-core`。`core` 不依赖任何具体渠道。

## 4. 工作区

工作区 `~/.vex/workspace/` 是 agent 的“家”，也是文件与 bash 工具的默认工作目录。

| 路径 | 内容 | 加载方式 |
|---|---|---|
| `SOUL.md` | 人设、语气、行为准则 | 每轮常驻 system prompt |
| `USER.md` | 关于主人：身份、偏好、习惯 | 每轮常驻 system prompt |
| `MEMORY.md` | 提炼后的长期事实与决定，上限约 100 行 | 每轮常驻 system prompt |
| `memory/YYYY-MM-DD.md` | 每日笔记，agent 随时追加 | 通过 `memory_search` 检索 |
| `HEARTBEAT.md` | 心跳检查清单（自然语言） | 心跳时读取 |
| `skills/<name>/SKILL.md` | 主人或 agent 编写的技能 | 清单常驻，正文按需读取 |
| 其他 | agent 的工作文件 | 按需 |

首次启动时生成 `SOUL.md`、`USER.md`、`MEMORY.md`、`HEARTBEAT.md` 模板（`HEARTBEAT.md` 为空）。主人可直接编辑这些文件，修改在下一轮生效。

常驻文件超过长度上限时，按上限截断注入，并在 system prompt 中提示 agent 精简该文件。

## 5. 会话模型

| 会话 | 说明 | 存储 |
|---|---|---|
| 微信 | 一条永久对话，不可重置，长度由压缩控制 | `~/.vex/sessions/wechat.jsonl` |
| WebChat | 多会话：新建、切换、重命名、删除；新会话标题由模型自动生成 | `~/.vex/sessions/web/<id>.jsonl` |
| 临时会话 | 心跳与记忆整理使用，运行结束即销毁，不出现在 WebChat 列表中 | `~/.vex/sessions/runs/<id>.jsonl` |

各会话的对话历史互相独立；工作区、工具、配置全局共享。不同会话可以同时运行。

## 6. Agent 循环

### 6.1 消息处理

- **会话空闲**：组装上下文，调用 `agent.prompt()` 开始一轮循环（模型回复 → 工具调用 → 再回复，直到结束）。
- **会话运行中收到新消息**：作为插话，通过 pi 的 steering 队列在下一次模型调用前注入。
- **中断**：微信发 `/stop`，或网页点击停止按钮，调用 `agent.abort()` 结束当前轮。

### 6.2 输出

- WebChat：逐字流式显示回复，实时显示工具调用状态与子 agent 进度。
- 微信：一轮结束后发送完整回复；一轮运行超过 15 秒时先发送一条“处理中”提示。

### 6.3 上下文组装

每轮开始前，system prompt 依次由以下部分组成：

1. 基础指令（工具使用约定、工作区文件约定、记忆写入约定）
2. `SOUL.md`
3. `USER.md`
4. 情绪与作息描述（见 9）
5. `MEMORY.md`
6. Skills 清单（名称 + 简介 + 路径）
7. 当前日期时间、时段与来源窗口

随后是本会话的历史消息。

### 6.4 上下文压缩

通过 `transformContext` 实现：当历史 token 数超过当前模型上下文窗口的 70% 时：

1. **记忆抢救**：先在该会话上静默运行一轮，提示 agent 把本段对话中值得长期保留的信息追加到当天的 `memory/YYYY-MM-DD.md`。此轮输出不发送给主人。
2. **摘要替换**：把较早的消息交给模型生成摘要，用摘要替换这部分消息，保留最近若干轮原文。

压缩只影响送入模型的上下文，JSONL 文件保留完整原始记录。

### 6.5 持久化与恢复

每条消息完成时追加写入对应 JSONL；压缩摘要作为特殊条目写入。`vexd` 启动时从 JSONL 恢复微信与 WebChat 会话（从最近一次摘要开始重建上下文）。

## 7. 工具

### 7.1 核心内置工具

| 工具 | 说明 |
|---|---|
| `read` / `write` / `edit` | 文件读、写、精确替换编辑；相对路径基于工作区 |
| `bash` | 执行命令；工作目录默认工作区；只继承环境变量白名单（可用 `bashEnvPassthrough` 扩展） |
| `grep` / `find` | 内容搜索与文件查找 |
| `web_fetch` | 抓取网页并转为 Markdown；阻止访问内网地址 |
| `web_search` | 网页搜索，搜索服务在配置中指定 |
| `memory_search` | 检索记忆文件与历史对话（见 8.2） |
| `feel` | 记录一次短时情绪波动（见 9.2） |
| `schedule` | 创建、列出、删除定时投递（见 10.1） |
| `delegate` | 子 agent（见 7.4） |

天气、图片等能力以内置 Skill 形式提供（见 11）；浏览器等重型能力通过 MCP 接入。

### 7.2 MCP

`config.yaml` 的 `mcpServers` 声明服务，支持 stdio 与 Streamable HTTP。`vexd` 启动时连接，把每个 MCP 工具转换为 pi `AgentTool`，命名为 `mcp__<服务名>__<工具名>`。服务断开时自动重连；重连期间该服务的工具调用返回错误结果。

### 7.3 审批

每个工具有一个策略：

| 策略 | 行为 |
|---|---|
| `allow` | 直接执行 |
| `ask` | 挂起，等待主人批准 |
| `deny` | 不注册给模型 |

默认策略：

| 工具 | 默认 |
|---|---|
| `read`、`grep`、`find`、`web_fetch`、`web_search`、`memory_search`、`feel`、`schedule`、`delegate` | `allow` |
| `write`、`edit` | 目标路径在工作区内为 `allow`，工作区外为 `ask` |
| `bash` | `ask` |
| MCP 工具 | `ask` |

可在配置中按工具名覆盖（MCP 工具可按服务名整体覆盖）。

`ask` 流程在 `beforeToolCall` 中实现：

1. 生成审批请求（工具名、参数摘要、来源会话），推送到微信和所有在线 WebChat。
2. 主人回复：
   - WebChat：允许 / 本会话总是允许 / 拒绝
   - 微信：`/y`（允许）、`/ya`（本会话总是允许）、`/n`（拒绝），答复最早的一条待审批请求
3. 任一窗口首先给出的答复生效，其他窗口的提示同步失效。
4. 10 分钟未答复视为拒绝。拒绝时返回 `{ block: true, reason }`，模型收到拒绝原因后继续回复。

定时投递、心跳、记忆整理、子 agent 使用同一审批流程。

### 7.4 子 agent

`delegate(task: string, tools?: string[])`：

- 创建一个上下文为空的临时 pi `Agent`，system prompt 为基础指令、`SOUL.md` 加任务描述，工具集为指定子集（缺省为主 agent 工具集去掉 `delegate`）。
- 嵌套深度为 1：子 agent 不能调用 `delegate`。
- 继承审批策略。
- 只把子 agent 的最终回复文本作为工具结果返回给主 agent。
- 同一轮中的多个 `delegate` 调用借助 pi 的并行工具执行同时运行。
- 进度通过 `tool_execution_update` 推送给 WebChat。

## 8. 长期记忆

### 8.1 写入

agent 用 `write` / `edit` 直接维护工作区记忆文件，基础指令约定：

- 一次性的事实、事件、对话要点 → 追加到当天 `memory/YYYY-MM-DD.md`
- 关于主人的稳定认知 → `USER.md`
- 长期有效的事实与决定 → `MEMORY.md`
- 主人要求改变人设或行为准则 → `SOUL.md`

### 8.2 检索

`index/` 维护 `~/.vex/index.sqlite`：

- 索引对象：`memory/*.md`、`MEMORY.md`、`USER.md`，以及所有会话 JSONL 中的用户与助手消息。
- 分块：Markdown 按标题与段落切块；会话按单条消息切块。每块记录来源路径、日期、会话。
- 分词：入库与查询前在 JS 中把连续中日韩字符切成重叠双字，其余文本按词切分，存入 FTS5（`unicode61` 分词器）。
- 增量：`vexd` 启动时与每轮结束后，按文件修改时间与 JSONL 偏移量增量更新。
- 查询：`memory_search(query, limit?, scope?)`，`scope` 为 `memory`、`sessions` 或 `all`（默认），按 BM25 排序返回片段、来源与日期。

### 8.3 后台整理

调度器每天在 `memory.consolidateAt`（默认 03:00）启动一个临时会话运行整理任务：

1. 读取最近 7 天的每日笔记与当前 `MEMORY.md`、`USER.md`。
2. 把反复出现或明确重要的内容提炼进 `MEMORY.md` / `USER.md`。
3. 合并重复条目，删除已失效的条目，保持 `MEMORY.md` 在长度上限内。

整理只编辑工作区内文件，不需要审批；不向主人发送消息。

## 9. 情绪与作息

### 9.1 情绪数值

`persona/` 维护三个 0–100 的数值，持久化于 `~/.vex/state/mood.json`（原子写），微信与 WebChat 共用一份：

| 数值 | 初始值 | 随时间（无互动） | 每次主人发消息并得到回复 |
|---|---|---|---|
| 精力 `energy` | 80 | 每小时 −2 | +3 |
| 心情 `mood` | 70 | 每小时 −1.6 | +3.6 |
| 社交需求 `social` | 50 | 每小时 +5 | −15 |

- 衰减按读取时刻与上次更新时刻的真实时间差惰性计算，`vexd` 停机期间的时间同样计入。
- 休息时段内精力不衰减，改为每小时 +10。
- 数值始终截断在 0–100。

### 9.2 短时情绪

agent 通过 `feel(mood: number, energy?: number, reason: string, hours?: number)` 记录一次情绪波动，例如被夸奖、被冷落、完成了一件难事：

- `mood`、`energy` 为变化量，范围 −30 到 +30；`hours` 为持续时间，默认 2，最长 24。
- 波动强度在持续时间内线性衰减到 0，叠加在基础数值之上。
- 同时生效的短时情绪最多 5 条，超出时丢弃最早的一条。
- 存于 `mood.json`，过期条目在读取时清除。

### 9.3 作息

- 休息时段由 `persona.sleep`（默认 `["23:00", "07:00"]`）定义，可跨午夜。
- 休息时段内，system prompt 注明“现在是你的休息时间”，回复更困倦、更简短；主动聊天暂停。
- 主人在休息时段发消息仍会正常回复。

### 9.4 注入 prompt 的描述

每轮把当前数值转换为一段自然语言描述注入 system prompt（见 6.3），例如“有点疲惫，兴致不高，很想找人说话；还有些因为刚才被夸而残留的开心”。转换规则：

| 数值 | <20 | 20–49 | 50–80 | >80 |
|---|---|---|---|---|
| 精力 | 累到不想动 | 有点疲惫 | （不描述） | 精力充沛 |
| 心情 | 心情低落 | 兴致不高 | （不描述） | 心情很好 |
| 社交需求 | （不描述） | （不描述） | 有点想聊天 | 很想找人说话 |

短时情绪按当前强度描述为“强烈的 / 有些 / 淡淡的 + 原因”，强度低于原始值 10% 时不再描述。描述之后附一句约束：情绪只影响语气与话量，不影响完成主人请求的质量。

### 9.5 主动聊天

调度器每 `persona.outreach.checkEvery`（默认 30 分钟）检查一次，同时满足以下条件时发起：

- 不在休息时段
- 社交需求 > `persona.outreach.socialThreshold`（默认 70）
- 距主人最后一条微信消息已超过 `persona.outreach.quietHours`（默认 3 小时）
- 当天主动聊天次数 < `persona.outreach.dailyLimit`（默认 3）
- 微信会话当前空闲

发起方式：向微信会话投递一条标记为“主动聊天”的内部消息，提示 agent 结合当前情绪、时段与记忆自然地开启一个话题。该内部消息不发送给主人，agent 的回复发到微信并照常记入微信会话。

发出后 2 小时内主人没有回复，心情 −10；主人回复则按正常互动结算。

## 10. 调度器

调度器以 `croner` 解析时间规则，管理四类任务。

### 10.1 定时投递

定时任务的语义是“在指定时间向某个会话投递一条消息”。

- 任务字段：`id`、`name`（唯一）、`schedule`（cron 表达式 / 固定间隔 / 一次性时间点）、`prompt`、`target`（`wechat` 或某个 WebChat 会话 id）、`enabled`。
- 存储于 `~/.vex/schedules.json`（原子写）。
- 由 `schedule` 工具管理；`target` 缺省为调用时所在会话。
- 到点时把 `prompt` 作为一条标记为“定时任务”的消息投递到目标会话，走正常的消息处理流程（空闲则开始新一轮，运行中则作为插话）。回复自然出现在该会话中；WebChat 目标会话同时显示通知。
- 目标 WebChat 会话已删除时，改投微信。
- 一次性任务触发后自动停用；`vexd` 停机期间错过的一次性任务在启动时投递一条“错过的定时任务”消息到目标会话，然后停用。
- 同一任务上一次投递引发的轮次尚未结束时，跳过本次触发。

### 10.2 心跳

- 每 `heartbeat.every`（默认 30 分钟），在 `heartbeat.activeHours`（默认 08:00–22:00）内触发。
- `HEARTBEAT.md` 为空或只有空白时直接跳过，不调用模型。
- 否则在临时会话中运行一轮：agent 读取 `HEARTBEAT.md` 逐项检查；无需告知主人时回复 `HEARTBEAT_OK`。
- 回复为 `HEARTBEAT_OK` 时静默结束；否则把回复发到微信，并作为助手消息追加进微信会话，主人可直接回复跟进。

### 10.3 记忆整理

见 8.3。

### 10.4 主动聊天检查

见 9.5。

## 11. Skills

遵循 Agent Skills 标准：每个技能是一个目录，含带 `name` / `description` frontmatter 的 `SKILL.md`，可附带脚本与资源。

- 加载来源：包内置 `skills/`（天气、图片等）与工作区 `skills/`；同名时工作区优先。
- system prompt 只包含技能清单；模型需要时用 `read` 读取 `SKILL.md` 正文，用 `bash` 运行附带脚本。
- agent 可以在工作区 `skills/` 下编写新技能，下一轮生效。

## 12. 模型

基于 pi-ai 的模型注册表：

- **内置提供方**（DeepSeek、Kimi、MiniMax、智谱、千问、小米、OpenRouter 等 pi-ai 内置的提供方）：在 `model.provider` / `model.id` 中直接引用。模型 id 区分大小写，未收录的 id 解析失败并列出可用 id，不猜测协议。
- **自定义提供方**（StepFun、Ollama、自建代理等任意 OpenAI / Anthropic 兼容端点）：在 `providers.<名称>` 中声明 `api`（`openai-completions` 或 `anthropic-messages`）与 `baseUrl`，可选列出 `models`；列出时只接受列表中的 id，未列出时接受任意 id。
- **API key**：优先取 `providers.<名称>.apiKey`，其次取 pi-ai 约定的环境变量（如 `DEEPSEEK_API_KEY`）。

可分别为主对话与后台任务（压缩摘要、记忆整理、心跳、会话标题）指定模型。

## 13. 配置

唯一配置文件 `~/.vex/config.yaml`：

```yaml
model:
  provider: deepseek
  id: deepseek-v4-pro
  thinking: off
backgroundModel:          # 缺省与 model 相同
  provider: deepseek
  id: deepseek-flash
providers:
  deepseek:
    apiKey: <key>
  stepfun:
    api: openai-completions
    baseUrl: https://api.stepfun.com/v1
    apiKey: <key>
    models:
      - id: step-2-16k
        contextWindow: 16000
wechat:
  enabled: true           # 已绑定微信时默认开启
  ownerId: <主人微信 id>   # 缺省为扫码绑定的微信号
web:
  host: 127.0.0.1
  port: 7860
  token: <访问口令>
workspace: ~/.vex/workspace
webSearch:
  provider: <搜索服务>
  apiKey: <key>
tools:
  policy:
    bash: ask
    mcp__playwright: ask
bashEnvPassthrough: []
mcpServers:
  playwright:
    command: npx
    args: ["@playwright/mcp@latest"]
compaction:
  threshold: 0.7
memory:
  consolidateAt: "03:00"
heartbeat:
  every: 30m
  activeHours: ["08:00", "22:00"]
persona:
  sleep: ["23:00", "07:00"]
  outreach:
    enabled: true
    checkEvery: 30m
    socialThreshold: 70
    quietHours: 3
    dailyLimit: 3
```

人设、关于主人的信息不在配置中，而在工作区 `SOUL.md` / `USER.md`。

WebChat 设置页可读写该文件；修改后需重启才生效的项在页面上标注。`vex onboard` 引导生成初始配置、创建工作区模板，并可当场扫码绑定微信；之后也可随时运行 `vex wechat login` 绑定。

## 14. Gateway 与 WebChat

- 默认监听 `127.0.0.1`；远程访问需配置 `web.host` 并使用 `web.token` 口令登录（HttpOnly cookie）。
- WebSocket 协议由 `protocol/` 中的 TypeBox schema 定义：
  - 客户端 → vexd：发送消息、停止、新建/切换/重命名/删除会话、审批答复、读取/保存配置
  - vexd → 客户端：文本增量、消息完成、工具调用开始/结束、子 agent 进度、审批请求/失效、定时任务通知、错误
- 前端为服务端直接输出的单页应用，无前端构建步骤。

## 15. 数据目录

```
~/.vex/
├── config.yaml
├── workspace/
│   ├── SOUL.md
│   ├── USER.md
│   ├── MEMORY.md
│   ├── HEARTBEAT.md
│   ├── memory/YYYY-MM-DD.md
│   └── skills/
├── sessions/
│   ├── wechat.jsonl
│   ├── web/<id>.jsonl
│   └── runs/<id>.jsonl
├── index.sqlite
├── schedules.json
├── state/
│   └── mood.json    # 情绪数值、短时情绪、主动聊天计数
├── wechat/          # 微信登录态 credentials.json、最近的上下文 token state.json（均为 0600）
└── logs/
```

首次部署前清空旧版 `~/.vex/`。

## 16. 错误处理

| 场景 | 处理 |
|---|---|
| 模型调用失败 | 指数退避重试，最多 3 次；仍失败则把错误原因发回当前窗口 |
| 工具执行出错 | 作为错误工具结果返回模型，不中断本轮 |
| MCP 服务连接失败 | 跳过该服务并记录日志，`vexd` 正常启动，后台继续重连 |
| 微信长轮询断开 | 自动重连（指数退避，1 秒起，最长 60 秒） |
| 微信登录失效 | 停止轮询并记录日志，提示运行 `vex wechat login` 重新绑定 |
| WebSocket 断开 | 前端自动重连并重新拉取当前会话状态 |
| 审批超时 | 视为拒绝 |
| 心跳 / 整理 / 主动聊天失败 | 记录日志，等待下一次触发，不通知主人 |
| `mood.json` 损坏 | 记录警告，以初始值重建 |
| 检索索引损坏 | 删除 `index.sqlite` 并从工作区与会话文件全量重建 |
| 关闭 `vexd` | 依次中断运行中的会话、停止调度器、断开 MCP、关闭 HTTP 服务；单步失败不影响后续步骤 |

## 17. 测试

- Vitest，TDD（先写失败测试，再实现）。
- `core/` 与 `context/` 测试通过 pi 的 `streamFn` 注入脚本化假模型，覆盖完整循环、插话、中断、审批挂起/超时、压缩与记忆抢救、JSONL 恢复，无需真实 API。
- `index/` 测试在临时目录写入中英文混合的记忆文件与会话记录，验证增量索引与检索结果。
- `persona/` 测试使用可注入时钟，覆盖数值衰减（含停机时间与休息时段回升）、互动结算、短时情绪叠加与过期、跨午夜休息判断、描述生成、主动聊天的各项触发条件与未回复惩罚。
- `scheduler/` 测试使用可注入时钟，覆盖定时投递、错过补报、重叠跳过、心跳静默与上报、整理触发、主动聊天检查。
- `gateway/` 测试使用真实 HTTP 服务与 WebSocket 连接。
- `channels/wechat/` 测试对 iLink HTTP 接口使用本地假服务器。
- `tools/` 测试在临时目录中执行真实文件与 bash 操作；MCP 桥使用本地 stdio 假服务。
- `npm run lint`（`tsc --noEmit`）与 `npm test` 为提交门槛。
