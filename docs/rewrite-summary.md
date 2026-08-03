# vex-bot 架构重写总结

**分支：** `rewrite/full-architecture`
**状态：** ✅ 全部完成——13 个模块 + 4-part 集成缺口补齐全部 review 通过，真实环境测试跑通。

这份文档是整个重写过程的一站式总结。更细的记录分散在几份文档里：`docs/architecture.md`（目标架构规范）、`docs/rewrite-plan.md`（逐模块的完整过程记录，本文档是它的摘要版）。`docs/coder-prompt.md`/`docs/review-inbox.md`/`docs/review-results.md` 是写代码会话与审查会话之间传递任务和结果的工作文件，已完成使命。

---

## 1. 背景

`vex-bot` 是一个支持中文大模型和微信个人号的 AI 助手框架（TypeScript / Node ESM）。这次是**完全推倒重来的架构重写**，不是渐进式重构：旧代码整体 `git mv` 进 `_archive/` 作为只读参考（保留 git 历史），新代码从零开始按 TDD 重新实现，只在有具体证据时才照抄旧实现的安全逻辑或历史事故修复。

重写驱动的核心设计原则（详见 `docs/architecture.md`）：

- Persona-first，单一 dispatch 路径（不允许 globalAgent 与其他路径分叉）
- 配置按 (user, channel) 粒度解析，channels 是"哑管道"（不掺业务逻辑）
- Agent 实例自包含（自己的 Pipeline / Persona / Runtime）
- CJK 原生分词
- **第5条，最重要、贯穿全程被反复引用的一条：不允许进程全局状态跨实例污染**（class-based 优于 module-level 单例）

---

## 2. 协作模式：两个 Claude 会话 + 文件驱动的异步审查

整个重写由两个角色配合完成：一个"写代码"的会话按 `docs/coder-prompt.md` 的指令用 TDD 实现模块，一个"审查"的会话（这份文档所在的会话）独立验证。两者通过文件通信：写代码的会话把完成情况覆盖写入 `docs/review-inbox.md`，一个后台 Monitor 监听这个文件的变化并通知审查会话；审查会话读取、独立验证（重新跑 `tsc`/`vitest`，读实际 diff，逐条跟 `_archive/` 比对，必要时写隔离脚本实测第三方库行为），把结论写回 `docs/review-results.md`；写代码会话再据此决定推进还是修复重提。

这套流程里逐渐固化出一组"铁律"（完整列表见 `docs/coder-prompt.md`）：`_archive/` 只读不可 import、已批准模块锁定不能因为"更像 archive"就重写、严格 TDD、每个模块单独提交且提交前核对暂存区、对第三方 SDK 行为的假设要去读 `node_modules` 里的实际源码验证——最后一条是因为真的踩过坑（见下方 `_baseSystemPrompt` 那次）。

**独立验证是这套流程能发现问题的关键**，不是走过场：全程反复出现"审查描述说 X，但我读了实际 diff/archive 源码/第三方库源码后发现不是 X"的情况，详见下面第4、5节的具体案例。

---

## 3. 13 个模块

按完成顺序（早期模块无 part 拆分，`web/` 因体量最大拆成 6a-6d，`cli/` 是收尾模块）：

| 模块 | 要点 |
|---|---|
| `_archive/` 归档 | 旧 `src/`(113文件)+`tests/`(48文件) 整体 `git mv`，保留历史 |
| `memory/tokenizer/` | CJK 原生分词：Latin 空格分词，CJK 3+字重叠 bigram |
| `agent/AgentRegistry.ts` | 泛型 (userId,channelId) 复合键缓存，并发构建共享/idle-TTL/LRU |
| `config/ConfigStore` + resolvers | 3层 merge (默认→YAML→SQLite)。**web/part5 复审时发现并修复**：schema 漏了 5 个 section（Zod 默认丢弃未声明 key），`channels.weixin` 曾经永远读不到 |
| `dispatcher/` + `ChannelAdapter` 类型 | 单一 dispatch(ctx) 入口，无 globalAgent 分叉 |
| `agent/Agent.ts`+`Pipeline`+`persona/` | Persona opt-in，无硬编码默认人格；2026-07-17 修过一次"人格竞争"bug |
| `agent/SystemPromptAssembler.ts` | 5段式 system prompt 组装（后来第4节"技能"槽位长期没人填，见第6节 Part 3） |
| `channels/ChannelRegistry.ts` | 平面 + per-user 双层查找 |
| `outbound/OutboundDeliver.ts` | 超时保护，error 不抛出 |
| `providers/{ProviderMetadata,ModelResolver,...}` | Class-based，3步模型解析路径 |
| `agent/AgentRuntime`+`createDefaultPiSession` | **发现 `_baseSystemPrompt` 隐藏 bug**：pi-coding-agent 在有 custom tools 时会用私有字段悄悄覆盖掉当轮设置的 system prompt——靠读 `node_modules` 里的实际 SDK 源码才找到，不是靠推理 |
| `tools/{ToolRegistry}`+`tools/builtin/*` | 13个内置工具移植，SSRF/路径穿越/per-owner 隔离等安全逻辑原样保留 |
| `skills/{SkillLoader,SkillRegistry,SkillInjector}` | 3层发现(bundled→user→workspace)。**长期未被使用**，见第6节 Part 3 |
| `cron/{types,store,schedule,service,executor}` | 多租户 `ownerId`，一次通过无需修复 |
| `hooks/{types,EventBus}` | Class-based 但保留 `defaultBus` 用于全局广播（archive 明确标注为故意如此） |
| `sessions/{store,title}` | Class-based `FileSessionStore`，`generateSessionTitle` 逻辑完整但**长期没有调用点**，见第7节 |
| `memory/{MemoryManager,JsonMemoryStore}` | Per-Agent 实例化。**长期未被接入**，见第6节 Part 2 |
| `plugins/{discovery,loader,service}` | Per-runtime `PluginService`，**长期未被实例化**，见第6节 Part 4 |
| `web/`（part 1-6d） | 体量最大：微信客户端/登录/二维码、`WeChatChannel`、`WebAuthStore`、`WebChatChannel` WS 传输、WS 方法处理器、`server.ts` bootstrap、静态资源+控制面板。part 6c 发现两个真实缺陷（见下） |
| `cli/` | 收尾模块，`server.ts` 第一次把前面所有模块真正串起来。亲自复现端到端冒烟（真实起进程验证 health/登录重定向/优雅关闭） |

