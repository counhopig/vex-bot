# Persona 自动画像后台任务 — 设计文档

日期：2026-07-03
状态：已批准，待实现计划

## 问题

Vex 号称"自动长期记忆"，但实际上**只有召回（recall），没有自动写入（store）**。用户在自由聊天里说出的持久事实（例如"我住在深圳，在香港上班"）不会被自动记住：

- Persona 的 `rememberPersonaFact()` 只在 `/persona_set_nickname`、`/persona_note` 两个显式命令里被调用。
- `observeResponse`（response observer）只做短期 history 追加 + 情绪恢复，不抽取事实。
- 通用 `memory_store` 工具依赖 LLM 主动调用，而 system prompt 明确要求"只在用户明确要求时才存"，所以模型通常不存。
- `persona/index.ts:301` 的占位符注释已承认："完整反思/事实编辑会在后续 LLM 后台任务中生效"——但这个后台任务从未实现。

## 关键发现：脚手架已存在，只差接线

项目已经为"自动画像"搭好了几乎全部部件，只是从未接通：

| 已具备的部件 | 位置 |
|---|---|
| 配置开关 `profileBuildingEnabled`(默认 true)、`profileBuildingTriggerTurns`(默认 5) | `persona/config.ts:70-71` |
| 存储层 `addProfileFact`(自带去重) / `getProfileFacts` / `removeProfileFact` | `persona/storage.ts:586,582,609` |
| 轮次计数器 `getTurnCounter` / `setTurnCounter` | `persona/storage.ts:633` |
| Prompt 里 `【用户画像】` block **已经在注入** | `persona/index.ts:126-128` |
| 一次性 LLM 调用 `llmComplete()` | `providers/llm.ts:65` |
| 写长期记忆 `rememberPersonaFact()`(带 user tag) | `persona/index.ts:31` |

配置项 `profileBuildingEnabled` / `profileBuildingTriggerTurns` **从未被任何代码读取**。这是唯一缺失的一根线。

## 方案

不新造机制，而是**接通项目自己已设计好的后台画像任务**。零新增配置、零新增存储方法、零 prompt 改动。

### 触发策略（已确认）

每 N 轮后台异步抽取。N = `config.profileBuildingTriggerTurns`（默认 5）。抽取 fire-and-forget，脱离回复热路径，不增加每轮回复延迟。

### 存储去向（已确认）

抽出的事实**同时写两处**：
- `addProfileFact(...)` → 结构化画像，每轮固定注入 `【用户画像】` block。
- `rememberPersonaFact(...)` → TF-IDF 长期记忆，支持语义召回（`【长期记忆】` block）。

## 数据流

```
用户消息 → 回复发出 → observeResponse
   ├─ (现有) appendHistoryAndRecoverEmotion + recordInteraction
   └─ (新增) 若 profileBuildingEnabled:
             turn = getTurnCounter(uid, "profile_building") + 1
             setTurnCounter(uid, "profile_building", turn)
             若 turn % profileBuildingTriggerTurns == 0:
                 void extractProfileFacts(config, ctx, uid)   ← 不 await
```

```
extractProfileFacts(config, ctx, uid):
   若 uid 已在 inFlight → 直接返回（并发护栏）
   inFlight.add(uid)
   try:
     history  = storage.formatHistoryForPrompt(uid, config.memoryMaxTurns)   // 复用现有窗口，默认 10 轮
     existing = storage.getProfileFacts(uid)
     prompt   = 抽取指令 + existing(去重上下文) + history
     result   = await llmComplete({
                  providerId,   // 见下方"provider/model 来源"
                  model,
                  prompt, maxTokens })
     facts    = 解析 JSON 数组 [{category, content, evidence, confidence}]
     对每条 fact（confidence >= 阈值）:
       storage.addProfileFact(uid, category, content, evidence, confidence)  // 去重
       await rememberPersonaFact(config, ctx, `[category] content`, "fact")   // 语义召回
   catch: logger.warn(...)   // 绝不抛出，绝不影响回复
   finally: inFlight.delete(uid)
```

**去重要点**：把现有画像事实一并喂进 prompt，要求 LLM **只返回尚未记录的新事实**。这既避免画像重复（`addProfileFact` 本身也去重兜底），也避免向长期记忆（`rememberPersonaFact` 无去重）反复写重复条目——一举解决两处去重。

## 组件边界

全部改动集中在 `persona/index.ts`，复用现有部件：

| 新增/改动 | 内容 |
|---|---|
| `observeResponse`（改） | 加轮次计数 + 到阈值触发后台任务；受 `config.profileBuildingEnabled` 门控。 |
| `extractProfileFacts(config, ctx, uid)`（新） | 后台抽取全流程：读 history + 现有画像 → `llmComplete` → 写两处存储。 |
| 模块级 `inFlight: Set<string>`（新） | 并发护栏：同一 uid 抽取进行中则跳过。 |

**provider/model 来源**：`personaConfig`（`createPersonaConfig(config.persona)` 的产物）不携带 provider/model。`initPersona(config: VexConfig, ...)` 持有完整配置，在初始化时把 `config.agent.defaultProvider` / `config.agent.defaultModel` 捕获到模块作用域（与 `longTermMemory`、`storage` 相同的模块级单例风格），供 `extractProfileFacts` 使用。

零新增配置项、零新增存储方法、零 prompt 改动。

## 错误处理与契约

- **错误隔离**：`extractProfileFacts` 整体 try/catch，LLM 失败或 JSON 解析失败 → `logger.warn` 后静默返回（与 skilllearner 的 `generateSkillMarkdown` 降级风格一致）。因为是 fire-and-forget（不被 await），即便抛出也不会影响 `runResponseObservers`；但仍显式兜底。
- **LLM 输出契约**：要求返回**纯 JSON 数组**；解析失败则丢弃本轮，不写任何存储。
- **置信度过滤**：`confidence < 0.6` 的事实丢弃，防噪音。
- **抽取范围**：只抽**关于用户的持久事实**（居住地、职业、偏好、关系、重要日期等）；显式排除一次性/临时内容（"今天天气""帮我查个东西"）。

## 测试（vitest）

对 `extractProfileFacts` 注入一个假的 `llmComplete`（返回固定 JSON），断言：

1. 正确调用 `addProfileFact` + `rememberPersonaFact`。
2. 重复事实不二次写入。
3. 低 confidence（< 0.6）事实被过滤。
4. JSON 解析失败时不写入任何存储。
5. 并发护栏：同一 uid 第二次调用在前一次未完成时被跳过。

计数器触发逻辑单测阈值边界（第 N 轮触发、第 N+1 轮不触发）。

## 明确不做（YAGNI）

- 不加新配置项。
- 不改 `【用户画像】` prompt 注入逻辑。
- 不实现 `/persona_facts`、`/persona_apply` 等其余占位命令（超出本次范围）。
- 不做每轮同步抽取（成本/延迟不划算）。
