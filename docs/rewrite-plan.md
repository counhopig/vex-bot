# Vex 架构重写方案

**状态**：项目上线前，无生产流量、无兼容性要求。目标架构定义于 [`architecture.md`](./architecture.md)。本方案是**一次性重写**的文件级操作清单，不是渐进式迁移计划——除非在文中特别标注为待验证的 schema 变更（见 Cron 一节），否则不保留过渡代码、不写适配层。

---

## 第零部分：归档策略

全部旧代码已通过 `git mv` 整体搬进 [`_archive/`](../_archive/README.md)（保留 git 历史），`src/`/`tests/` 现在是空目录，从零开始重建：

- `_archive/src/`、`_archive/tests/` = 旧架构原样保留，**只做参考，不参与 build/lint/CI**。
- 新代码**不允许**从 `_archive/` import 任何东西——它不是一个可依赖的 legacy 包，只是给人读的。
- 写每个新模块前，去 `_archive/src/<对应旧路径>` 读一遍旧实现，特别是安全相关逻辑（SSRF 防护、时序安全比较、路径穿越校验、原子写等）和旧测试文件里锁定的行为契约，然后在新位置**从零用 TDD 重新写**——不是 copy-paste，是理解后重新表达。
- 下表"当前文件"列的路径均指 `_archive/src/<path>`（原 `src/<path>`）。"删除"这个操作词在本文里统一表示"已随整体归档进 `_archive/`，新架构里没有对应文件计划"，不代表从磁盘上彻底抹除——历史仍在 git 里。

---

## 开始前确认

1. **根目录结构**：`src/`、`tests/`、`skills/`（bundled skills）、`docs/`、`scripts/`、`config.example.yaml`，构建产物 `dist/`。
2. **`src/` 一级子目录（重写前）**：`agents/ channels/ cli/ config/ cron/ extensions/ gateway/ hooks/ memory/ outbound/ pipeline/ plugins/ providers/ sessions/ skills/ tools/ types/ utils/ vendor/ web/`。
3. **框架/依赖**：原生 Express 4 + `ws`（原生 WebSocket）+ `better-sqlite3`（Web 用户/会话/Weixin 登录态）+ `@mariozechner/pi-agent-core`/`pi-ai`/`pi-coding-agent`（自研 pi 框架，LLM 调用引擎）+ `zod`（配置校验）+ `commander`（CLI）+ `playwright-core`（浏览器工具）+ `undici`（SSRF 加固后的 fetch）。前端无构建步骤，HTML/CSS/JS 以字符串模板内联。
4. **配置格式**：系统级 `config.local.yaml`（YAML + Zod schema）+ 用户级 SQLite `web_user_settings` 表覆盖，当前在 `web/config-handlers.ts` 里做浅合并——这正是目标架构里 `ConfigStore` 该做的事。

---

## 第一部分：文件级操作清单

### `src/agents/` → 拆解进 `src/agent/` + `src/dispatcher/`

| 当前文件 | 操作 | 新位置/新文件名 | 说明 |
|---|---|---|---|
| `src/agents/AGENTS.md` | 删除 | - | 目录级说明文档，随目录消失重写 |
| `src/agents/agent.ts` | 重写拆分 | `src/agent/Agent.ts` | 只保留 Agent 类本体；`createAgentCronExecutor`/`startCronService` 迁出到 cron 启动脚本 |
| `src/agents/index.ts` | 删除 | `src/agent/index.ts` | 重写为新 barrel |
| `src/agents/prompt-guides.ts` | 重写 | `src/agent/SystemPromptAssembler.ts` | System Prompt 第3段（工具规则），与 system-prompt.ts 合并 |
| `src/agents/runtime.ts` | 重写 | `src/agent/AgentRuntime.ts` | pi-coding-agent 封装、session 锁、streaming、hook 埋点 |
| `src/agents/system-prompt.ts` | 重写 | `src/agent/SystemPromptAssembler.ts` | `DEFAULT_IDENTITY`/`omitDefaultIdentity` 逻辑保留 |
| `src/agents/user-runtime.ts` | **删除，在新位置重写** | `src/agent/AgentRegistry.ts` | ✅ **已完成**（TDD，10 测试）。消灭 `globalAgent`/`UserRuntimeManager` 二元分裂本身；缓存键改为 `(userId, channelId)` 复合键，不再是纯 `userId` |

### `src/gateway/` → 拆解进 `src/dispatcher/` + `src/outbound/` + `src/web/`

| 当前文件 | 操作 | 新位置/新文件名 | 说明 |
|---|---|---|---|
| `src/gateway/server.ts` | **删除，拆三份重写** | 见右 | (1) `handleMessage`/`getAgentForContext`/`getContextWebUserId` → `src/dispatcher/Dispatcher.ts`；(2) `sendReply` → 并入 `src/outbound/OutboundDeliver.ts`；(3) Express 启动、路由挂载、频道生命周期编排、`MessageDeduplicator`、`createKeyedSerializer`、shutdown 步骤 → `src/web/server.ts` |

### `src/channels/`

| 当前文件 | 操作 | 新位置/新文件名 | 说明 |
|---|---|---|---|
| `src/channels/AGENTS.md` | 删除 | - | - |
| `src/channels/index.ts` | 删除 | `src/channels/index.ts` | 重写为新 barrel |
| `src/channels/common/base.ts` | 重写 | `src/channels/ChannelAdapter.ts` | 接口定义 + 基类 |
| `src/channels/common/index.ts` | 重写 | `src/channels/ChannelRegistry.ts` | ⚠️ **复审修正**：最初误放进 `src/dispatcher/`，但 `OutboundDeliver`（发送）、`web/server.ts`（per-user 动态频道生命周期）都要查同一张表，若挂在 dispatcher/ 下会造成 Outbound 反向依赖 Dispatcher。归位到 `channels/`，并扩展支持 `getChannelForUser(userId, channelId)` 的 per-user 查法 |
| `src/channels/weixin/adapter.ts` | 重写 | `src/channels/wechat/WeChatChannel.ts` | polling loop 保留，message handler 改为直接调 `dispatcher.dispatch(ctx)` |
| `src/channels/weixin/client.ts` | 重写 | `src/channels/wechat/WeChatClient.ts` | `WeixinApiError`/`assertOkEnvelope` 保留 |
| `src/channels/weixin/index.ts` | 删除 | `src/channels/wechat/index.ts` | 重写为新 barrel |
| `src/channels/weixin/login.ts` | 重写 | `src/channels/wechat/WeChatLogin.ts` | QR 登录流程保留 |