### 过程中审查发现并修复的缺陷（模块 review 阶段，非真实环境测试阶段）

- **`config/schema.ts` 漏 5 个 section**（见上表）
- **`_baseSystemPrompt` 同步 bug**：读 pi-coding-agent 实际源码才发现的隐藏坑
- **`tools/builtin` 的 `customTools` 双路径注册缺口** + 缺失的 `wrapErrorAwareTool`
- **`skills/` 缺失 `expandHomePath`/`isPathInside`** 移植
- **`web/routes/auth.ts` 用 bracket-notation 绕过 TypeScript `private`**——专门写隔离 repro 验证 TS 5.9.3 strict 模式确实不拦这个，不是靠猜
- **`web/` part 6c：`WebChatChannel.handleChatSend` 认证用户 id 没传到 `Dispatcher.resolveUserId` 实际读的顶层字段**（只传了没人消费的 `raw.__webUserId`），导致认证态 WebChat 的 per-user 配置/Agent 复用被静默破坏——这是全程发现的最严重的一类问题的第一次出现（"字段声明了但没被正确消费"），后来在真实环境测试阶段又反复出现（见下）
- **`web/` part 6c：archive"跳过空消息"判断消失**，未识别的微信消息类型会打空内容到 Agent 触发真实 LLM 调用

---

## 4. 上线前真实环境测试：4 个真实 bug

所有模块 review 通过后，用户用真实 provider key（longcat、minimax）第一次跑通端到端对话，暴露了自动化测试全绿也测不出来的问题：

1. **`logging.level: debug` 完全不生效**（`utils/logger.ts`）—— 几乎每个模块文件顶部 `const logger = getChildLogger(...)` 在 **import 时**就绑定了 root logger，而 `cli/server.ts` 的 `setLogger()` 是在 `start` 命令真正执行、全部 import 完之后才调用——几乎全部模块的 logger 常量绑的都是更早创建的默认 logger。修复：`getChildLogger` 改成懒代理，用版本号做缓存失效。
2. **LLM 调用失败时静默投递空回复**（`AgentRuntime.ts`）—— longcat 账户额度用尽（402），pi-coding-agent 把失败记成 `stopReason:"error"`、空 content 的消息，不抛异常；`buildReply()` 只看 `getLastAssistantText()`，看不到错误，"成功"投递了一条空消息，用户界面上什么反应都没有。修复：新增 `getLastAssistantError()` 读原生 `session.messages`，`stopReason==="error"` 时拼一条用户可见的错误提示。
3. **Session 侧边栏标题从未真正生成过**（一直显示截断的 `user_36f05dc...`）—— `sessions/title.ts` 的逻辑完整且测试过，但它的**调用点**在 part 6a/6b/6c 拆分过程中被漏掉了，从没有代码路径真正调用它。前端早就写好了监听事件的降级逻辑，后端从没推过。修复：`WebChatChannel` 加 `titleGenerator` 注入点，`handleChatSend`/`sendMessage` 配对触发。
4. **`AgentRuntime` 的会话文件落在错误目录**——微信频道的 `sessionFile` 落在"进程启动时的 cwd"下，不是文档承诺的 `~/.vex/sessions/`。根因：`getOrCreateSession()` 用 `workingDirectory`（工具执行 cwd）拼路径，完全没读专门设计来做这件事的 `config.sessionDir`（archive 原本是两个独立字段，重写时用混了）。

（另有一个**未修、记录留待后续**的次要发现：`ModelResolver` 遇到大小写不匹配的模型 id 时，兜底路径会静默猜错 API 协议而不是报错。）

---

## 5. 全局排查：三个模块从未被真正接入运行系统

