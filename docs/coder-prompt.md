# 任务：补齐 vex-bot 重写里被漏掉的模块集成

`vex-bot` 仓库的完整架构重写（TypeScript, Node/ESM, vitest）在 `rewrite/full-architecture` 分支上，`memory/`、`web/`（part 1-6d）、`cli/` 三大模块此前都已经过独立 review 通过（`docs/rewrite-plan.md` 的进度记录表里全部标 ✅）。

**但是**：这轮重写完成后做了第一次真实环境上线前测试（用真实 provider key 跑通了 WebChat + 微信双频道），过程中额外做了一次全局排查，发现**几个模块虽然本身写完、测试通过、review 通过，但从来没有被真正接到最终跑起来的系统里**——配置写了不生效，工具存在但 Agent 拿不到。这个 prompt 就是让你把这几个"接线"补上。

开始任何工作之前，先完整读完：

1. `docs/architecture.md` —— 目标架构，尤其**核心设计原则第5条**："No process-global state bleeding across instances"。
2. `docs/rewrite-plan.md` —— 进度记录表 + 最新加的"上线前真实环境测试发现"章节（记录了这轮之前修的 4 个真实 bug，可以了解排查过程和风格）。

## Part 1 审查结果：✅ 已通过（commit `c1bd22e` + 修复 `6c883b3`）

weather 工具改成无条件调用（跟 `image_analyze` 一样），测试同步改过来，725/725 全绿。memory/cron 的宽松门槛、`cron.ts` 类型清理、sharelink 不在范围内都确认没问题。

## Part 2 审查结果：✅ 已通过（commit `b784beb` + 修复 `1ce988b`）

`memoryManager` 构造条件改成只看 `memoryEnabled`（不再额外要求 `memoryCfg` 存在），"memory 完全缺失"和"memory 有 enabled:true 但没写 directory"这两个测试合并成一个循环断言，覆盖比之前更强。730/730 全绿。

## Part 3 审查结果：✅ 已通过（commit `2722480`）

`Agent.ts` 加了一个可选的 `skillsPrompt?: string` 字段，`cli/server.ts` 里 `effective.skills` 缺失或 `enabled:false` 时都不扫文件系统、`skillsPrompt` 是 `undefined`——这个"缺失就跳过"跟 Part 2 memory 那个 bug 长得像但审查确认不是同一类问题：skills 没有 memory 那种"工具列表里挂着一个看起来 enabled 但实际拿不到实例"的误导状态，就是纯粹的 system prompt 里一节内容有没有，我自己在 Part 3 规格里也是这么写的（缺失/关闭都应该是 undefined）。736/736 全绿，实际渲染出的 "# Available Skills"/"【技能模板】" 都核对过是真实格式不是巧合字符串匹配。

## Part 4 设计问题：✅ 已确认，可以开始写代码

四个设计问题的方案全部确认，一处修正：`PluginService` 已经有公开的 `activateAll()` 方法（`service.ts:139`），不需要再包一层——原方案里写的 `activateAllPlugins(pluginService.registry, deps)` 类型都过不了（`.registry` 是 `ReadonlyMap`，那个自由函数要可变 `Map`），直接调 `pluginService.activateAll()` 就行，只需要新增一个 `loadFromCandidates(candidates)` 方法桥接 `loadPlugins`。另外 `AgentRegistry.disposeEntry` 覆盖 `shutdown/reset/idle/overflow` 四种场景都会调 `entry.shutdown()`，所以 `Agent.shutdown()` 调 `pluginService?.shutdown()` 是唯一能盖住全部四种场景的位置，不只是"图方便"——只接 `WebServer.shutdown()` 会漏掉 idle 驱逐和 reset。`getStateDir` 记得给个真实实现（参考 memory/skills 那样按 userId 隔离目录），不用单独再开一轮确认。完整回复见 `docs/review-results.md`。

## Part 4 实现：✅ 已通过（commit `4d06f91`）

