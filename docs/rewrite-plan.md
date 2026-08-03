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
| `src/providers/metadata.ts` | 保留迁移 | `src/providers/ProviderMetadata.ts` | 17 供应商元数据表（15 primary + 2 custom-*；PROVIDER_IDS 17 与归档 config schema 验证契约一致，PRIMARY_PROVIDER_IDS 15 用于 UI drop-down） |
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
| `config/ConfigStore.ts` + `config/resolvers/{YamlLoader,SqliteLoader}.ts` | ✅ 完成（web/ part 5 复审时修过一次 schema 缺陷） | TDD, 9 tests, tsc clean。Zod schema, YAML 加载验证, SQLite 用户配置读取, 3层 merge (defaults→YAML→SQLite), resolve(userId,channelId)。**缺陷记录**：最初审查时没发现 `schema.ts` 漏了 `channels`/`sessions`/`skillLearner`/`sharelink`/`weather` 几个 section（Zod 默认丢弃未声明的 key，这几个 section 在 YAML 加载时会被静默丢弃，`channels.weixin` 永远读不到，WeChat 频道永远起不来），`memory` 也丢了"省略时默认开启"的 archive 历史修复。`web/` part 5（commit `bd11b57`）里补上了，逐 section diff 过 archive 确认完全一致。 |
| `dispatcher/Dispatcher.ts` + `channels/ChannelAdapter.ts`（类型定义部分） | ✅ 完成 | TDD, 6 tests, tsc clean。dispatch(ctx) + dispatchSynthetic()，resolveUserId, ConfigStore+AgentRegistry+deliver 编排 |
| `agent/Agent.ts` + `agent/Pipeline.ts` + `agent/persona/{Persona,PersonaConfig,PersonaStorage,PersonaBuilder}.ts` | ✅ 完成 | TDD, 31 tests (+4 review fixes). Agent: persona-present → DEFAULT_IDENTITY 不注入 (2026-07-17 竞争人格 bug 修复). Pipeline: per-hook try/catch + 30s 超时 (拦截器错误隔离). Persona: opt-in, 无硬编码默认人格. |
| `agent/SystemPromptAssembler.ts` | ✅ 完成 | TDD, 7 tests, tsc clean。5段式 prompt 组装，persona vs DEFAULT_IDENTITY 互斥分支，Agent.ts 已重构使用。 |
| `channels/ChannelRegistry.ts` | ✅ 完成 | TDD, 9 tests, tsc clean。ChannelRegistryImpl: 平面 + per-user 双层查找，getChannelForUser 回退到 flat getChannel |
| `outbound/OutboundDeliver.ts` | ✅ 完成 | TDD, 6 tests, tsc clean。通过 ChannelRegistry 投递(flat + per-user fallback)，sendWithTimeout 超时保护，error 不抛出（纯返回值）。 |
| `providers/{ProviderMetadata,ModelResolver,ProviderInterface,fetch-compat}.ts` | ✅ 完成 | TDD, 168 tests total, tsc clean。ProviderMetadata: 17 entries table (provider-metadata.test.ts, 16 tests). ModelResolver: class-based API (ModelResolver.init/resolveModel/getApiKeyForProvider/isProviderAvailable/getAllRegisteredModels), 3 步解析路径 (China table → pi-ai getModel → dynamic fallback), custom-openai/custom-anthropic 独立分支 (model-resolver.test.ts, 57 tests). ProviderInterface: LLMProvider/ChatMessage/ChatResponse 类型. fetch-compat: 非 ASCII 响应头补丁 (从 cli/fetch-patch.ts 迁出). |