用户要求做一次全局排查，找跟"`sessionDir` 声明了但没被读"同一类的问题。结果发现规模比单点 bug 大得多——**`memory/`、`skills/`、`plugins/` 三个模块本身写完、测试通过、review 通过，但最后装配阶段（`cli/server.ts`、`tools/builtin/index.ts`）根本没把它们接上**：

1. `tools/builtin/index.ts` 的 `createBuiltinTools()` 从未调用 `createMemoryTools`/`createWeatherTool`/`createCronTools`/`createImageAnalyzeTool`——函数体里一行注释"ported by separate sub-tickets; add them here once their modules land"，然后什么都没加。
2. `cli/server.ts` 从未构造过 `MemoryManager`，没读取 `weather` 配置。
3. `Agent.ts` 调用 `assembleSystemPrompt()` 时只传 `persona`，`SystemPromptAssembler` 预留的技能槽位从没被填过。
4. `PluginService` 全仓库搜索只在它自己的模块文件里出现过。

## 6. 补齐集成缺口：4-part 计划

写了完整的 plan 交给写代码会话执行，全部走标准 TDD + 单独提交 + review 流程：

- **Part 1**（`c1bd22e`+`6c883b3`）：把 memory/weather/cron/image 四类工具真正接进 `createBuiltinTools()`。审查发现 review 描述里"archive 对 weather 也是配置存在才加"这个说法是错的——直接读 archive 源码验证 weather 其实跟 image 一样无条件加载，修复后重提通过。
- **Part 2**（`b784beb`+`1ce988b`）：`cli/server.ts` 构造 per-user `MemoryManager`，读取 `weather`/`CronService` 传给工具。审查发现"用户完全没写 `memory:` 段"这种情况下会出现"enableMemory:true 但 memoryManager:undefined"的自相矛盾状态（工具列表里挂着但永远拿不到实例）——跟 `EffectiveConfig` 其它字段（agent/server/logging）缺省时都有真默认值的原则不一致，修复后重提通过。
- **Part 3**（`2722480`）：把 `SkillLoader`/`SkillRegistry`/`SkillInjector` 接进 `Agent.ts` 的 system prompt 组装，填上第4节的技能槽位。一次通过。
- **Part 4**（设计确认 + `4d06f91`）：`PluginService` 接入，工作量最大、涉及真实架构决策，要求先在 review-request 里回答 4 个设计问题（生命周期粒度、插件工具怎么进 Agent 工具列表、workspace 路径语义、shutdown 时机）再动手写代码。设计确认阶段发现一处可以简化的地方（`PluginService` 已有公开的 `activateAll()`，不需要再包一层），以及一处更强的论证（`AgentRegistry` 的四种 dispose 路径——shutdown/reset/idle/overflow——唯一的汇合点是 `Agent.shutdown()`，不只是"图方便"）。实现阶段一次通过。

**结果**：`memory/`、`skills/`、`plugins/` 三个此前完全休眠的模块现在真正活了。

---

## 7. 真实环境功能验证

修复完成后逐项手动验证：

- ✅ 多标签页/多连接共享同一个 Agent（同一用户的第二个连接不会再触发新的 `AgentRuntime initialized`）
- ✅ Session 自动标题（真实 minimax key 验证，拿到"记账收入支出"这样的正常标题）
- ✅ 微信扫码登录完整链路（二维码签发→轮询→确认→立即激活，无需重启，真实收发消息）
- ✅ 重启后持久化（会话历史、微信登录 token、UI 显示全部保留，扫码状态不丢）

---

## 8. 已知遗留项（不阻塞，记录防止遗忘）

- `ModelResolver` 对大小写不匹配的模型 id 静默猜错 API 协议，而不是报错或大小写不敏感匹配。
- `tool_start`/`tool_end` hook 一直没人 emit——当初说"等 plugins/ 落地再接"，现在 plugins/ 真的接上了，但这两个事件依然没人触发，插件作者注册这两个 hook 会静默不生效。
- `developer-guide.md`/`api-reference.md` 是重写前的旧文档（标注 `b7bf46a`），路径和类结构已经完全对不上新代码库，本次重写没有同步更新（用户已确认暂不处理）。

---

## 9. 文档索引

| 文档 | 用途 | 状态 |
|---|---|---|
| `docs/architecture.md` | 目标架构规范 | 权威、持续有效 |
| `docs/rewrite-plan.md` | 逐模块完整过程记录（本文档的详细版本） | 完整历史记录，保留 |
| `docs/rewrite-summary.md` | 本文档 | 当前 |
| `docs/coder-prompt.md` | 写代码会话的任务指令 | 已完成使命 |
| `docs/review-inbox.md` / `review-results.md` | 两个会话间传递审查结果的工作文件 | 用完即弃性质 |
| `docs/user-manual.md` | 面向最终用户的使用手册 | 未逐条核对，外部行为理论上未变 |
| `docs/developer-guide.md` / `api-reference.md` | 重写前的旧技术文档 | **已过时，暂不处理** |
| `docs/h2a2-improvement-proposals.md` | 独立的功能提案，跟这次重写无关 | 独立文档 |