### `src/dispatcher/`（新增目录）

| 当前文件 | 操作 | 新位置/新文件名 | 说明 |
|---|---|---|---|
| （无） | 新建 | `src/dispatcher/Dispatcher.ts` | 见 gateway/server.ts 拆分；另需 `dispatchSynthetic()` 方法供 Cron 触发合成消息（见数据流验证场景二） |

### `src/outbound/`

| 当前文件 | 操作 | 新位置/新文件名 | 说明 |
|---|---|---|---|
| `src/outbound/index.ts` | 重写 | `src/outbound/OutboundDeliver.ts` | `deliverMessage`/`sendText`/超时保护保留；吸收 gateway 里按 webUserId 找专属频道的逻辑，依赖 `channels/ChannelRegistry.ts` |

### `src/pipeline/`

| 当前文件 | 操作 | 新位置/新文件名 | 说明 |
|---|---|---|---|
| `src/pipeline/index.ts` | **删除，在新位置重写** | `src/agent/Pipeline.ts` | 从进程全局 `Map` 注册表改为每 Agent 一份实例 |

### `src/agent/persona/`（原 `src/extensions/persona/`）

| 当前文件 | 操作 | 新位置/新文件名 | 说明 |
|---|---|---|---|
| `src/extensions/persona/index.ts` | **删除，在新位置重写** | `src/agent/persona/Persona.ts` | buildPrompt/observeResponse 保留；不再需要 `webchat:${ownerId}` 式 owner-key Map，因为 Persona 现在是 Agent 的直属字段 |
| `src/extensions/persona/config.ts` | 重写 | `src/agent/persona/PersonaConfig.ts` | 默认值表保留，但硬编码默认人格"小忆/温柔少女"删除——Persona 必须 opt-in |
| `src/extensions/persona/models.ts` | 保留迁移 | `src/agent/persona/models.ts` | 纯类型定义 |
| `src/extensions/persona/storage.ts` | 重写 | `src/agent/persona/PersonaStorage.ts` | 整合 storage/ 子模块 + todos/effects/reflection/consolidation |
| `src/extensions/persona/storage/{emotion,history,index,profile,todos}.ts` | 保留迁移 | `src/agent/persona/storage/{...}.ts` | 原样搬迁 |
| （无） | 新建 | `src/agent/persona/PersonaBuilder.ts` | 拼装 system prompt Section 1 的独立职责 |

### `src/extensions/skilllearner/` → 拆解进 `src/skills/`

| 当前文件 | 操作 | 新位置/新文件名 | 说明 |
|---|---|---|---|
| `src/extensions/skilllearner/index.ts` | **删除，拆解重写** | `src/skills/learner/SkillLearner.ts` | 归属 Skills，不是独立扩展；自动触发关键词检测变成 Agent 自己 Pipeline 里的 interceptor |
| `src/extensions/skilllearner/models.ts` | 保留迁移 | `src/skills/learner/models.ts` | - |
| `src/extensions/skilllearner/storage.ts` | 保留迁移 | `src/skills/learner/storage.ts` | - |

### `src/extensions/sharelink/` → 拆解进 `src/tools/builtin/`

| 当前文件 | 操作 | 新位置/新文件名 | 说明 |
|---|---|---|---|
| `src/extensions/sharelink/index.ts` | **删除，拆解重写** | `src/tools/builtin/sharelink/index.ts` | `sharelink_parse` 工具 + 自动检测 interceptor，由 Agent 构造时注册进自己的 Pipeline |
| `src/extensions/sharelink/registry-factory.ts` | 保留迁移 | `src/tools/builtin/sharelink/registry-factory.ts` | - |
| `src/extensions/sharelink/platforms/{base,bilibili,registry,youtube}.ts` | 保留迁移 | `src/tools/builtin/sharelink/platforms/{...}.ts` | - |
| `src/extensions/common/json-store.ts` | 保留迁移 | `src/utils/json-store.ts` | 通用 JSON 文件存储引擎，persona/skilllearner 共用 |
| `src/extensions/index.ts` | 删除 | - | "扩展统一初始化"概念消失 |

### `src/memory/`

| 当前文件 | 操作 | 新位置/新文件名 | 说明 |
|---|---|---|---|
| `src/memory/AGENTS.md` | 删除 | - | - |
| `src/memory/index.ts` | 重写 | `src/memory/index.ts` | barrel |
| `src/memory/manager.ts` | 重写 | `src/memory/MemoryManager.ts` | remember/recall/list/forget/formatForContext |
| `src/memory/store.ts` | 重写 | `src/memory/JsonMemoryStore.ts` | 原子写（temp+rename）保留 |
| `src/memory/embedding.ts` | 重写 | `src/memory/embedding/SimpleEmbedding.ts` | FNV-1a 无状态哈希保留；✅ **已完成**：内部 tokenize 已替换为 CJKTokenizer |
| `src/memory/types.ts` | 保留迁移 | `src/memory/types.ts` | - |
| （无） | ✅ **新建完成** | `src/memory/tokenizer/Tokenizer.ts` + `CJKTokenizer.ts` | TDD 完成（6 测试）。文档第4条设计原则要求的 bigram fallback，此前代码库完全没有对应实现 |