| `agent/{AgentRuntime,createDefaultPiSession,messages}.ts` + `Agent.ts` 接入 runtime | ✅ 完成 | TDD, 22 new tests (190 total), tsc clean。AgentRuntime: class-based, per-instance sessions + per-key lock chain (archive 记录的并发同 session 事故), chat(systemPrompt, ctx) 非流式, session key 派生 (direct=channel:sender, group=channel:chat), session 复用, createPiSession 工厂注入。createDefaultPiSession: 真实 pi-coding-agent 集成, authStorage 同时 set config.provider + model.provider (custom-anthropic 风格代理需要), fallback resolver 兜底。messages.ts: ChatMessage/ChatResponse/ChatRole/ChatUsage, provider 边界从 messages.ts re-export。Agent.ts: ChatFn DI 移除, runtime dep 接入, processMessage 调 runtime.chat(finalPrompt, ctx), AgentResponse 透传 reply.provider/model/usage。 |
| `tools/{types,common,ToolRegistry}.ts` + `tools/builtin/*` | ✅ 完成 | TDD, 116 new tests (306 total), tsc clean。Tool type 直接使用 pi-coding-agent 的 ToolDefinition（execute 5参匹配）, Tool 别名保持兼容。ToolRegistry: class-based（非进程全局），register/get/getAll/filterByPolicy/clear，deny 优先于 allow，group: 前缀展开。common.ts: JSON/text/error/image 结果构建器 + 4 类 param reader + truncation。builtin: 13 文件全部从 archive 重写移植，安全逻辑原样保留——web.ts SSRF (isBlockedAddress/IPv4 + IPv6 + metadata host + DNS rebinding + per-hop redirect 重校验)、filesystem.ts 路径穿越 (realpath + isRealPathAllowed)、browser.ts per-owner 浏览器实例隔离 + SSRF 重校验、process-registry.ts per-ownerKey session 隔离、bash.ts 环境变量最小泄露 (BASE_ENV_ALLOWLIST)。AgentRuntimeConfig 新增 customTools 字段，AgentRuntime.getOrCreateSession 对新 session 应用 setTools。 |
| `skills/{types,SkillLoader,SkillRegistry,SkillInjector}.ts` | ✅ 完成 | TDD, 18 new tests (328 total), tsc clean。types.ts: SkillEntry/SkillFrontmatter/SkillsConfig 纯类型定义。SkillLoader.ts: parseSkillContent (纯同步解析器，YAML frontmatter + Markdown body，支持 moltbot 兼容 metadata.openclaw.requires)，loadAllSkills (3-tier 发现 bundled→user→workspace，优先级覆盖、eligibility 过滤、disabled/only 配置过滤、dedup)。SkillRegistry.ts: class-based (非进程全局)，register/get/getAll/load。SkillInjector.ts: buildPrompt 从 registry 构建技能提示词段。 |
| `cron/{types,store,schedule,service,executor}.ts` | ✅ 完成 | TDD, 57 new tests (398 total), tsc clean。types.ts: CronSchedule (at/every/cron) + CronPayload (systemEvent/agentTurn) + **CronJob 新增 ownerId?** 字段。store.ts: CronStore class（**非单例**，archive 的 getCronService 移除），原子 JSON write + backup。schedule.ts: 纯函数 computeNextRunAtMs (5/6-field parser)。service.ts: CronService class（非单例，非 process-global），setTimeout re-arming 调度循环，超时保护 (withTimeout)，一次性任务 at 完成后自动 disable/delete，错过任务 missed 事件，**ownerId 在 add() 时持久化**。executor.ts: agentTurn 通过注入的 dispatcher callback 触发（**不直接 import Agent/AgentRegistry**），ownerId 作为 webUserId 传入 InboundMessageContext，channelId 用 webchat（无 cron ChannelId）。 |
| `hooks/{types,EventBus,index}.ts` | ✅ 完成 | TDD, 22 new tests (422 total), tsc clean。types.ts: HookEvent 判别联合 (message_received/sending/sent, agent_start/end, tool_start/end, error) + HookHandler 类型。EventBus.ts: **class-based** (archive 是 module-level Map，违反 principle 5；新设计用 class 但保留 defaultBus 实例用于 app-wide hooks)，subscribe/unsubscribe/subscribeMany/emit/emitSync/clear/handlerCount，emit 中隔离 handler 错误。index.ts: barrel + 便利 emit* 函数（emitMessageReceived/.../emitError），委托给 defaultBus.emitSync()。**Wiring**：emitMessageReceived 在 Dispatcher.dispatch/dispatchSynthetic；emitMessageSending/emitMessageSent 在 OutboundDeliver.sendText（覆盖成功/失败/异常三个分支）；emitAgentStart/emitAgentEnd 在 Agent.processMessage 的 runtime.chat 周围（finally 保证错误时也触发 agent_end）。tool_start/tool_end 暂未连线——需要在 PiAgent 接口增加 setBeforeToolCall/setAfterToolCall 然后 wire 到 pi-coding-agent 的 hook，留待后续 plugins/ 模块一起处理。 |