`PluginService.loadFromCandidates`（唯一新增方法）、`Agent.ts` 的 `pluginService?: AgentPluginService` 字段 + `shutdown()` 里先关插件再关 runtime、`cli/server.ts` 里per-Agent `ToolRegistry` + `PluginService` + `getStateDir` 全部跟确认过的设计一致，`activateAll()` 用的是已有公开方法（不是自由函数）。测试真的写了 CJS 插件文件到临时目录再动态 import，不是 mock 掉核心逻辑；per-user state dir 隔离是让 fixture 插件自己在 `register()` 里把 `api.getStateDir()` 写到一个全局变量来验证，验证的是插件真实拿到的值。743/743 全绿，`npm run build` 也过了。

记录一个已知、这轮范围外的遗留项：`tool_start`/`tool_end` hook 之前一直说"等 plugins/ 落地再接"，现在 plugins/ 真的接上了，但这两个事件还是没人 emit——插件作者写 `registerHook('tool_start', ...)` 会注册成功但永远不会被触发。不阻塞这轮，记在这里防止再次遗忘。

---

**补齐集成缺口的 4-part plan 全部完成**：memory/weather/cron/image 工具接线（Part 1）、`MemoryManager` 构造（Part 2）、skills 注入 system prompt（Part 3）、`PluginService` 接入（Part 4）。`memory/`、`skills/`、`plugins/` 这三个"写完测完 review 过、但从没被真正接入运行系统"的模块现在真的活了。

这轮任务到此结束。

## 铁律（照抄自之前几轮，继续有效）

1. **`_archive/` 只是只读参考**，新代码不能 `import` 它。读那里的实现和注释找历史教训，但代码要自己写。
2. **已经 ✅ 的模块是锁定的**，不要因为"更贴近 archive"就重写。这次任务恰恰相反——是要把已经锁定、已经写好的模块**接起来**，不是重新设计它们。如果你觉得某个已完成模块的接口不够用（比如需要新增一个字段/方法才能接上），可以改，但要在 review-request 里写清楚改了什么、为什么，逐条列出。
3. **不写兼容层、不写 adapter、不写 `@deprecated`。**
4. **保留安全相关行为**（SSRF 防护、路径穿越防护、per-owner 隔离等）。
5. **严格 TDD，没有例外。** 这次任务全部是"接线"性质的改动，每一条接线都要有一个先红后绿的集成测试证明"配置打开时功能真的生效、配置关闭/缺失时优雅降级"，不能只改代码不写测试。
6. **不要自己加范围。** 只接线，不要顺手重构已经审查通过的模块内部实现。
7. **一次只做一个 Part，做完再开始下一个。**
8. **`git add` 前用 `git status`/`git diff --cached --stat` 核对暂存区跟你的意图一致**，优先 `git add -A`。
9. **每个 Part 单独提交**，conventional commit，不加 `Co-Authored-By`，不要 push。
10. **代码和注释用英文。**
11. **对第三方库行为的假设要去读实际安装的源码验证**（`node_modules/@mariozechner/...`），不要凭推理。

## 每完成一个 Part 就必须停下来

跟之前的流程完全一样：写完、测试全绿、`tsc --noEmit` 干净、`git commit`，然后把 review-request **完整覆盖写入 `docs/review-inbox.md`**（不是追加），格式沿用之前的（What was built / Key design decisions / Tests / Current Progress / Questions），写完在对话里也贴一份，然后停下来等审查结果（写在 `docs/review-results.md`）。不自己判断"这个应该没问题"就继续下一个 Part。

---

## 发现的具体问题（4 项，按建议实现顺序排列）

### Part 1：`tools/builtin/index.ts` 从未真正创建 memory/weather/cron/image 工具

**证据**：`src/tools/builtin/index.ts` 第 96-99 行：
```ts
// Image analyze, weather, memory, cron, sharelink tools — ported by
// separate sub-tickets; add them here once their modules land.

return tools;
```
这行注释后面直接 `return tools`，什么都没加。但 `createMemoryTools`（`memory.ts`）、`createWeatherTool`（`weather.ts`）、`createCronTools`（`cron.ts`）、`createImageAnalyzeTool`（`image.ts`）全部已经实现且有测试（`tools/` 那轮 review，116 个新测试）。`BuiltinToolsOptions` 接口里也已经声明了 `memory?`/`weather?`/`memoryManager?`/`cronService?`/`enableMemory?`/`enableCron?` 这些字段——接口都定义好了，函数体里就是没用上。