### `src/tools/`

| 当前文件 | 操作 | 新位置/新文件名 | 说明 |
|---|---|---|---|
| `src/tools/AGENTS.md` | 删除 | - | - |
| `src/tools/index.ts` | 重写 | `src/tools/index.ts` | barrel |
| `src/tools/types.ts` | 保留迁移 | `src/tools/types.ts` | - |
| `src/tools/common.ts` | 保留迁移 | `src/tools/common.ts` | - |
| `src/tools/registry.ts` | 重写 | `src/tools/ToolRegistry.ts` | register/get/filterByPolicy 保留 |
| （无） | **不新建** | `src/tools/ToolExecutor.ts` | 决定：不造空壳文件。执行继续委托给 pi-coding-agent，删除现状里不做事的 `executeToolCalls` 占位函数 |
| `src/tools/builtin/index.ts` | 重写 | `src/tools/builtin/index.ts` | `createBuiltinTools` 保留 |
| `src/tools/builtin/{filesystem,bash,browser,web,image,process-registry,process-tool,apply-patch,cron,memory,weather,system}.ts` | 保留迁移 | 同名，原样搬迁 | 所有安全加固逻辑（SSRF 防护、per-owner 隔离、路径穿越防护等）原样保留，非可选项 |
| `src/tools/builtin/sharelink.ts` | 重写 | 并入 `src/tools/builtin/sharelink/index.ts` | 见上 |

### `src/skills/`

| 当前文件 | 操作 | 新位置/新文件名 | 说明 |
|---|---|---|---|
| `src/skills/AGENTS.md` | 删除 | - | - |
| `src/skills/index.ts` | 重写 | `src/skills/index.ts` | barrel |
| `src/skills/types.ts` | 保留迁移 | `src/skills/types.ts` | - |
| `src/skills/parser.ts` | 保留迁移 | 并入 `src/skills/SkillLoader.ts` | SKILL.md frontmatter 解析 |
| `src/skills/loader.ts` | 重写 | `src/skills/SkillLoader.ts` | 三层发现（bundled→user→workspace）+ 覆盖优先级 |
| `src/skills/registry.ts` | 重写 | `src/skills/SkillRegistry.ts` | getAll/get |
| （无） | 新建 | `src/skills/SkillInjector.ts` | 从 registry.ts 的 `buildPrompt()` 拆出"注入"职责 |

### `src/config/`

| 当前文件 | 操作 | 新位置/新文件名 | 说明 |
|---|---|---|---|
| `src/config/index.ts` | 拆分重写 | `src/config/schema.ts` + `src/config/resolvers/YamlLoader.ts` | Zod schema 与"读 config.local.yaml"分离 |
| （从 `web/auth.ts` 拆出） | 重写迁移 | `src/config/resolvers/SqliteLoader.ts` | 只包含 `getUserConfigSettings`/`isWebAuthEnabled`（读 `web_user_settings` 表）。⚠️ **复审修正**：`listUserWeixinLogins` **不**放这里，见下 |
| （从 `web/config-handlers.ts` 拆出） | 重写迁移 | `src/config/ConfigStore.ts` | `buildUserEffectiveConfig` 就是 `ConfigStore.resolve(userId, channelId) → EffectiveConfig` 本体 |
| （无） | 新建 | `src/config/EffectiveConfig.ts` | 原 `VexConfig` 类型改名迁移；`getConfigWritePath`/`__configPath` 的非枚举属性 hack 收编为 ConfigStore 内部显式字段 |

### `src/web/`

| 当前文件 | 操作 | 新位置/新文件名 | 说明 |
|---|---|---|---|
| `src/web/AGENTS.md` | 删除 | - | - |
| `src/web/index.ts` | 重写 | `src/web/index.ts` | barrel |
| `src/web/auth.ts` | **拆分重写** | 见右 | 登录/注册/限流/时序安全比较 → `src/web/routes/auth.ts`（`HttpError` 模式保留，真实防护非可选）；SQLite 用户配置读取 → `config/resolvers/SqliteLoader.ts`；⚠️ **复审修正**：`listUserWeixinLogins`（weixin 登录凭证：token/accountId/baseUrl）留在 `src/web/WeixinCredentialStore.ts`，**不**归入 config/ —— 这是频道启动凭证，不是"配置覆盖"，架构文档对 Config Resolution 的定义里没有它 |
| `src/web/config-handlers.ts` | **拆分重写** | 见右 | 合并逻辑 → `config/ConfigStore.ts`；HTTP/WS 管理端点 → `src/web/routes/config.ts` |
| `src/web/websocket.ts` | **删除，拆四份重写** | 见右 | (1) WebChat 协议翻译 → `src/channels/webchat/WebChatChannel.ts`；(2) 会话列表/重置 → `src/web/routes/sessions.ts`；(3) 管理端配置/用户操作 → `src/web/routes/admin.ts`；(4) Weixin QR 登录控制面板操作 → `src/web/routes/weixin-login.ts`；(5) 日志订阅（已 admin 门控）→ `src/web/routes/log-stream.ts` |
| `src/web/static.ts` | 重写迁移 | `src/web/static/index.ts` | CSP/安全响应头/路径穿越防护保留 |
| `src/web/template-client.ts` | 重写迁移 | `src/web/static/client.ts` | 内联前端 JS |
| `src/web/template-css.ts` | 重写迁移 | `src/web/static/styles.ts` | 内联前端 CSS |
| `src/web/assets/{marked.min.js,vex-mascot.png}` | 保留迁移 | `src/web/static/assets/{...}` | - |
| `src/web/i18n.ts` | 保留迁移 | `src/web/static/i18n.ts` | - |
| `src/web/log-stream.ts` | 保留迁移 | `src/web/routes/log-stream.ts` | tail pino 日志文件实现保留 |
| `src/web/types.ts` | 保留迁移 | `src/web/types.ts` | WS frame 类型 |