| `sessions/{types,store,title,index}.ts` | ✅ 完成 | TDD, 29 new tests (451 total), tsc clean。**Class-based, no process-global singleton**（archive 的 `getSessionStore`/`initSessionStore` 模块级实例不再导出，违反 principle 5；改为 `FileSessionStore` 类，per-user 实例化，storePath 构造函数参数控制每用户目录，默认 `~/.vex/sessions/`）。`store.ts`: atomic JSON write (temp+rename), `WriteLock` async mutex 保护 read-modify-write, `recoverIndexFromTranscripts()` 双形态扫描（flat `<sessionId>.jsonl` + nested pi-coding-agent `sanitizeSessionKey` 目录 `weixin_<sender>.jsonl/`），`#canonicalizeSanitizedKey` 还原 `channel:sender` 键。`appendTranscript` 一次性把 header+message 写入和 index 增量原子化，messageCount + usage 累加，model/provider 首次出现即记录。`delete()` 真正从磁盘 unlink transcript 文件（archive F3：不能 rename 成 `.deleted.*` 留尾巴），`isPathInside` 防越界。`title.ts`: `sanitizeTitle` 纯函数（拆 ASCII/CJK 引号 + markdown fence + 空白折叠 + 截断），`generateSessionTitle` 注入式 LLM 调用（不依赖 ModelResolver/pi-ai 内部，调用方 web bootstrap 注入；未注入返回 null 让 caller 走降级）。`types.ts`: `SessionEntry`/`SessionListItem`（新增 `provider` 字段反映到 sidebar UI）/`TranscriptMessage`/`TranscriptHeader`/`SessionListOptions`。`index.ts` barrel，明确**不**导出 archive 的全局 getter/setter。`src/sessions/` 整体最独立（不依赖其它未做模块），与下一阶段的 `web/routes/sessions.ts` 集成点：调用方传 `users/{userId}/sessions` 路径获得 per-user 隔离。
| `memory/{MemoryManager,JsonMemoryStore,types}.ts` | ✅ 完成 | TDD, 31 new tests (531 total), tsc clean。**Class-based, no process-global singleton**：`MemoryManager` per-Agent 实例化，`createMemoryManager` 工厂返回全新实例（archive 无模块级单例，保持一致）。**⚠️ 复审时发现并修正的文档偏差**：第一部分表格和进度表都标注 `embedding/SimpleEmbedding.ts` "✅ 已完成"，但实际 `src/memory/` 下只有 `tokenizer/`，`SimpleEmbedding` 从未存在——`MemoryManager` 构造函数硬依赖它，本轮一并补上（无状态 FNV-1a 哈希保留，内部 tokenize 按方案要求替换为 CJKTokenizer，使 CJK 文本按 bigram 落槽而非塌缩成单 token）。`types.ts`: `MemoryEntry`/`MemoryStore`/`MemoryListFilter`/`MemoryStoreStatus`/`EmbeddingProvider` 纯类型迁移（index.json 持久化契约，不得漂移）。`JsonMemoryStore.ts`: 原子写（temp+rename，只读 index.json 测试证明 rename 只需目录写权限）、`isValidEntry` 加载校验（拒绝手改/半写索引的脏 entry）、keyword search、`clear()` unlink 而非写空文件、`cosineSimilarity` 导出。`MemoryManager.ts`: `remember`（embedding 失败降级为无向量存储，不抛错）/`recall`（混合打分 vector*0.7+text*0.3，永不 throw）/`get`/`forget`/`list`/`clearAll`/`formatForContext`（`## Relevant Memories` 段）/`enabled` 开关（false 时 remember→null、其余→空/false，归档契约保留）。**接口点检查（coder-prompt 要求）**：`tools/builtin/memory.ts` 的本地 `MemoryManager`/`MemoryEntry` 接口替换为从真实模块 type-only import，`remember` 返回类型对齐为 `Promise<string | null>`（disabled 分支）；真实实例直接满足 `MemoryToolsOptions.manager`，无需转换层。`plugins/` 的 `MemoryManagerLike`（`(...args: never[]) => unknown` 任意签名）天然满足。集成验证：`tests/memory-tools-isolation.test.ts` 证明两套工具集各自绑定自己的 manager、无 manager 的工具集保持 disabled、真实 MemoryManager 直插可用。下一步：`web/`。 |
| `plugins/{types,discovery,loader,service,index}.ts` | ✅ 完成 | TDD, 49 new tests (500 total), tsc clean。**No process-global singleton**（archive 的 `let pluginRegistry: Map<string, LoadedPlugin>`、`let defaultService` 全部去掉，违反 principle 5）。`PluginService` 类，每个实例独占 `Map<string, LoadedPlugin>`，per-(user, channel) 隔离天然落地：`ToolRegistry`/`EventBus` 通过 `PluginRuntimeDeps` 注入（不是模块级 import），所以 plugin A 注册的 tool/hook 不会泄漏到 plugin B 的运行时。`types.ts`: `PluginMeta`/`PluginDefinition`/`PluginApi`/`PluginCandidate`/`LoadedPlugin`/`PluginEnableConfig`（含 archive 同款 allow/deny/slots/entries 五段决策链，外加 `per-entry enabled:true` 优先于 slot 匹配的 F-archive 标记保留）。`discovery.ts`: 3-tier 文件系统扫描（bundled→global→workspace→config 路径后写覆盖），`runtimeCanImportTs()` 决定 .ts 入口是否可用（`await import(fileUrl)` 是 plugin 加载的标准例外，注释里写明），`scanPluginDirectory` 三阶段 manifest/package.json/default-entry fallback。`loader.ts`: class-free；`resolveEnableState` 8 段纯函数；`sortByDependencies` 递归拓扑 + visited 循环守卫；`loadPlugins(candidates, deps, registry)` 显式接 `Map` 参数（不读模块级状态）；`activateAllPlugins(registry, deps)` 同样签名；`findPluginBody` 处理 Node CJS interop 双层 `default` 包装。`service.ts`: `registerPlugin/activateAll/unregisterPlugin/shutdown` 完整生命周期；`unregisterPlugin` 拷贝 services 列表后反序 stop（archive F-test 明确要求"caller 的 list 不被 mutate"）；`#buildApi` 把 `hookUnsubscribers`/`services` 数组 caller-owned 复用，register 和 activate 共享同一个清理源。`index.ts` barrel + `definePlugin`/`defineToolPlugin` 纯工厂（**不**再导出 archive 的 `getPluginService`/`registerPlugin` 模块级函数）。**✅ 集成完成（coder-prompt Part 4，commit `4d06f91`）**：`service.ts` 新增 `loadFromCandidates(candidates)` 薄桥接（`loadPlugins(candidates, this.#deps, this.#registry)`）；`cli/server.ts` `buildAgentFactory` 每个 (user, channel) 构造一个 `PluginService`（per-Agent `ToolRegistry` + 共享 `defaultBus` + per-user `getStateDir` = `~/.vex/plugins/{userId}/{pluginId}` + 同一 per-user `MemoryManager`），`discoverPlugins()` 系统级三层发现 → `loadFromCandidates` → `activateAll()`，插件工具经 `[...createBuiltinTools(...), ...toolRegistry.getAll()]` 并入 AgentRuntime `customTools`；`Agent.shutdown()` 在 `runtime.shutdown()` 之前调 `pluginService?.shutdown()`（`AgentRegistry.disposeEntry` 的 shutdown/reset/idle/overflow 四种路径唯一汇合点）。
| `web/`（part 1-6d，全部完成：client/login/qr/utils, WeChatChannel, auth+WeixinCredentialStore, types+logger+log-stream, config routes+schema fix, WebChatChannel WS 传输层, WS method handlers, server.ts bootstrap, static assets+control panel SPA+barrel） | ✅ **模块完成** | 621 tests through part 5 (`bd11b57`), +13 part 6a (634, `4aac173`), +40 part 6b (674, `cedbcf7`), +15 part 6c (689, `964ee3c`), +2 part 6c 修复轮 (691, `76e5c3f`), +9 part 6d (700 total, commit `41cdbcf`), tsc clean, `npm run build` 验证通过。part1 `bc01cdf`／part2 `95870c3`／part3 `cd676f7`／part4 `1fb32c5`／part5 `bd11b57`／part6a `4aac173`／part6b `cedbcf7`（详见上方历史记录）。part6c `964ee3c`+`76e5c3f`：初审发现两个真实缺陷并修复——(1) `WebChatChannel.handleChatSend` 认证用户 id 没设到 `Dispatcher.resolveUserId` 实际读的顶层 `ctx.webUserId`（只设了没人消费的 `raw.__webUserId`），导致认证态 WebChat per-user 配置/Agent 共享被静默破坏，修复后加了顶层字段 + 真实登录会话回归测试；(2) archive"跳过空消息"判断在新架构里消失，`WeChatChannel.extractTextContent` 确实能产出空字符串打到 Agent 触发真实 LLM 调用，修复后在 `WebServer` 两条 WeChat 接入路径都补上短路 + 回归测试。**part6d `41cdbcf` ✅ 一次通过**：`client.ts`/`styles.ts`/`i18n.ts` 三份模板文件跟 archive `diff` 为空（字节级相同）；`static/index.ts` 逐行比对 archive `static.ts`，除 5 处 `isWebAuthEnabled`/`getRequestUser` module-global 调用换成注入的 `auth.isEnabled`/`auth.getRequestUser(req)` 之外完全一致；专门核对协议漂移风险——从 `client.ts` 提取全部 13 个 WS method 调用跟 6a/6b 实现逐一对表，零漂移。**`web/` 模块（part 1-6d）至此全部完成。** |
| `cli/`（index.ts 操作型命令, config.ts, server.ts bootstrap, models.ts, check.ts, chat.ts, onboard.ts） | ✅ **模块完成（最后一个模块）** | +10 tests (710 total, commit `db4c238`), tsc clean, `npm run build` 通过。`server.ts` 是本轮重点——第一次把前面全部已审模块真正串起来（`ModelResolver`/`ConfigStore`/`ChannelRegistry`/`AgentRegistry`+`buildAgentFactory`/`Dispatcher`/`CronService`/`WebAuthStore`/`FileSessionStore`/`WeixinCredentialStore`/`staticHandler`），逐段核对排除了 part 6c 那类"字段设错地方"的漏洞；`modelResolver.init()` 一处类型断言看着可疑，没有停留在类型层面推理，写了隔离 repro 脚本实测确认运行时行为正确。**审查方亲自复现了端到端冒烟**（未采信 review 描述里的说法）：真实起进程（隔离 HOME + 假 config，`vex start --web-only`），`/health` 200、`/` webAuth 开启时 302→`/login`、静态资源 200、`SIGTERM` 优雅关闭、端口正确释放，全部亲手复现成功。`onboard.ts` diff archive 为空。**全部三个模块（`memory/`、`web/`、`cli/`）审查完毕，`rewrite/full-architecture` 分支的重写工作至此全部完成。** |

