# Vex

Vex 是只服务一个主人的个人 AI 助手。守护进程 `vexd` 常驻运行，通过微信 ClawBot 和浏览器 WebChat 对话；两个入口共享工作区、长期记忆、工具审批与情绪状态，各自保留独立的聊天历史。

## 功能

- WebChat 多会话、流式回复、插话、中断、自动标题与历史恢复。
- 微信扫码绑定、主人身份校验、长任务提示和工具审批。
- 文件读写、命令执行、网页抓取、Brave 搜索和 FTS5 记忆检索。
- 上下文压缩、压缩前记忆抢救、每日笔记与后台记忆整理。
- 定时投递、心跳检查、情绪作息及主动聊天。
- MCP 工具接入、隔离的子 Agent、动态 Skills，以及内置天气和图片理解技能。

## 安装与启动

需要 Node.js 24 或更新版本。`better-sqlite3` 如无法使用预编译包，安装时需要本地 C/C++ 编译工具。

```bash
git clone git@github.com:counhopig/vex-bot.git
cd vex-bot
npm ci
npm run build

node dist/cli/index.js onboard
node dist/cli/index.js start -d
```

配置向导选择模型提供方、模型、API key 和网页端口，也可当场扫码绑定微信。默认 WebChat 地址为 `http://127.0.0.1:7860`。

也可运行 `npm link`，随后使用 `vex` 代替 `node dist/cli/index.js`。

## 命令

| 命令 | 说明 |
|---|---|
| `vex onboard [--force]` | 生成配置与工作区；覆盖已有配置需要 `--force` |
| `vex start` | 前台启动 |
| `vex start -d` | 后台启动 |
| `vex stop` | 停止守护进程 |
| `vex status` | 查看运行状态 |
| `vex logs [-f]` | 查看日志；`-f` 持续输出 |
| `vex wechat login` | 扫码绑定微信，重启后生效 |

微信指令：`/stop` 中断当前回复；`/y` 允许最早的待审批请求；`/ya` 在当前会话中总是允许该工具；`/n` 拒绝。审批同时推送到微信与在线网页，首个答复生效，10 分钟未答复自动拒绝。

## 配置

默认配置文件为 `~/.vex/config.yaml`。WebChat 设置页可以编辑配置，修改后重启生效。

最小配置：

```yaml
model:
  provider: minimax-cn
  id: MiniMax-M2.7
providers:
  minimax-cn:
    apiKey: "填写你的 API key"
```

内置提供方和模型以安装版本的 pi-ai 注册表为准，模型 ID 区分大小写。API key 优先读取 `providers` 配置，其次读取提供方约定的环境变量；程序不会自动加载 `.env`。

可选配置示例（与上面的配置合并）：

```yaml
web:
  host: 127.0.0.1
  port: 7860
wechat:
  enabled: true
  # ownerId: "主人微信 ID；默认使用扫码用户"
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
tools:
  policy:
    bash: ask
    mcp__browser: ask
bashEnvPassthrough: []
webSearch:
  provider: brave
  apiKey: "填写 Brave Search API key"
mcpServers:
  local:
    command: node
    args: ["/absolute/path/to/mcp-server.js"]
  remote:
    url: "https://example.com/mcp"
```

`backgroundModel` 可按 `model` 的格式单独配置，用于标题、压缩摘要、心跳和记忆整理；缺省与主模型相同。自定义提供方示例：

```yaml
model:
  provider: custom
  id: your-model
providers:
  custom:
    api: openai-completions
    baseUrl: "https://example.com/v1"
    apiKey: "填写你的 API key"
    models:
      - id: your-model
        contextWindow: 32000
        maxTokens: 4096
```

自定义接口支持 `openai-completions` 和 `anthropic-messages`。声明 `models` 时只接受列表中的 ID。

远程访问必须设置 `web.token`。工具策略为 `allow`、`ask` 或 `deny`；默认工作区内写入直接允许，工作区外写入、bash 与 MCP 工具需要审批。bash 只继承环境变量白名单，额外变量须通过 `bashEnvPassthrough` 明确放行。

## 工作区与数据

默认数据目录为 `~/.vex`，可以通过 `VEX_HOME` 改为独立实例：

```bash
export VEX_HOME=/absolute/path/to/vex-data
node dist/cli/index.js onboard
node dist/cli/index.js start -d
```

该实例的所有后续命令须使用同一 `VEX_HOME`。`workspace` 配置可以单独指定工作区。

```text
~/.vex/
├── config.yaml
├── workspace/
│   ├── SOUL.md              # 人设与行为准则
│   ├── USER.md              # 关于主人的稳定认知
│   ├── MEMORY.md            # 长期事实与决定
│   ├── HEARTBEAT.md         # 心跳检查清单；空文件不调用模型
│   ├── memory/YYYY-MM-DD.md # 每日笔记
│   └── skills/              # 自定义技能
├── sessions/               # 微信、网页及后台运行记录
├── index.sqlite            # 可重建的检索索引
├── schedules.json          # 定时任务
├── state/mood.json         # 情绪与主动聊天状态
├── wechat/                 # 登录凭证与同步状态
└── logs/vexd.log
```

直接编辑工作区 Markdown 文件即可调整人设、认知与检查清单，下一轮读取最新内容。压缩只改变模型上下文，原始聊天记录仍保留。

## 定时任务与 Skills

通过聊天请求创建、列出或删除定时任务。`schedule` 支持 cron、固定间隔（如 `30m`）和带时区的一次性 ISO 时间点。默认投递到当前会话，网页目标已删除时回退微信；停机期间错过的一次性任务会在启动后补报。

技能目录包含带 `name`、`description` frontmatter 的 `SKILL.md`，可附带脚本。工作区 `skills/` 的同名技能覆盖内置技能。内置天气技能查询天气，图片技能调用支持图片输入的已配置模型进行分析；脚本执行遵循 bash 审批。

`web_search` 需要 Brave API key，也可使用 `BRAVE_API_KEY` 环境变量。MCP 支持 stdio 和 Streamable HTTP，工具命名为 `mcp__<服务名>__<工具名>`。`delegate` 使用独立上下文执行任务，继承审批，禁止再次委派。

## 开发与验证

```bash
npm run dev
npm run lint
npm test
npm run build
```

测试使用脚本化模型和本地假服务，无需真实模型、微信或 MCP 凭证。设计与分阶段实现计划位于 [docs/superpowers](docs/superpowers)。