### `src/providers/`

| 当前文件 | 操作 | 新位置/新文件名 | 说明 |
|---|---|---|---|
| `src/providers/index.ts` | 重写 | `src/providers/index.ts` | barrel |
| `src/providers/metadata.ts` | 保留迁移 | `src/providers/ProviderMetadata.ts` | 15 供应商元数据表 |
| `src/providers/model-resolver.ts` | **保留统一设计，不拆分** | `src/providers/ModelResolver.ts` | 决定：不拆成每供应商一个 `XxxProvider.ts` 类。多数供应商是同构的 OpenAI-compatible 端点，统一 resolver 更合理；只需让它实现 `ProviderInterface` |
| `src/providers/llm.ts` | 保留迁移 | `src/providers/llmComplete.ts` | 一次性 LLM 调用工具 |
| `src/cli/fetch-patch.ts` | **重写，挪出 cli 目录** | `src/providers/fetch-compat.ts` | 非 ASCII 响应头补丁是 provider 层兼容问题，与 CLI 无关 |

### `src/cron/`、`src/plugins/`、`src/hooks/`、`src/sessions/`（架构文档未覆盖，但都是真实产品能力）

| 当前文件 | 操作 | 新位置/新文件名 | 说明 |
|---|---|---|---|
| `src/cron/AGENTS.md` | 删除 | - | - |
| `src/cron/{executor,schedule,service,store,types,index}.ts` | 保留迁移，重写调用方 | `src/cron/`（目录不变） | 真实被 Persona 的 `emotionDecayCron`/`reflectionPeriodicCron`/`proactiveNudgeCron` 依赖，不是旧包袱。⚠️ **需要 schema 变更（未仅是搬文件）**：读过 `cron/types.ts` 确认 `CronJob` **没有 `ownerId` 字段**，`CronServiceDeps.executeJob` 在 `createCronExecutor()` 构造时只绑定**一个**闭包——这是单租户设计，`globalAgent` 消失后无法支持"每个用户自己的 Persona 各自的 cron 任务"。需要：`CronJob` 新增 `ownerId?: string`；执行路径改为 Cron 通过 `Dispatcher.dispatchSynthetic()` 回调触发（Cron 本身不 import Agent/AgentRegistry，只依赖 Dispatcher 暴露的这一个薄接口，避免 Agent→Cron→Agent 式的循环依赖） |
| `src/plugins/{discovery,loader,service,index}.ts` | 保留迁移，重写调用方 | `src/plugins/`（目录不变） | `buildPluginApi()` 挂接新 Dispatcher/AgentRegistry/ConfigStore，而非旧 globalAgent |
| `src/hooks/index.ts` | 保留迁移，重写埋点调用处 | `src/hooks/index.ts` | 事件总线本体不变；emit 调用点挪到 Dispatcher.dispatch/Agent.processMessage/OutboundDeliver |
| `src/sessions/{store,title,types,index}.ts` | 保留迁移 | `src/sessions/`（目录不变） | UI 会话列表存储，与 pi SessionManager 双写但各自权威的设计不变 |

### `src/cli/`

| 当前文件 | 操作 | 新位置/新文件名 | 说明 |
|---|---|---|---|
| `src/cli/index.ts` | 重写 | `src/cli/index.ts` | start/stop/restart/config/status 等操作型命令保留，改为调用 Dispatcher/ConfigStore/web/server.ts bootstrap。**已核实**：`chat` 命令（228-325行）是不经过 Agent/Persona/Tools 的裸模型连通性自测（`tools: []`），本质是运维诊断工具，原样保留在 cli/ 里，**不**拆成 CliChannel——架构图画的"CLI 频道"目前没有对应实现，如果要做是新建，不是迁移 |
| `src/cli/onboard.ts` | 重写 | `src/cli/onboard.ts` | 生成的配置结构对齐新 schema |

### `src/utils/`、`src/vendor/`、`src/types/`

| 当前文件 | 操作 | 新位置/新文件名 | 说明 |
|---|---|---|---|
| `src/utils/index.ts` | 保留迁移 | `src/utils/index.ts` | generateId/delay/retry |
| `src/utils/logger.ts` | 保留迁移 | `src/utils/logger.ts` | - |
| `src/utils/path.ts` | 保留迁移 | `src/utils/path.ts` | - |
| `src/utils/qr.ts` | 重写迁移 | `src/channels/wechat/qr.ts` | 只被 WeChat 登录使用，挪到该频道目录下 |
| `src/vendor/qrcodegen.ts` | 保留迁移 | `src/vendor/qrcodegen.ts` | 第三方 vendor 代码，与架构层无关 |
| `src/types/index.ts` | **拆分重写**（具体映射，复审时补全） | 见右 | `InboundMessageContext`/`OutboundMessage`/`ChannelId`/`ChatType`/`SendResult`/`ChannelMeta`/`ChannelCapabilities` → `channels/ChannelAdapter.ts`；`VexConfig`及各`*Config` → `config/EffectiveConfig.ts`/`schema.ts`；`ModelDefinition`/`ModelApi`/`ProviderId`/`SimpleProviderConfig` → `providers/ProviderMetadata.ts`/`ProviderInterface.ts`；`ChatMessage`/`MessageContent`/`MessageToolCall` → `agent/messages.ts`；`VexError`/`ProviderError`/`ChannelError` → 各自模块内联，不再有跨模块错误基类文件 |

---

## 第二部分：新目录结构

