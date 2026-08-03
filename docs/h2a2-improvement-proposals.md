# vex-bot 改进方案：从 h2a2 (ICP) 借鉴的五个方向

> **状态**:提案(Proposal)
> **日期**: 2026-07-20
> **依据**: 对 h2a2/ICP(Python+Rust,~149K LOC)与 vex-bot(TypeScript,~25K LOC)的实现级对比分析
> **原则**: 只拿被 h2a2 用大规模代码验证过的**想法**,不引入它的**重量**(多进程、状态机引擎、冗余匹配器)。每项改进都必须能用 vex-bot 现有机制在少量代码内落地。

---

## 0. 总览

| # | 提案 | 借鉴自 h2a2 的 | 优先级 | 预计改动量 | 核心收益 |
|---|------|----------------|--------|-----------|---------|
| 1 | 记忆自动召回 | `memory_management_node` 每轮自动注入 top-k 事实 | **P0** | ~80 行 | 不再依赖模型"想起来"调 `memory_search` |
| 2 | 记忆写入去重 + LLM 事实提取 | mem0 `infer=True` + 相似度 >0.90 跳过写入 | **P0** | ~60 行 | 长期运行记忆库不膨胀、不重复 |
| 3 | 技能相关性选择 | 5 套技能匹配器(方向正确、实现冗余) | **P1** | ~120 行 | 装几十个技能不再撑爆 system prompt |
| 4 | Prompt 静态前置 | 为 vLLM 前缀缓存设计的 prompt 结构 | **P1** | ~30 行 | 自托管模型白捡的前缀缓存命中 |
| 5 | 技能可执行化(结构化工具) | Python/API/bash 三条可执行路径 | **P2** | ~200 行 | 技能可审计、可限权、可统计成本 |

**明确不采纳**(反面教材,详见 §7):subprocess 冷启动调用、workspace 共享记忆、多套匹配算法并存、朴素 `.replace()` 模板、散落各处的硬字符截断。

---

## 1. [P0] 记忆自动召回

### 问题

vex-bot 目前完全依赖模型主动调用 `memory_search` 工具。`buildMemoryGuide()` 的 prompt 指南只能"建议",小模型经常想不起来——用户明明说过的事,机器人表现得像第一次听说。

h2a2 的做法:`memory_management_node` 在图里是一个固定节点,每轮自动 `search(query, limit=10)` 后取 top-3 注入 `rag_context`,不需要模型发起。

### 设计

**机制:复用现有 `PromptInjector` 管道,零新架构。**

Persona 扩展已经验证了这条路径:`registerPromptInjector()` 每轮向 system prompt 注入画像块。记忆召回用同一个机制,但作为**核心能力**而非扩展,由 `AgentRuntime` 直接注册。

改动点:

1. **`src/memory/manager.ts`** — 新增 `recallForContext(query: string, limit = 3): Promise<string>`:
   - 内部调用现有 `recall(query, limit)`;
   - 复用现有 `formatForContext()` 的输出格式(`- [<type>] <content> (relevance: NN%)`);
   - 空结果返回空串(不注入,避免噪音);
   - 加最低相关度阈值 `minScore`(默认 `0.15`,可配)——哈希嵌入语义弱,低分结果是关键词巧合,注入反而误导。

2. **`src/agents/runtime.ts`** — 在 `applyPromptInjections()` 中,`gatherPromptInjections()` 之后追加一步:
   - 若 `this.memoryManager` 存在且配置开启,用当前用户消息调 `recallForContext(context.content)`,把非空结果作为一个注入块拼入。
   - 失败静默(`logger.warn`),召回永远不能阻塞消息处理。

3. **`src/config/index.ts`** — Zod schema 的 `memory` 节新增:
   ```yaml
   memory:
     autoRecall: true        # 默认开
     autoRecallLimit: 3
     autoRecallMinScore: 0.15
   ```

### 与 Persona 扩展的关系

Persona 目前自己也会 `recall()` 并注入 persona-tagged 记忆。两者并存会重复注入。方案:Persona 的召回注入**保留**(它带画像语境),自动召回块**排除** `tags` 含 `persona` 的条目(`recall` 已有 tag 过滤参数)。

### 不学什么

- 不学 h2a2 的 4000/10000/20000 多重硬字符截断——召回条目本身就很短,`formatForContext` 已截到 200 字符/条。
- 不学"前 40 字符签名"去重(见 §2,用向量相似度替代)。

### 验证

- `tests/memory.test.ts` 新增:`recallForContext` 空库返回空串、低于 minScore 不注入、persona 标签被排除。
- 手动 QA:`vex start --web-only`,存一条事实 → 新会话直接问相关问题和无关问题,分别确认注入/不注入。

---

## 2. [P0] 记忆写入去重 + LLM 事实提取

### 问题

`memory_store` 目前无去重:模型多轮里反复存同一事实,JSON 索引无限膨胀。另外存的是原文整句,检索质量受措辞影响大。

h2a2 的做法:写入前先 `search(fact, limit=5)`,相似度 >0.90 则跳过;mem0 `infer=True` 让 LLM 先把原文提炼成事实再入库。