**要做的**：在 `createBuiltinTools()` 函数体里，仿照 `filesystem`/`bash` 那两段已有的写法，加上：
- `enableMemory !== false` 时调用 `createMemoryTools({ manager: options?.memoryManager })`（注意 `MemoryToolsOptions.manager` 是可选的——不传时工具本身会走"disabled"降级，这是已经测试过的行为，不用在这里重新判断要不要加）。
- weather：检查 `options?.weather` 是否给了配置（比如 `defaultLocation`/`provider` 等），有就调用 `createWeatherTool(options.weather)`。
- `enableCron !== false` 时调用 `createCronTools({ service: options?.cronService })`。
- image：调用 `createImageAnalyzeTool(...)`（读一下它的参数签名，跟 `weather`/`memory` 一样处理）。

### Part 2：`cli/server.ts` 从未构造 `MemoryManager`，也没把它/`weather`/`CronService` 传给 tools

**证据**：`src/cli/server.ts` 的 `buildAgentFactory` 里，`createBuiltinTools({ owner: ... })` 只传了 `owner` 一个字段。`memory/` 模块（`MemoryManager`/`createMemoryManager`，`memory/index.ts`）在整个 `cli/server.ts` 里没有被 import 过。`weather` 配置（`SystemConfig.weather`，`config.ts` 里已经定义过 schema）同样没被读取传递。`CronService` 实例本身在 `startWebServer` 里已经构造了（给 cron 调度用），但没有传给 `createBuiltinTools`。

**要做的**：
- `EffectiveConfig.memory`（`config/EffectiveConfig.ts` 已经定义了 `memory?: {enabled?, directory?, embeddingModel?, embeddingProvider?}`，`ConfigStore.resolve()` 会正确按 (userId, channelId) 解析出来，这部分不用动）——`buildAgentFactory(userId, channelId, config)` 里用 `effective.memory` 构造 `createMemoryManager({...})`（`memory/index.ts` 的工厂函数），directory 建议按用户隔离（比如 `join(homedir(), ".vex", "memory", userId)`，具体参考 archive 里 `memory/` 目录的组织方式，如果有的话；如果 archive 没有清晰先例，在 review-request 里写清楚你的选择和理由）。
- `weather` 是系统级配置（不在 `EffectiveConfig` 里，因为 `EffectiveConfig` 是 per-user 的，天气这种一般不个性化），从传入 `startWebServer` 的 `SystemConfig.weather` 读，参考 `getWeixinConfig` 那种"系统级 section 直接从 SystemConfig 读"的写法。
- 把这两者 + 已经存在的 `cron` 变量一起传进 `createBuiltinTools({ owner, memoryManager, weather, cronService: cron, enableMemory: ..., enableCron: ... })`（enable flag 从对应 config 的 `enabled` 字段读，默认 true，除非配置里显式关闭）。
- `MemoryManager` 的生命周期：`buildAgentFactory` 是每次 `AgentRegistry.getOrCreate` 缺失entry 时才调用一次（有并发构建共享保护），所以在这里构造是安全的、per-Agent 的，不会重复初始化。不需要额外的 dispose 逻辑，除非 `MemoryManager`/`JsonMemoryStore` 有需要显式关闭的资源（去读一下 `memory/MemoryManager.ts` 确认，如果没有就不用加）。

### Part 3：Skills 从未被注入进 system prompt

**证据**：`agent/SystemPromptAssembler.ts` 已经预留了第4节 `sections.skills`（"【技能模板】"），但 `agent/Agent.ts` 里唯一调用 `assembleSystemPrompt(...)` 的地方（`processMessage` 方法里）只传了 `persona`：
```ts
const systemPrompt = assembleSystemPrompt({
  persona: personaBlock || undefined,
});
```
`skills/{SkillLoader,SkillRegistry,SkillInjector}`（341 测试）在 `cli/server.ts` 里同样零引用。