## 上线前真实环境测试发现（2026-08-02）

所有模块 review 通过之后，用户用真实 provider key（longcat、minimax）在真实进程里第一次跑通端到端对话，暴露了两个自动化测试全绿也测不出来的真实缺陷（均未提交，改动在工作区）：

1. **`logging.level: debug` 配置完全不生效（`src/utils/logger.ts`）。** 根因：几乎每个模块文件顶部都有 `const logger = getChildLogger("xxx")`，在模块 **import 时**就执行、绑定到当时的 root logger；而 `cli/server.ts` 的 `setLogger(createLogger({level: config.logging.level, ...}))` 是在 `start` 命令真正执行、全部模块 import 完之后才调用的——所以几乎所有模块的 logger 常量绑定的都是那个更早创建的、默认 info 级别、非美化输出的兜底 logger，配置的 `debug`/`pretty` 完全没生效（症状：终端只有零星 info 级原始 JSON，一条 debug 都没有）。**修复**：`getChildLogger` 改成返回一个懒代理（Proxy），每次真正打日志时才解析当前 `rootLogger`（用版本号做缓存失效），不再在创建时死绑。`tests/logger.test.ts`（2 个新测试）：验证 `setLogger()` 在 child logger 创建**之后**调用，仍然能改变它的 `.level`；验证 module 绑定（`bindings()`）在 rebind 后依然保留。真实环境验证：重启进程后终端能看到完整的 pretty + debug 级别调用链（`dispatcher → agent → agent-runtime → create-pi-session → outbound`）。
2. **LLM 调用失败时静默投递空回复，用户界面上什么提示都没有（`src/agent/AgentRuntime.ts` + `src/agent/createDefaultPiSession.ts`）。** 根因：`longcat` 账户额度用尽（`402 调用失败：Token 额度不足`），pi-coding-agent 把这次失败记成一条 `stopReason: "error"`、`content: []` 的 assistant 消息，不会抛异常；`AgentRuntime.buildReply()` 只调 `getLastAssistantText()`（对空 content 消息返回 `undefined ?? ""`），完全看不到 `stopReason`/`errorMessage`，于是"成功"投递了一条空 `chat.delta`——`Message delivered` 日志照常打印，前端因为 `payload.delta` 是空字符串（falsy）连占位气泡里的文字都不会写，用户看到的就是"发了消息但什么反应都没有"。**修复**：`PiSession` 接口新增 `getLastAssistantError(): string | undefined`；`createDefaultPiSession.ts` 的 `adaptSession` 读 pi-coding-agent 原生 `session.messages` 数组，找最后一条 assistant 消息，`stopReason === "error"` 时返回 `errorMessage`；`AgentRuntime.buildReply()` 在 `getLastAssistantText()` 为空时改用这个错误信息拼一条用户可见的回复（`⚠️ 抱歉，AI 服务调用失败：<errorMessage>`），而不是空字符串。`tests/agent-runtime.test.ts` 新增一个用例，用假 session 模拟 `stopReason: "error"` 场景，断言 `reply.content` 包含错误信息而不是空字符串；原有"session 报告无 assistant text 时返回空字符串"的测试保留不变（区分"真的没话说"和"报错了"两种情况）。真实环境验证：确认修复本身生效（用隔离脚本直接调 `streamSimple` 复现了 longcat 402 和 minimax 旧大小写 404 两种真实错误），最终用户切到正确大小写 `MiniMax-M3` 后端到端聊天成功收到回复。