```
src/
├── agent/
│   ├── Agent.ts                    # 核心 Agent 类：持有 persona/tools/skills/memory/pipeline
│   ├── AgentRuntime.ts             # pi-coding-agent 封装：session 锁、streaming、hook 埋点
│   ├── AgentRegistry.ts            # ✅ 已完成：getOrCreate(userId, channelId, config)，无 globalAgent
│   ├── SystemPromptAssembler.ts    # 五段式 prompt 组装
│   ├── Pipeline.ts                 # 每 Agent 一份实例
│   ├── messages.ts                 # ChatMessage 等公共消息类型
│   ├── index.ts
│   └── persona/
│       ├── Persona.ts
│       ├── PersonaConfig.ts        # opt-in，无硬编码默认人格
│       ├── PersonaBuilder.ts
│       ├── PersonaStorage.ts
│       ├── models.ts
│       └── storage/{emotion,history,profile,todos,index}.ts
│
├── channels/
│   ├── ChannelAdapter.ts           # 接口 + InboundMessageContext/OutboundMessage 等公共类型
│   ├── ChannelRegistry.ts          # getChannel / getChannelForUser（per-user 动态频道）
│   ├── wechat/
│   │   ├── WeChatChannel.ts
│   │   ├── WeChatClient.ts
│   │   ├── WeChatLogin.ts
│   │   ├── qr.ts
│   │   └── index.ts
│   ├── webchat/
│   │   └── WebChatChannel.ts       # 从 websocket.ts 拆出的纯频道部分
│   └── index.ts
│
├── dispatcher/
│   └── Dispatcher.ts               # 唯一入口；dispatch() + dispatchSynthetic()（供 Cron 使用）
│
├── memory/
│   ├── MemoryManager.ts
│   ├── JsonMemoryStore.ts
│   ├── types.ts
│   ├── embedding/SimpleEmbedding.ts    # ✅ 已接入 CJKTokenizer
│   ├── tokenizer/
│   │   ├── Tokenizer.ts            # ✅ 已完成
│   │   └── CJKTokenizer.ts         # ✅ 已完成
│   └── index.ts
│
├── tools/
│   ├── ToolRegistry.ts
│   ├── types.ts / common.ts / index.ts
│   └── builtin/
│       ├── index.ts
│       ├── filesystem.ts / bash.ts / browser.ts / web.ts / image.ts
│       ├── process-registry.ts / process-tool.ts / apply-patch.ts
│       ├── cron.ts / memory.ts / weather.ts / system.ts
│       └── sharelink/{index,registry-factory}.ts + platforms/{base,bilibili,youtube,registry}.ts
│
├── skills/
│   ├── SkillLoader.ts / SkillRegistry.ts / SkillInjector.ts
│   ├── types.ts / index.ts
│   └── learner/{SkillLearner,models,storage}.ts
│
├── config/
│   ├── ConfigStore.ts
│   ├── EffectiveConfig.ts
│   ├── schema.ts
│   └── resolvers/{YamlLoader,SqliteLoader}.ts
│
├── outbound/
│   └── OutboundDeliver.ts
│
├── providers/
│   ├── ProviderInterface.ts
│   ├── ProviderMetadata.ts
│   ├── ModelResolver.ts            # 统一 resolver，不拆分每供应商类
│   ├── llmComplete.ts
│   ├── fetch-compat.ts
│   └── index.ts
│
├── cron/                            # 目录结构不变；⚠️ CronJob 需新增 ownerId（见第一部分）
│   ├── executor.ts / schedule.ts / service.ts / store.ts / types.ts / index.ts
│
├── plugins/                         # 目录不变，重写调用方
│   ├── discovery.ts / loader.ts / service.ts / index.ts
│
├── hooks/
│   └── index.ts
│
├── sessions/
│   ├── store.ts / title.ts / types.ts / index.ts
│
├── web/
│   ├── server.ts                   # Express/HTTP bootstrap + 频道生命周期编排
│   ├── WeixinCredentialStore.ts    # listUserWeixinLogins（凭证，非配置）
│   ├── types.ts
│   ├── routes/
│   │   ├── auth.ts / config.ts / sessions.ts / admin.ts / weixin-login.ts / log-stream.ts
│   └── static/
│       ├── index.ts / client.ts / styles.ts / i18n.ts
│       └── assets/{marked.min.js,vex-mascot.png}
│
├── cli/
│   ├── index.ts                    # 含 chat 诊断命令，调用 web/server.ts bootstrap
│   └── onboard.ts
│
├── vendor/
│   └── qrcodegen.ts
│
└── utils/
    ├── index.ts / logger.ts / path.ts / json-store.ts
```

---

## 第三部分：关键接口定义

