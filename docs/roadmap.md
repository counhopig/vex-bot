# Vex 演进路线

Vex 目前是一个服务单个 owner 的个人助手：一个 `vexd` 进程同时服务微信和 WebChat，两边共用工作区、工具、配置和审批队列。本路线规划 Vex 从内部实验走向产品的几个阶段，参照 DeepSeek Harness 团队的《Super-agent 设计探索》（2026-10-31）和开源原型 `deepseek-ai/dsh-superagent-prototype`。

## 原则

- **少占用人的注意力。** 只有当 owner 需要知道、需要做决定，或者明确在等结果时，Vex 才说话。主动发起的运行沿用现有的安静规则：没有 owner 加入的运行不发起审批（`policy/gate.ts`）；主动聊天出错或没有回复时不打扰 owner（`quietSources`）；是否通知 owner 由带类型的工具来上报（`heartbeat_report`）。
- **对话不阻塞。** 微信会话只负责和 owner 交流以及分派任务；耗时的工作交给后台执行，执行期间 owner 可以随时插话。
- **一人一实例。** 配置里只有一个 `wechat.ownerId` 和一个工作区，部署单位是一个 Docker 容器加一个 `/data` 卷。产品形态是每个用户一个实例，托管或自部署都可以，不做多租户。上下文的边界就是实例的边界。
- **外部内容是不可信输入。** 网页、文件、MCP 结果和未来的外部事件都按数据处理，不当作指令执行，也不能绕过审批。

## 当前约束

| 约束 | 位置 | 影响 |
|------|------|------|
| `delegate` 是同步调用，等子 Agent 完成后才返回 | `tools/delegate.ts` | 子任务运行期间，主会话的这一轮一直不结束 |
| steering 消息在一批工具调用全部完成后才被读取；`bash` 单次最长 600 秒 | pi-agent-core agent loop、`tools/bash.ts` | 长时间运行的工具会让 owner 的新消息一直排队 |
| 主动行为的来源只有定时任务、heartbeat、主动聊天、Wiki 和记忆整理，各自走独立的代码路径 | `scheduler/`、`persona/outreach.ts` | 没有统一的事件模型，接入新的外部来源需要单独实现 |
| `memory_search` 只返回文本片段，不带可以继续追溯的 ID | `index/memory.ts` | 模型无法从一条记忆追到对应的运行或任务 |
| trace 只保留 7 天 | `trace/store.ts` | 运行历史不能作为长期记忆 |
| 有三十多个模块直接读写本机文件系统 | 遍布 `src/` | 状态与本机耦合，计算和状态暂时无法分离部署 |
| 微信主动发消息依赖 owner 最近一条消息带来的 `contextToken` | `channels/wechat/channel.ts` | 主动聊天和后台任务通知能否送达取决于这个 token |

## 阶段一：后台任务

owner 交代一件耗时的事情后，对话立刻恢复；任务在后台执行，完成后结果回到发起它的对话里。

### 工具

`background_task` 只在交互会话中提供，支持三个动作：

| 动作 | 参数 | 结果 |
|------|------|------|
| `start` | `title`、`task` | 立即返回任务 id，当前这一轮随即结束 |
| `list` | — | 正在运行的任务：id、标题、发起会话、开始时间 |
| `stop` | `id` | 中止该任务；结果不再投递 |

适合用后台任务的工作：调研、批量读写文件、长时间运行的命令，以及其他需要较多步骤的事情。需要马上用到结果的短子任务继续用 `delegate`。

### 执行

- 每个任务运行在一个临时会话 `run:<任务 id>` 中，使用主模型。任务开始时没有对话历史，`task` 文本需要写得自包含。
- 系统提示词包含 `SOUL.md`、`USER.md`、`MEMORY.md`、工作区路径、可用工具和 `task` 运行档位。
- 可用工具是交互会话的工具去掉 `background_task`，后台任务不能再开新的后台任务。
- 任务由 owner 亲自交代，所以审批照常进行：请求出现在微信和每个打开的 WebChat 窗口，窗口标签为 `background task "<标题>"`，十分钟内没有回答则视为拒绝。
- 同时运行的任务最多 3 个；超过时 `start` 返回错误。
- 每个任务都有自己的 trace，来源记为 `background task`，可以在 WebChat 的 Traces 页面查看。

### 投递

任务结束时，运行时向发起任务的会话发送一条来源为 `background task` 的消息，由该会话的模型用平常的口吻转告 owner：

- 完成：`[Background task "<标题>" finished]`，后面附上任务的最终回复。
- 失败：`[Background task "<标题>" failed]`，后面附上失败原因。

owner 用 `stop` 中止的任务不投递。daemon 停止时，正在运行的任务会被中止，也不投递；任务不跨重启保留。

## 阶段二：基于 trace 的 Watchdog

定时运行的临时会话，检查最近的 trace：有没有出错、被中断、微信没送达、耗时异常，以及 heartbeat 或 Wiki 连续失败。检查分两层：先由程序筛选，只有发现异常时才调用模型分析原因，再通过一个带类型的上报工具决定是否通知 owner。另外提供一个只读的 trace 查询工具，owner 可以直接问「昨晚的定时任务为什么没发」。

## 阶段三：统一 Trigger 与只记录模式

把定时任务、heartbeat、主动聊天、Wiki 通知和后台任务完成统一成 Trigger 记录，trace 的 `source` 字段是这里的起点。新的外部来源（邮件、日历、RSS，通过 MCP 或轮询接入）统一走三步：程序准入、模型判断、执行行动，以 `links/actions.ts` 的分级判断为模板。新规则默认只记录不执行，WebChat 展示「如果开启，它会做什么」，由 owner 确认后再开启。

## 阶段四：可追溯的召回

`memory_search` 的结果附带运行 id 和任务 id，再提供按 id 读取 trace 和任务摘要的工具，模型可以沿着引用逐跳追溯：从一条消息找到当时的后台任务，再找到它修改过的文件。

## 暂缓

- **Router 批处理与分片。** 单个 owner 的事件频率很低，运行中途到达的消息已经通过 steering 合并进当前的运行。
- **计算与状态分离部署。** 这需要先把所有状态的读写收拢到 `store/` 之后。新增的状态一律通过 `store/` 读写。

## 产品化前要确认的事项

- 微信 iLink `contextToken` 的有效期，以及 iLink 对主动发消息的限制。
- 主动行为的打扰程度：`persona.outreachSent(replied)` 已经记录了主动聊天之后 owner 有没有回复；把它统计成指标，用来定主动行为的默认阈值。
- 安全能力作为对外的卖点：unattended 运行拒绝需要审批的工具、Landlock 沙箱、trace 中的密钥脱敏、`web_fetch` 拦截内网地址。