**额外发现（未修，记录留待后续）**：用户配置 `defaultModel: minimax-m3`（小写）时，`ModelResolver` 的动态兜底解析路径没有报"找不到模型"，而是静默猜了一个错误的 API 协议（`openai-completions`，实际该模型注册的是 `anthropic-messages`），导致打到错误的接口路径返回 404——兜底路径应该要么大小写不敏感匹配，要么匹配不到时给出明确报错，而不是猜一个可能错的协议。这个不影响当前对话功能（用户改对大小写后就正常了），暂不阻塞，记在这里防止遗忘。

3. **Session 侧边栏标题从来没有真正生成过，一直显示成截断的 sessionKey（如 `user_36f05dc...`）。** 根因：`sessions/title.ts` 的 `generateSessionTitle`（纯逻辑 + LLM 注入点）在 part `sessions/` 那一轮就已经完整移植且测试通过，但它的**调用点**——archive `websocket.ts` 里 `handleChatSend` 首轮回复后调 `maybeGenerateTitle` → `store.setLabel` → 推 `session.title` 事件——在拆分 part 6a（`WebChatChannel.ts` 只做协议层）、part 6b（handlers）、part 6c（`cli/server.ts` bootstrap）的过程中被漏掉了，从没有任何代码路径真正调用过 `generateSessionTitle`。前端 `client.ts` 早就写好了 `session.title` 事件监听和 `s.label || s.sessionKey.replace(...)` 的降级逻辑（等着后端推事件），但后端从没推过。**修复**：`WebChatChannel` 新增可选的 `titleGenerator: {provider, model, complete}` 构造参数；`handleChatSend` 把当轮用户文本暂存到 `client.pendingUserText`，`sendMessage`（assistant 回复投递时）取出配对，调 `maybeGenerateTitle`（同名逻辑从 archive 移植：`titleInFlight` 去重、已有 label 就跳过、`setLabel` + 推 `session.title` 事件）；`WebServerOptions` 加一条同名字段透传给 `WebChatChannel`；`cli/server.ts` 新增 `createTitleGenerator(modelResolver, config)`，用系统默认 provider/model（不是每用户单独解析的模型——跟 archive 选择一致，标题生成是廉价的、不个性化的摘要，不是对话本身）+ `pi-ai` 的 `completeSimple` 实现真正的 LLM 调用。`tests/webchat-channel.test.ts`（+2）／`tests/web-server.test.ts`（+1）：真实 WS 往返，注入假 `complete` 函数，断言 `session.title` 事件被推送且 label 正确、已有 label 的 session 不会重复调用。真实环境验证：用真实 minimax key 跑了一遍完整 prompt，拿到"记账收入支出"这样正常的标题。716/716 全绿，`tsc` 干净。
4. **`AgentRuntime` 的 pi-coding-agent 会话文件落在了错误的目录。** 用户发现微信频道的 `sessionFile` 落在 `<进程启动时的 cwd>/.vex/sessions/`（比如 `/home/counhopig/workspace/vex-bot/.vex/`），不是文档承诺的 `~/.vex/sessions/`。根因：`AgentRuntime.getOrCreateSession()` 用 `workingDirectory`（Agent 工具执行的 cwd，比如 bash/filesystem 工具用）拼 `sessionFile` 路径，完全没读 `this.config.sessionDir`（`cli/server.ts` 已经正确设成 `~/.vex/sessions` 并传了进去，但从没被消费）——archive 原版是把 `sessionDir`/`workingDirectory` 当两个独立字段分别使用的，重写时被合并成了一个。**修复**：`getOrCreateSession()` 改成 `sessionDir = this.config.sessionDir ? expandHomePath(...) : join(homedir(), ".vex", "sessions")`，`sessionFile` 从这个 `sessionDir` 拼，不再用 `workingDirectory`。新增回归测试故意把 `workingDirectory`/`sessionDir` 设成两个不同路径，断言 `sessionFile` 落在 `sessionDir` 下、不含 `workingDirectory`——这个测试如果不修就会红。717/717 全绿。**遗留问题**：修复前生成的真实会话文件还留在旧的错误目录里（用户的 `<repo>/.vex/` 下），没有做迁移，用户可以选择手动搬过去或者接受历史对话从新目录重新开始。