```typescript
// ============================================================
// src/channels/ChannelAdapter.ts
// ============================================================

export type ChannelId = "weixin" | "webchat";
export type ChatType = "direct" | "group";

export interface InboundMessageContext {
  channelId: ChannelId;
  messageId: string;
  chatId: string;
  chatType: ChatType;
  senderId: string;
  senderName?: string;
  content: string;
  mediaUrls?: string[];
  replyToId?: string;
  mentions?: string[];
  timestamp: number;
  /** Set by Dispatcher after resolving the (channel, sender) → web user mapping. */
  webUserId?: string;
  raw?: unknown;
}

export interface OutboundMessage {
  chatId: string;
  content: string;
  replyToId?: string;
  mediaUrls?: string[];
  mentions?: string[];
}

export interface SendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export interface ChannelAdapter {
  readonly id: ChannelId;
  readonly meta: ChannelMeta;

  initialize(): Promise<void>;
  shutdown(): Promise<void>;

  sendMessage(message: OutboundMessage): Promise<SendResult>;
  replyToContext(ctx: InboundMessageContext, text: string): Promise<SendResult>;

  isHealthy(): Promise<boolean>;

  /** Registers the single callback Dispatcher uses to receive messages from this channel. */
  onMessage(handler: (ctx: InboundMessageContext) => Promise<void>): void;
}

export interface ChannelMeta {
  id: ChannelId;
  name: string;
  description: string;
  capabilities: ChannelCapabilities;
}

export interface ChannelCapabilities {
  chatTypes: ChatType[];
  supportsMedia: boolean;
  supportsReply: boolean;
  supportsMention: boolean;
  supportsReaction: boolean;
  supportsThread: boolean;
  supportsEdit: boolean;
  maxMessageLength: number;
}

/**
 * Channel lookup, shared by Dispatcher, Outbound, and web/server.ts's
 * lifecycle management. Lives in channels/ (not dispatcher/) precisely
 * because Outbound needs it too, and neither Dispatcher nor Outbound
 * should import from the other.
 */
export interface ChannelRegistry {
  register(channel: ChannelAdapter): void;
  unregister(channelId: ChannelId): void;
  getChannel(channelId: ChannelId): ChannelAdapter | undefined;
  getAllChannels(): ChannelAdapter[];

  /** Per-user dynamic instances (e.g. a user's own WeChat login), scoped
   *  on top of the flat registry above. Falls back to getChannel() when
   *  no per-user instance is registered. */
  registerForUser(userId: string, channelId: ChannelId, channel: ChannelAdapter): void;
  unregisterForUser(userId: string, channelId: ChannelId): void;
  getChannelForUser(userId: string, channelId: ChannelId): ChannelAdapter | undefined;
}


// ============================================================
// src/dispatcher/Dispatcher.ts
// ============================================================

import type { ConfigStore } from "../config/ConfigStore.js";
import type { AgentRegistry } from "../agent/AgentRegistry.js";
import type { InboundMessageContext, ChannelId } from "../channels/ChannelAdapter.js";

export interface OutboundMessage {
  channelId: ChannelId;
  webUserId?: string;
  ctx: InboundMessageContext;
  text: string;
}

export class Dispatcher {
  constructor(
    private readonly configStore: ConfigStore,
    private readonly agentRegistry: AgentRegistry,
    private readonly deliver: (msg: OutboundMessage) => Promise<void>, // OutboundDeliver, injected
  ) {}

  private resolveUserId(ctx: InboundMessageContext): string { throw new Error("stub"); }

  async dispatch(ctx: InboundMessageContext): Promise<void> {
    const userId = this.resolveUserId(ctx);
    const config = await this.configStore.resolve(userId, ctx.channelId);
    const agent = await this.agentRegistry.getOrCreate(userId, ctx.channelId, config);
    const response = await agent.processMessage({ ...ctx, webUserId: userId });
    await this.deliver({ channelId: ctx.channelId, webUserId: userId, ctx, text: response.content });
  }

  /** Synthetic entry point for Cron (and other non-channel triggers). Cron
   *  depends on this one method, never on Agent/AgentRegistry directly —
   *  keeps the dependency direction one-way. */
  async dispatchSynthetic(ctx: Omit<InboundMessageContext, "messageId" | "timestamp">): Promise<void> {
    return this.dispatch({ ...ctx, messageId: `synthetic-${Date.now()}`, timestamp: Date.now() });
  }
}


// ============================================================
// src/agent/Agent.ts
// ============================================================

import type { Persona } from "./persona/Persona.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { SkillsRegistry } from "../skills/SkillRegistry.js";
import type { MemoryManager } from "../memory/MemoryManager.js";
import type { Pipeline } from "./Pipeline.js";
import type { EffectiveConfig } from "../config/EffectiveConfig.js";
import type { InboundMessageContext } from "../channels/ChannelAdapter.js";

export interface AgentResponse {
  content: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  provider: string;
  model: string;
}

export class Agent {
  readonly persona: Persona | null;   // null = bare tool executor (opt-in persona)
  readonly tools: ToolRegistry;
  readonly skills: SkillsRegistry;
  readonly memory: MemoryManager | undefined;
  readonly pipeline: Pipeline;        // per-Agent instance, not process-global

  constructor(
    private readonly ownerId: string,
    private readonly config: EffectiveConfig,
    deps: {
      persona: Persona | null;
      tools: ToolRegistry;
      skills: SkillsRegistry;
      memory?: MemoryManager;
      pipeline: Pipeline;
    },
  ) {
    this.persona = deps.persona;
    this.tools = deps.tools;
    this.skills = deps.skills;
    this.memory = deps.memory;
    this.pipeline = deps.pipeline;
  }

  async processMessage(ctx: InboundMessageContext): Promise<AgentResponse> { throw new Error("stub"); }
  async *processMessageStream(ctx: InboundMessageContext): AsyncGenerator<string, AgentResponse, unknown> { throw new Error("stub"); }

  async shutdown(): Promise<void> { throw new Error("stub"); }
}

/** Factory — the only place that wires Persona/Tools/Skills/Memory/Pipeline together. */
export async function createAgent(userId: string, channelId: string, config: EffectiveConfig): Promise<Agent> { throw new Error("stub"); }


// ============================================================
// src/agent/persona/Persona.ts
// ============================================================

import type { PersonaConfig } from "./PersonaConfig.js";
import type { PersonaStorage } from "./PersonaStorage.js";
import type { MemoryManager } from "../../memory/MemoryManager.js";
import type { InboundMessageContext } from "../../channels/ChannelAdapter.js";

export class Persona {
  constructor(
    readonly config: PersonaConfig,
    private readonly storage: PersonaStorage,
    private readonly memory: MemoryManager | undefined, // delegated, not owned
  ) {}

  /** Section 1 of the system prompt. Always prepended — Persona is identity,
   *  seen before tools/skills/output-format, never appended. */
  async buildPrompt(ctx: InboundMessageContext): Promise<string> { throw new Error("stub"); }

  /** Post-turn: update emotion/history/profile, fire-and-forget from Agent's Pipeline observer. */
  async observeResponse(ctx: InboundMessageContext, replyText: string): Promise<void> { throw new Error("stub"); }
}


// ============================================================
// src/config/EffectiveConfig.ts
// ============================================================

export interface EffectiveConfig {
  readonly userId: string;
  readonly channelId: string;
  providers: Record<string, { baseUrl?: string; apiKey?: string; headers?: Record<string, string> }>;
  agent: {
    defaultModel: string;
    defaultProvider: string;
    temperature: number;
    maxTokens: number;
    workingDirectory: string;   // always scoped per-user by ConfigStore, never user-overridable
  };
  memory?: { enabled: boolean; directory: string };
  skills?: { enabled: boolean; userDir?: string; workspaceDir?: string; disabled?: string[]; only?: string[] };
  persona?: PersonaConfigOverrides;  // absent = disabled, per "opt-in Persona"
  sharelink?: { enabled: boolean; [key: string]: unknown };
  weather?: { [key: string]: unknown };
}

type PersonaConfigOverrides = Record<string, unknown>;


// ============================================================
// src/agent/Pipeline.ts
// ============================================================

import type { InboundMessageContext } from "../channels/ChannelAdapter.js";

export type PromptInjector = (ctx: InboundMessageContext) => Promise<string>;
export type MessageInterceptor = (ctx: InboundMessageContext) => Promise<string | null>;
export type ResponseObserver = (ctx: InboundMessageContext, replyText: string) => Promise<void>;

/** One instance per Agent — created in the Agent factory, torn down with it. */
export class Pipeline {
  private readonly injectors: PromptInjector[] = [];
  private readonly interceptors: MessageInterceptor[] = [];
  private readonly observers: ResponseObserver[] = [];

  registerPromptInjector(fn: PromptInjector): void { this.injectors.push(fn); }
  registerInterceptor(fn: MessageInterceptor): void { this.interceptors.push(fn); }
  registerObserver(fn: ResponseObserver): void { this.observers.push(fn); }

  async gatherPromptInjections(ctx: InboundMessageContext): Promise<string[]> { throw new Error("stub"); }
  async runInterceptors(ctx: InboundMessageContext): Promise<string | null> { throw new Error("stub"); }
  async runObservers(ctx: InboundMessageContext, reply: string): Promise<void> { throw new Error("stub"); }
}
```