**要做的**（这个会碰到已锁定模块 `Agent.ts`，按铁律第2条要求，改动理由已经在上面写清楚了）：
- `buildAgentFactory` 里用 `effective.skills`（已经是 per-user 解析好的：`enabled?`/`userDir?`/`workspaceDir?`/`disabled?`/`only?`）构造一个 `SkillRegistry`，调用 `loadAllSkills(...)`（`SkillLoader.ts`）载入，用 `SkillInjector.buildPrompt(registry)` 生成 skills 提示词片段。
- 这个片段需要传进 `new Agent(userId, effective, {pipeline, persona, runtime, ...})`——去看 `Agent.ts` 构造函数现在的参数类型，加一个可选的 `skillsPrompt?: string` 字段（或者你觉得更合适的命名/形状，写清楚理由），`processMessage` 里 `assembleSystemPrompt({persona, skills: this.skillsPrompt})`。
- `effective.skills.enabled === false` 或 `effective.skills` 缺失时，`skillsPrompt` 应该是 `undefined`（不注入这一节），不要因为没配置就报错或跳过整个 Agent 构造。
- 加载时机：是每次 `buildAgentFactory` 调用时都重新扫描文件系统（简单但有 IO 开销），还是要有缓存？先按"每次都重新扫描"做最简单的版本，除非你发现这样会导致明显的性能或正确性问题——不要在这里过度设计。

### Part 4：`PluginService` 从未被实例化过（预计工作量最大，建议放最后）

**证据**：全仓库 `grep -rln "PluginService" src/` 只在 `plugins/` 自己的模块文件（`plugins/{index,service,types,loader}.ts`）里出现，`cli/server.ts`/`web/server.ts` 一次都没有。这个模块（500 测试）review 通过时明确记录过"下一步集成点：bootstrap 构造 `PluginService(deps)`"，这个"下一步"从来没发生。

**这个 Part 在动手前，先在 review-request 里回答清楚这几个设计问题，不要直接实现**（因为涉及真正的架构决策，不是照抄一个现成的接口）：
1. `PluginService` 的生命周期粒度——每个 (userId, channelId) 一个实例（跟 `AgentRuntime`/`MemoryManager` 一样在 `buildAgentFactory` 里构造），还是进程级单例（跟 `CronService` 一样）？`plugins/` review 时的说法是"per-(user, channel) 隔离天然落地"，倾向于前者，但要你确认一下 `PluginApi`/`ToolRegistry`/`EventBus` 注入方式跟"每个 Agent 一个 PluginService"是否真的兼容。
2. 插件注册的工具（通过 `PluginApi` 里的 `ToolRegistry`）最终要怎么进到 `createBuiltinTools()` 返回的工具列表里？是 `Agent.ts` 在构造 `AgentRuntime` 的 `customTools` 时把 `pluginService`拿到的工具 `.concat()` 进去，还是别的机制？
3. 插件的文件系统扫描路径（`discovery.ts` 的 bundled→global→workspace 三层）在这次多用户架构里，"workspace" 具体指哪个目录？（archive 里可能是进程 cwd，新架构下每个用户/频道有没有独立的 workspace 概念，参考 `skills/` 那边 `userDir`/`workspaceDir` 的处理方式）
4. 需不需要在 `WebServer.shutdown()` 或者 `AgentRegistry` 的 dispose 路径上调用 `PluginService.shutdown()`？

先把这四个问题的回答写进 review-request，我确认设计方向之后你再写代码，不要先实现再解释。

---

## 从哪开始

**Part 1 → Part 2 → Part 3 → Part 4**，每个 Part 走完整 TDD + 提交 + review-request + 等结果的流程。Part 1 和 Part 2 关联紧密（interface 已经声明好了，只是没调用/没传参），可以放在同一轮一起做，但仍然要在 review-request 里分开说清楚每一处改动。Part 4 动手前必须先在 review-request 里回答上面那四个设计问题。

Skills（Part 3）里提到的"要不要改 `Agent.ts` 构造函数"，以及 Part 4 的四个设计问题，如果你有更好的方案，可以在 review-request 里提出来讨论，不是必须完全照我写的做——但要先说清楚理由，不要直接改完再解释。