### 设计

1. **写入去重**(`src/memory/manager.ts` 的 `remember()`):
   - 写入前 `recall(content, 1)`,若最高分 ≥ `dedupeThreshold`(默认 `0.85`,可配)则跳过,返回 `{ status: "duplicate", existingId }`。
   - 阈值走配置 `memory.dedupeThreshold`;`0.85` 而非 h2a2 的 `0.90`——哈希嵌入分数分布不同,先用测试集校准再定默认值。
   - `memory_store` 工具把 duplicate 状态透传给模型,模型能感知"已存过"。

2. **LLM 事实提取(可选,默认关)**:
   - Persona 扩展的 `extractProfileFacts()` 已证明这条链路(`llmComplete` + JSON 数组解析 + confidence 过滤)。
   - 把它**下沉**为 `MemoryManager.remember({ extract: true })` 的可选路径:原文 → LLM 提炼成 1-3 条原子事实 → 逐条走去重写入。
   - 配置 `memory.extractOnStore: false` 默认关——它引入一次额外 LLM 调用,云模型按 token 计费,用户应显式开启。
   - 提取用的 provider/model 复用 agent 配置(与 Persona 一致),不新增配置面。

### 不学什么

- 不学 h2a2 把存储丢进 fire-and-forget 后台线程——vex-bot 的 JSON 写入是同步原子 rename,已经足够快,异步只会带来丢数据窗口。

### 验证

- `tests/memory.test.ts`:同内容二次写入返回 duplicate;改写措辞后相似度高的内容被去重;`extract: true` 路径 mock `llmComplete` 验证原子事实逐条入库。

---

## 3. [P1] 技能相关性选择

### 问题

`SkillsRegistry.buildPrompt()` 把**所有**符合条件的技能全文拼进每轮 system prompt。装 30 个技能就是 30 份 Markdown 全文,token 成本线性增长,还会稀释模型对单个技能的注意力。

h2a2 在"按需选择"这个方向上是对的(它错在做了 5 套互不连通的匹配器)。vex-bot 只做**一套**,复用已有组件。

### 设计

1. **双层注入**(`src/skills/registry.ts`):
   - 每轮注入分两层:
     - **索引层(始终注入)**:全部技能的一行式目录 `- <name>: <description>`,让模型知道有什么可用。
     - **全文层(按需注入)**:仅 top-k 相关技能的 Markdown 全文。
   - `buildPrompt()` 拆为 `buildIndex()` 和 `buildRelevantPrompt(query, k)`,保持原 `buildPrompt()` 作为 `k = Infinity` 的退化行为(向后兼容,`skills.relevance.enabled: false` 时走旧路径)。

2. **相关性打分(零新依赖)**:
   - 复用 `src/memory/embedding.ts` 的 `SimpleEmbedding`(256 维 FNV-1a 哈希向量,确定性、无外部依赖、已在记忆系统验证)。
   - 启动时为每个技能的 `name + title + description + tags` 计算向量并缓存(`SkillEntry` 加可选 `embedding` 字段)。
   - 每轮用用户消息向量做余弦相似度,取 top-k(默认 3)+ 相似度下限(默认 0.1,低于下限一个全文都不注入)。
   - 打分逻辑放在 `src/skills/relevance.ts` 新文件,纯函数,可单测。

3. **命中保底**:索引层注明"需要使用某技能时,可阅读其全文"——配一个新的轻量工具 `skill_read(name)`(见 §5 的最小版),模型可按需拉取未选中技能的全文。这样 top-k 漏选也不是硬损失。

4. **配置**(`skills` 节):
   ```yaml
   skills:
     relevance:
       enabled: true
       topK: 3
       minScore: 0.1
   ```

### 验证

- `tests/skills.test.ts` 新增:相关性排序正确性(构造两个技能,查询明显偏向其一);`minScore` 以下无全文注入;`enabled: false` 时输出与旧版完全一致(快照对比)。
- 关注指标:同一会话下开启前后的 system prompt 字符数。

---

## 4. [P1] Prompt 静态前置

### 问题

h2a2 明确为 vLLM 前缀缓存设计 prompt 结构(静态系统指令在前、动态内容在后)。vex-bot 的 `buildSystemPrompt` 分层顺序大体静态前置,但 `applyPromptInjections()` 把易变注入块(Persona 状态、当前时间、§1 的召回记忆)拼在技能全文**之前**的话,前缀缓存在注入点之后全部失效。

### 设计

1. **审计并固定分层顺序**(`src/agents/system-prompt.ts` 的 `buildSystemPrompt` + `src/agents/runtime.ts` 的注入拼接):
   - 稳定层(身份 → 环境 → 工具规则 → 技能)在前;
   - 易变层(时间戳、Persona 状态、记忆召回块、Previous Conversation Summary)**统一挪到尾部**,文档化为约定:"任何 per-turn 变化的注入只能追加到 prompt 末尾"。