---

## 第四部分：数据流验证

### 场景一：WebChat 用户发送"你好"

```
WebChatChannel.onMessage(wsRawMessage)
  → InboundMessageContext { channelId: "webchat", chatId: "webchat:user123", senderId: "user123", content: "你好", timestamp }

  → dispatcher.dispatch(ctx)
      → userId = this.resolveUserId(ctx)
      → config = await configStore.resolve(userId, "webchat")
          → YamlLoader.load() → 系统默认值
          → SqliteLoader.load(userId) → web_user_settings 覆盖
          → 合并 → EffectiveConfig（persona 缺失时为 undefined → Agent 以裸工具执行器运行）

      → agent = await agentRegistry.getOrCreate(userId, "webchat", config)
          → 命中缓存直接返回；未命中 → createAgent(userId, "webchat", config)
              → persona = config.persona ? new Persona(...) : null
              → tools/skills/memory/pipeline 组装，含 sharelink 工具 + 其 interceptor

      → response = await agent.processMessage(ctx)
          → intercepted = pipeline.runInterceptors(ctx)（例如 sharelink 自动检测到链接则短路）
          → personaBlock = persona?.buildPrompt(ctx) ?? DEFAULT_IDENTITY
          → memoryEntries = memory?.recall(ctx.content) ?? []
          → skillsBlock = skills.injector.inject()
          → systemPrompt = SystemPromptAssembler.assemble({ persona, environment, tools, skills, outputFormat })
          → llmResponse = AgentRuntime.chat(systemPrompt, ctx.content, tools)（内部走 pi-coding-agent 工具循环）
          → pipeline.runObservers(ctx, llmResponse.content) → persona?.observeResponse(...)

      → await this.deliver({ channelId: "webchat", webUserId: userId, ctx, text: response.content })

  → OutboundDeliver.send(text, "webchat", userId)
      → channel = channelRegistry.getChannelForUser(userId, "webchat") ?? channelRegistry.getChannel("webchat")
      → channel.sendMessage({ chatId: ctx.chatId, content: text })

  → WebChatChannel.sendMessage({ text }) → 通过 WS 推给对应连接
```

### 场景二：WeChat（per-user 动态频道 + Cron 触发）

```
WeChatChannel(userId="counhopig" 专属实例).onMessage(polledPayload)
  → InboundMessageContext { channelId: "weixin", senderId: "o9cq800ta...", content: "提醒我开会" }
  → dispatcher.dispatch(ctx) → ... → 若触发 cron_add 工具：
      → CronService.add({ ownerId: "counhopig", schedule, payload: {kind:"agentTurn", ...} })
  → deliver(...) → OutboundDeliver.send(text, "weixin", "counhopig")
      → channelRegistry.getChannelForUser("counhopig", "weixin")  // 命中该用户自己扫码登录的子频道实例

--- 一小时后，cron 触发 ---
CronService.onTimer(job)   // job.ownerId = "counhopig"
  → dispatcher.dispatchSynthetic({ channelId: "weixin", senderId: "cron-system", webUserId: job.ownerId, content: job.payload.message })
      → 内部走 configStore.resolve → agentRegistry.getOrCreate → agent.processMessage → deliver(...)
```

两条流水线验证：(1) Persona/Memory/Skills/Pipeline 全收拢在 `Agent.processMessage` 内部，Dispatcher 全程不知道它们存在；(2) `ChannelRegistry` 放在 `channels/` 后，Dispatcher、Outbound、Cron 触发的合成消息都能查到正确的频道实例；(3) Cron 通过 `Dispatcher.dispatchSynthetic` 回调，不直接 import Agent/AgentRegistry，避免循环依赖。

---

## 第五部分：清理清单

### 目录整体删除