## 全局排查发现：memory/skills/plugins 三个已完成模块从未被真正接入运行系统（2026-08-02）

按用户要求做的一次全局排查，找出跟"sessionDir 被声明但没被读"同一类的问题——**模块本身写完、测试通过、review 通过，但最后装配阶段（`cli/server.ts` / `tools/builtin/index.ts`）没有真正把它接上**，规模比上面 4 条单点 bug 大得多：

1. `tools/builtin/index.ts` 的 `createBuiltinTools()` 函数体里，`memory`/`weather`/`cron`/`image` 四类工具从来没被调用过——函数末尾的注释写着"ported by separate sub-tickets; add them here once their modules land"，然后直接 `return tools`。但 `createMemoryTools`/`createWeatherTool`/`createCronTools`/`createImageAnalyzeTool` 全部已经实现且测试过。
2. `cli/server.ts` 的 `buildAgentFactory` 从未构造过 `MemoryManager`，也没读取 `weather` 配置，`CronService` 实例虽然为调度器建了，但没传给 `createBuiltinTools`。
3. `agent/Agent.ts` 调用 `assembleSystemPrompt()` 时只传了 `persona`，从没填过预留的 `sections.skills` 槽位；`skills/{SkillLoader,SkillRegistry,SkillInjector}` 在 `cli/server.ts` 里零引用。
4. `PluginService` 全仓库 grep 只在它自己的模块文件里出现，`plugins/` review 通过时记录的"下一步集成点：bootstrap 构造 PluginService"从未发生。

**状态：✅ 全部完成。** Part 1（`c1bd22e`+`6c883b3`，weather 门槛跟 archive 实际行为核对后修过一次）、Part 2（`b784beb`+`1ce988b`，memory 缺省语义跟 EffectiveConfig 其它字段的默认值行为对齐后修过一次）、Part 3（`2722480`，一次通过）、Part 4（设计问题确认 + 实现 `4d06f91`，一次通过）全部 review 通过。`memory/`、`skills/`、`plugins/` 三个"写完测完 review 过、但从没被真正接入运行系统"的模块现在全部真正接入。**已知、范围外的遗留项**：`tool_start`/`tool_end` hook 之前说"等 plugins/ 落地再接"，现在 plugins/ 接上了，但这两个事件依然没人 emit，插件作者注册这两个 hook 会静默不生效——不阻塞，留待后续。