2. 把这条约定写进 `src/agents/AGENTS.md`(变更卫生要求的一部分),防止后续 PR 把易变内容插回头部。

### 收益与边界

- 对自托管 vLLM/带前缀缓存的 provider:每轮可省掉几千 token 的 prefill。
- 对无缓存的云 API:顺序调整无负面影响,零成本。
- 这是纯重排,不改任何内容,回归风险极低。

---

## 5. [P2] 技能可执行化(结构化工具)

### 问题

vex-bot 技能只能"教模型做事"(prompt 指示模型去调 bash)。不可审计(不知道模型实际跑了什么)、不可限权(技能能引导模型调任何工具)、不可统计成本。

h2a2 证明了技能可以是可执行实体,但它的实现是反面教材:`subprocess.run(shell=True)` 直接执行 SKILL.md 里的 bash 块是命令注入水槽;executor_v2 是 647 行未接线的死代码。

### 设计(分两期)

**第一期(最小版,随 §3 落地):`skill_read` 工具**

- 一个只读工具:`skill_read(name)` 返回指定技能的全文。
- 配合 §3 的双层注入,解决"索引层看到了但没注入全文"的按需拉取。
- ~40 行,无可执行性,无安全风险。

**第二期(完整版,独立 RFC):声明式技能工具**

- SKILL.md frontmatter 新增可选字段:
  ```yaml
  executable:
    command: ["weather", "--json", "{location}"]   # 数组形式,execFile 无 shell
    timeoutMs: 30000
    params: { location: { type: "string", required: true } }
  ```
- 加载时把带 `executable` 的技能注册为独立工具(TypeBox 参数 schema 由 `params` 生成),执行走 `execFile`(数组参数、无 shell、环境变量走 bash 工具现有的 allowlist 机制)。
- **硬性安全约束**:
  - 永远不用 `shell: true`;命令数组首元素必须过 `binaryExists` 资格检查;
  - 工作目录限制在 agent 的 `allowedPaths` 内;
  - 进程纳入现有 `process-registry` 的 ownerKey 隔离,`disposeOwnerSessions` 一并清理。
- 明确不做:h2a2 的"投票选方案"(SkillVoting)和权限五级模型——vex-bot 的工具白名单(`tools` 策略过滤 + `group:*`)已覆盖限权需求。

### 验证

- 单元:参数 schema 生成、`{param}` 占位符替换、超时、非法二进制拒绝。
- 安全:构造含 `; rm -rf` 的参数,确认无 shell 注入面(参数永远作为单个 argv 传递)。

---

## 6. 实施路线图

| 里程碑 | 内容 | 依赖 |
|--------|------|------|
| **M1** | §1 记忆自动召回 + §2 写入去重 | 无,独立可交付 |
| **M2** | §3 技能相关性选择 + §5 第一期 `skill_read` | M1 不阻塞,可并行 |
| **M3** | §4 Prompt 静态前置(纯重排,随时可做) | 建议在 M1/M2 落定后做,一次性重排所有注入块 |
| **M4** | §5 第二期声明式技能工具 | 需独立 RFC 评审安全模型后再动工 |

每个里程碑独立成 PR,遵循仓库变更卫生要求:同步更新 README、`docs/`、相关 `AGENTS.md` 与 CHANGELOG。

---

## 7. 明确不采纳的 h2a2 做法

| h2a2 做法 | 拒绝理由 |
|-----------|---------|
| 每请求 `uv run python` subprocess 冷启动 | vex-bot 单进程内聚是核心优势;跨进程只用于重型可选能力(浏览器) |
| `user_id = workspace_id` 共享记忆 | 与 per-user 强制隔离直接冲突,隐私倒退 |
| 5 套技能匹配器 / 4 套意图分类并存 | 一个机制只做一遍;h2a2 自己的 executor_v2 就是 647 行死代码 |
| 朴素 `.replace()` 模板 + 硬编码部署路径 | vex-bot 的 inline prompt 组装更可靠 |
| 20000→10000→4000→6000 散落硬截断 | 截断应集中在一处 token 预算管理,而非到处埋雷 |
| 零向量查 Qdrant(`[0.0]*1024`) | 这是 bug 不是特性 |
| LangGraph 式 80 字段全局状态机 | vex-bot 的薄框架 + 强提示词在可维护性上更优;最多借鉴"声明式步骤定义"思想 |

---

## 8. 开放问题

1. **哈希嵌入的质量上限**:§1 和 §3 都依赖 `SimpleEmbedding` 的余弦相似度,它没有真语义理解(同义词落不同槽)。是否需要可选接入外部 embedding provider(`EmbeddingProvider` 接口已存在)?——建议先用关键词混合打分(记忆系统已是 `0.7 向量 + 0.3 关键词`)顶住,P1 之后再评估。
2. **去重阈值校准**:`0.85` 是拍脑袋起点,需要构造典型记忆语料(中文为主)实测分布后定默认值。
3. **技能索引层的体积**:索引层 itself 也随技能数线性增长(每个一行)。超过 ~100 个技能时需要第二级分页/分类,届时再设计。