- `src/agents/` — 拆进 `src/agent/` + `src/dispatcher/`
- `src/gateway/` — 拆进 `src/dispatcher/`、`src/outbound/`、`src/web/server.ts`
- `src/extensions/` — persona → `agent/persona/`；skilllearner → `skills/learner/`；sharelink → `tools/builtin/sharelink/`；common/json-store.ts → `utils/`
- `src/channels/common/` — 合并进 `src/channels/ChannelAdapter.ts` + `ChannelRegistry.ts`
- `src/channels/weixin/` — 改名为 `src/channels/wechat/`

### 配置文件

- 没有遗留的旧配置格式需要删除（现状本就只认 `.yaml`）。需要清理的是 `__configPath` 非枚举属性 hack，收编为 `ConfigStore` 内部显式字段。

### 测试文件（`tests/` 现有 44 个文件）

**必须整体重写**（测的是即将消失的类/边界）：

`tests/user-runtime.test.ts`（→ 已被 `tests/agent-registry.test.ts` 取代）、`gateway-server.test.ts`、`pipeline.test.ts`、`hooks-wiring.test.ts`、`extensions.test.ts`、`persona-webchat-unified.test.ts`、`persona-memory-directive.test.ts`、`persona-profile-building.test.ts`、`plugin-api.test.ts`、`plugin-startup.test.ts`、`plugins.test.ts`、`websocket-sessions.test.ts`、`control-settings.test.ts`、`control-ui-regression.test.ts`、`agent-cron.test.ts`、`cron.test.ts`、`cron-executor.test.ts`、`cron-add-tool.test.ts`（ownerId schema 变更）、`outbound.test.ts`、`weixin-adapter.test.ts`、`weixin-persistence.test.ts`、`config.test.ts`、`shared-config.test.ts`、`web-auth.test.ts`（部分）。

**可保留大部分逻辑**（纯函数/工具级，换个 import 路径即可）：

`utils.test.ts`、`llm.test.ts`、`qr.test.ts`、`weather-tool.test.ts`、`providers.test.ts`、`memory.test.ts`、`memory-tools-isolation.test.ts`、`apply-patch-tool.test.ts`、`bash-tool.test.ts`、`filesystem-tool.test.ts`、`browser-tool.test.ts`、`image-tool.test.ts`、`process-isolation.test.ts`、`web-tools.test.ts`、`static-assets.test.ts`、`system-prompt.test.ts`、`skills.test.ts`、`tools.test.ts`、`agent-tools.test.ts`、`session-title.test.ts`、`sessions.test.ts`、`log-stream.test.ts`、`runtime.test.ts`。

---

## 第六部分：重写后的测试策略

**最小测试覆盖集**（当前完全没有对应实现/测试的新契约）：

1. ✅ `tests/tokenizer.test.ts` — CJKTokenizer bigram fallback。**已完成**（6 测试）。
2. ✅ `tests/agent-registry.test.ts` — 并发共享构建、idle-TTL、LRU overflow、dispose-before-rebuild、`(userId, channelId)` 复合键正确隔离。**已完成**（10 测试）。
3. `dispatcher/Dispatcher.test.ts` — mock `ConfigStore`/`AgentRegistry`/`deliver`，验证 `dispatch()`/`dispatchSynthetic()` 端到端路径。
4. `channels/ChannelRegistry.test.ts` — `getChannelForUser` 命中 per-user 实例、未命中回退默认实例。
5. `cron/CronService.test.ts` 新增 `ownerId` 分发用例 — 同进程两个不同 `ownerId` 的 job 各自触发各自的 Dispatcher 合成调用，互不串号。
6. `agent/persona/Persona.test.ts` — 反向断言：`config.persona` 缺失时 `Agent.persona === null`，系统提示不含任何硬编码人格身份。

**推荐顺序**：先做无外部依赖的纯逻辑（1、4、6），再做需要计时器/并发的（2、5），最后做依赖前面所有模块的集成验证（3）。

---

## 进度记录

| 模块 | 状态 | 备注 |
|---|---|---|
| 归档（`_archive/`） | ✅ 完成 | 旧 `src/`（113 文件）+ `tests/`（48 文件）整体 `git mv` 保留历史；`src/`、`tests/` 现为空目录 |
| `memory/tokenizer/{Tokenizer,CJKTokenizer}.ts` | ✅ 完成 | TDD, 11 tests, tsc clean。Latin 按空格分词+小写，CJK 3+字拆重叠 bigram，混合文本组合策略 |
| `agent/AgentRegistry.ts` | ✅ 完成 | TDD, 16 tests, tsc clean。Generic over entry type T, (userId,channelId) 复合键, 无 globalAgent, 并发构建共享 / idle-TTL / LRU / dispose-before-rebuild / reset / shutdown |
| `config/ConfigStore.ts` + `config/resolvers/{YamlLoader,SqliteLoader}.ts` | ✅ 完成 | TDD, 9 tests, tsc clean。Zod schema, YAML 加载验证, SQLite 用户配置读取, 3层 merge (defaults→YAML→SQLite), resolve(userId,channelId) |
| `dispatcher/Dispatcher.ts` + `channels/ChannelAdapter.ts`（类型定义部分） | ✅ 完成 | TDD, 6 tests, tsc clean。dispatch(ctx) + dispatchSynthetic()，resolveUserId, ConfigStore+AgentRegistry+deliver 编排 |
| `agent/Agent.ts` / `agent/persona/Persona.ts` | 待开始 | 最大的一块，建议拆多轮 TDD |
| `channels/ChannelRegistry.ts` | 待开始 | |
| 其余模块 | 待开始 | 见第一部分完整清单 |

下一步：`channels/ChannelRegistry.ts`——`getChannelForUser` 命中 per-user 实例、未命中回退默认实例。然后 `agent/Agent.ts` + `agent/persona/Persona.ts`（最大模块）。
