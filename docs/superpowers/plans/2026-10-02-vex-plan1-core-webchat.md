# Vex 计划 1：核心 + WebChat 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付可运行的 `vexd` 守护进程与 WebChat：在浏览器里与基于 pi-agent-core 的 agent 进行多会话、流式、可插话与中断的对话，agent 可使用文件与 bash 工具，危险操作经网页审批。

**Architecture:** `vexd` 进程内由 `SessionManager` 管理若干 `Session`，每个 `Session` 包装一个 pi `Agent`，消息持久化为 JSONL；模型请求经 pi-ai 的 `Models` 集合（内置提供方 + 配置中的自定义提供方）发出；system prompt 在每次模型请求前由工作区 Markdown 文件组装；工具调用经 `ToolPolicy` + `ApprovalManager` 在 `beforeToolCall` 中把关；`Gateway` 以 HTTP + WebSocket 向浏览器提供静态前端与 TypeBox 定义的协议。

**Tech Stack:** Node.js ≥ 24、TypeScript（ESM、strict）、`@earendil-works/pi-ai` 1.x、`@earendil-works/pi-agent-core` 1.x、`typebox` 1.3、`ws`、`yaml`、`pino`、Vitest。

**Spec:** `docs/superpowers/specs/2026-10-02-vex-design.md`

## Global Constraints

- 运行时 Node.js ≥ 24；`package.json` 的 `engines.node` 为 `>=24`
- ESM only：`"type": "module"`，NodeNext 解析，源码 import 写 `.js` 扩展名
- TypeScript：`strict`、`noUncheckedIndexedAccess`、`noImplicitReturns`、`noFallthroughCasesInSwitch`；不使用 `@ts-ignore`
- 代码注释用英文、一行、只写不明显的原因；用户可见文案（错误信息、prompt、界面）用中文
- 不使用进程级可变单例；所有状态挂在类实例上，依赖经构造参数传入
- 数据目录默认 `~/.vex/`，可用环境变量 `VEX_HOME` 覆盖；测试一律使用临时目录
- 工作区默认 `~/.vex/workspace/`，可由配置 `workspace` 覆盖
- WebChat 默认监听 `127.0.0.1:7860`；`web.host` 非本机地址时必须设置 `web.token`
- 审批超时 10 分钟视为拒绝
- 模型调用失败指数退避重试最多 3 次（1s、2s、4s），仍失败则把错误原因发回当前窗口
- 常驻文件行数上限：`SOUL.md` 200 行、`USER.md` 200 行、`MEMORY.md` 100 行
- 每个任务结束时 `npm run lint` 与 `npm test` 必须通过
- 提交信息末尾附：`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## 文件结构

```
package.json, tsconfig.json, tsconfig.build.json, vitest.config.ts, .gitignore
scripts/copy-static.mjs          构建时复制前端静态文件到 dist
src/
  paths.ts                       数据目录路径、~ 展开
  logger.ts                      pino 日志
  daemon.ts                      组装全部组件，启动/停止 vexd
  store/atomic.ts                原子写文件
  store/jsonl.ts                 JSONL 追加与读取
  config/schema.ts               配置 TypeBox schema 与 VexConfig 类型
  config/load.ts                 读取、校验、保存 config.yaml
  providers/models.ts            模型解析与 API key 获取
  workspace/templates.ts         工作区文件模板
  workspace/workspace.ts         创建工作区、读取工作区文件
  context/prompt.ts              system prompt 组装
  tools/paths.ts                 工具路径解析
  tools/summary.ts               工具参数摘要
  tools/fs.ts                    read / write / edit
  tools/bash.ts                  bash
  tools/search.ts                grep / find
  tools/registry.ts              核心工具集合
  policy/policy.ts               工具审批策略
  policy/approvals.ts            挂起审批管理
  policy/gate.ts                 beforeToolCall 把关
  core/events.ts                 事件类型与 EventBus
  core/session.ts                Session（包装 pi Agent）
  core/webSessions.ts            WebChat 会话索引
  core/title.ts                  会话标题生成
  core/sessionManager.ts         SessionManager
  protocol/messages.ts           WebChat ↔ vexd 协议
  gateway/auth.ts                口令与 cookie
  gateway/server.ts              HTTP + WebSocket 服务
  web/static/index.html, login.html, app.js, style.css   WebChat 前端
  cli/index.ts                   vex 命令入口
  cli/process.ts                 pid 文件与进程管理
  cli/onboard.ts                 首次配置向导
tests/
  helpers/faux.ts                假模型工具
  helpers/tmp.ts                 临时目录工具
  *.test.ts
```

---
### Task 1: 项目骨架、路径与存储工具

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `.gitignore`, `scripts/copy-static.mjs`
- Create: `src/paths.ts`, `src/store/atomic.ts`, `src/store/jsonl.ts`
- Create: `tests/helpers/tmp.ts`
- Test: `tests/paths.test.ts`, `tests/store.test.ts`

**Interfaces:**
- Produces:
  - `interface VexPaths { home; config; sessions; webSessions; logs; logFile; pidFile; defaultWorkspace }`（均为绝对路径字符串）
  - `resolvePaths(home?: string): VexPaths`
  - `expandHome(p: string): string`
  - `writeFileAtomic(path: string, data: string): Promise<void>`
  - `appendJsonl(path: string, record: unknown): Promise<void>`
  - `readJsonl<T = unknown>(path: string): Promise<T[]>`
  - 测试工具 `makeTmpDir(): Promise<string>`、`removeTmpDir(dir: string): Promise<void>`

- [ ] **Step 1: 写入项目配置文件**

`package.json`：

```json
{
  "name": "vex-bot",
  "version": "3.0.0",
  "description": "个人 AI 助手",
  "type": "module",
  "bin": {
    "vex": "./dist/cli/index.js"
  },
  "engines": {
    "node": ">=24"
  },
  "files": [
    "dist/**"
  ],
  "scripts": {
    "build": "node -e \"require('node:fs').rmSync('dist',{recursive:true,force:true})\" && tsc -p tsconfig.build.json && node scripts/copy-static.mjs",
    "dev": "tsx src/cli/index.ts start",
    "lint": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@earendil-works/pi-agent-core": "^1.0.0",
    "@earendil-works/pi-ai": "^1.0.0",
    "pino": "^9.4.0",
    "typebox": "^1.3.27",
    "ws": "^8.18.0",
    "yaml": "^2.5.1"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "@types/ws": "^8.5.12",
    "tsx": "^4.19.1",
    "typescript": "^5.9.3",
    "vitest": "^2.1.1"
  }
}
```

`tsconfig.json`（类型检查，含测试）：

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023"],
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "noEmit": true
  },
  "include": ["src/**/*.ts", "tests/**/*.ts", "vitest.config.ts"]
}
```

`tsconfig.build.json`（产出 dist）：

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "rootDir": "./src",
    "outDir": "./dist",
    "sourceMap": true
  },
  "include": ["src/**/*.ts"]
}
```

`vitest.config.ts`：

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 20_000,
  },
});
```

`.gitignore`：

```
node_modules/
dist/
coverage/
*.log
```

`scripts/copy-static.mjs`：

```js
import { cpSync } from "node:fs";

cpSync("src/web/static", "dist/web/static", { recursive: true });
```

- [ ] **Step 2: 安装依赖**

Run: `npm install`
Expected: 安装成功，生成 `package-lock.json`。

- [ ] **Step 3: 写失败的测试**

`tests/helpers/tmp.ts`：

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "vex-test-"));
}

export async function removeTmpDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
```

`tests/paths.test.ts`：

```ts
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { expandHome, resolvePaths } from "../src/paths.js";

describe("resolvePaths", () => {
  const saved = process.env.VEX_HOME;
  afterEach(() => {
    if (saved === undefined) delete process.env.VEX_HOME;
    else process.env.VEX_HOME = saved;
  });

  it("derives every path from the given home", () => {
    const p = resolvePaths("/data/vex");
    expect(p).toEqual({
      home: "/data/vex",
      config: "/data/vex/config.yaml",
      sessions: "/data/vex/sessions",
      webSessions: "/data/vex/sessions/web",
      logs: "/data/vex/logs",
      logFile: "/data/vex/logs/vexd.log",
      pidFile: "/data/vex/vexd.pid",
      defaultWorkspace: "/data/vex/workspace",
    });
  });

  it("uses VEX_HOME when no home is given", () => {
    process.env.VEX_HOME = "/env/vex";
    expect(resolvePaths().home).toBe("/env/vex");
  });

  it("defaults to ~/.vex", () => {
    delete process.env.VEX_HOME;
    expect(resolvePaths().home).toBe(join(homedir(), ".vex"));
  });
});

describe("expandHome", () => {
  it("expands a leading ~", () => {
    expect(expandHome("~")).toBe(homedir());
    expect(expandHome("~/notes")).toBe(join(homedir(), "notes"));
  });

  it("leaves other paths alone", () => {
    expect(expandHome("/abs/~x")).toBe("/abs/~x");
    expect(expandHome("rel/path")).toBe("rel/path");
  });
});
```

`tests/store.test.ts`：

```ts
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileAtomic } from "../src/store/atomic.js";
import { appendJsonl, readJsonl } from "../src/store/jsonl.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

let dir: string;
beforeEach(async () => { dir = await makeTmpDir(); });
afterEach(async () => { await removeTmpDir(dir); });

describe("writeFileAtomic", () => {
  it("creates parent directories and writes content without leaving temp files", async () => {
    const file = join(dir, "a", "b", "c.txt");
    await writeFileAtomic(file, "hello");
    expect(await readFile(file, "utf8")).toBe("hello");
    expect(await readdir(join(dir, "a", "b"))).toEqual(["c.txt"]);
  });

  it("replaces existing content", async () => {
    const file = join(dir, "c.txt");
    await writeFileAtomic(file, "one");
    await writeFileAtomic(file, "two");
    expect(await readFile(file, "utf8")).toBe("two");
  });
});

describe("jsonl", () => {
  it("returns an empty list for a missing file", async () => {
    expect(await readJsonl(join(dir, "missing.jsonl"))).toEqual([]);
  });

  it("appends records in order", async () => {
    const file = join(dir, "s", "log.jsonl");
    await appendJsonl(file, { n: 1 });
    await appendJsonl(file, { n: 2 });
    expect(await readJsonl(file)).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("skips a torn trailing line", async () => {
    const file = join(dir, "log.jsonl");
    await writeFile(file, '{"n":1}\n{"n":2}\n{"n":', "utf8");
    expect(await readJsonl(file)).toEqual([{ n: 1 }, { n: 2 }]);
  });
});
```

- [ ] **Step 4: 运行测试确认失败**

Run: `npx vitest run tests/paths.test.ts tests/store.test.ts`
Expected: FAIL，提示无法解析 `../src/paths.js` 等模块。

- [ ] **Step 5: 实现**

`src/paths.ts`：

```ts
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface VexPaths {
  home: string;
  config: string;
  sessions: string;
  webSessions: string;
  logs: string;
  logFile: string;
  pidFile: string;
  defaultWorkspace: string;
}

export function resolvePaths(home?: string): VexPaths {
  const root = resolve(home ?? process.env.VEX_HOME ?? join(homedir(), ".vex"));
  return {
    home: root,
    config: join(root, "config.yaml"),
    sessions: join(root, "sessions"),
    webSessions: join(root, "sessions", "web"),
    logs: join(root, "logs"),
    logFile: join(root, "logs", "vexd.log"),
    pidFile: join(root, "vexd.pid"),
    defaultWorkspace: join(root, "workspace"),
  };
}

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}
```

`src/store/atomic.ts`：

```ts
import { randomBytes } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function writeFileAtomic(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, data, "utf8");
  await rename(tmp, path);
}
```

`src/store/jsonl.ts`：

```ts
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function appendJsonl(path: string, record: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
}

export async function readJsonl<T = unknown>(path: string): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const records: T[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as T);
    } catch {
      // A crash mid-append can leave one torn line; everything before it is intact.
    }
  }
  return records;
}
```

- [ ] **Step 6: 运行测试与类型检查**

Run: `npx vitest run tests/paths.test.ts tests/store.test.ts && npm run lint`
Expected: 全部 PASS，tsc 无输出。

- [ ] **Step 7: 提交**

```bash
git add package.json package-lock.json tsconfig.json tsconfig.build.json vitest.config.ts .gitignore scripts src tests
git commit -m "feat: project scaffold, data paths and file stores

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 配置加载与校验

**Files:**
- Create: `src/config/schema.ts`, `src/config/load.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: `VexPaths`、`expandHome`、`writeFileAtomic`（Task 1）
- Produces:
  - `type Decision = "allow" | "ask" | "deny"`
  - `type ThinkingSetting = "off" | "minimal" | "low" | "medium" | "high" | "xhigh"`
  - `interface ModelRef { provider: string; id: string; thinking?: ThinkingSetting }`
  - `interface CustomModelConfig { id: string; contextWindow?: number; maxTokens?: number; reasoning?: boolean; input?: ("text" | "image")[] }`
  - `interface ProviderConfig { apiKey?: string; api?: "openai-completions" | "anthropic-messages"; baseUrl?: string; models?: CustomModelConfig[] }`
  - `interface VexConfig { model: ModelRef; backgroundModel: ModelRef; providers: Record<string, ProviderConfig>; web: { host: string; port: number; token?: string }; workspace: string; toolPolicy: Record<string, Decision>; bashEnvPassthrough: string[] }`
  - `class ConfigError extends Error`
  - `parseConfig(text: string, paths: VexPaths): VexConfig`
  - `loadConfig(paths: VexPaths): Promise<{ config: VexConfig; text: string }>`
  - `saveConfigText(paths: VexPaths, text: string): Promise<void>`（先校验，校验失败抛 `ConfigError` 且不写文件）

配置文件允许出现本计划未使用的键（`wechat`、`mcpServers`、`persona` 等后续计划的配置），校验只约束本计划用到的键。

- [ ] **Step 1: 写失败的测试**

`tests/config.test.ts`：

```ts
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig, parseConfig, saveConfigText } from "../src/config/load.js";
import { resolvePaths, type VexPaths } from "../src/paths.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

let dir: string;
let paths: VexPaths;
beforeEach(async () => {
  dir = await makeTmpDir();
  paths = resolvePaths(dir);
});
afterEach(async () => { await removeTmpDir(dir); });

const minimal = "model:\n  provider: deepseek\n  id: deepseek-v4-pro\n";

describe("parseConfig", () => {
  it("fills defaults for a minimal config", () => {
    const config = parseConfig(minimal, paths);
    expect(config).toEqual({
      model: { provider: "deepseek", id: "deepseek-v4-pro" },
      backgroundModel: { provider: "deepseek", id: "deepseek-v4-pro" },
      providers: {},
      web: { host: "127.0.0.1", port: 7860, token: undefined },
      workspace: join(dir, "workspace"),
      toolPolicy: {},
      bashEnvPassthrough: [],
    });
  });

  it("reads every supported key", () => {
    const text = [
      "model: { provider: deepseek, id: deepseek-v4-pro, thinking: high }",
      "backgroundModel: { provider: deepseek, id: deepseek-flash }",
      "providers:",
      "  stepfun:",
      "    api: openai-completions",
      "    baseUrl: https://api.stepfun.com/v1",
      "    apiKey: sk-1",
      "    models: [{ id: step-2-16k, contextWindow: 16000 }]",
      "web: { host: 0.0.0.0, port: 9000, token: secret }",
      "workspace: ~/vex-ws",
      "tools: { policy: { bash: allow } }",
      "bashEnvPassthrough: [GITHUB_TOKEN]",
    ].join("\n");
    const config = parseConfig(text, paths);
    expect(config.model.thinking).toBe("high");
    expect(config.backgroundModel.id).toBe("deepseek-flash");
    expect(config.providers.stepfun?.models?.[0]).toEqual({ id: "step-2-16k", contextWindow: 16000 });
    expect(config.web).toEqual({ host: "0.0.0.0", port: 9000, token: "secret" });
    expect(config.workspace).toBe(join(homedir(), "vex-ws"));
    expect(config.toolPolicy).toEqual({ bash: "allow" });
    expect(config.bashEnvPassthrough).toEqual(["GITHUB_TOKEN"]);
  });

  it("resolves a relative workspace against the data directory", () => {
    const config = parseConfig(`${minimal}workspace: ws\n`, paths);
    expect(config.workspace).toBe(join(dir, "ws"));
  });

  it("treats an empty token as no token", () => {
    expect(parseConfig(`${minimal}web: { token: "" }\n`, paths).web.token).toBeUndefined();
  });

  it("accepts keys used by other modules", () => {
    expect(() => parseConfig(`${minimal}wechat: { enabled: true }\nmcpServers: {}\n`, paths)).not.toThrow();
  });

  it("rejects invalid YAML", () => {
    expect(() => parseConfig("model: [", paths)).toThrow(ConfigError);
  });

  it("reports the failing path for schema errors", () => {
    expect(() => parseConfig("model: { provider: deepseek }\n", paths)).toThrow(/\/model/);
    expect(() => parseConfig(`${minimal}tools: { policy: { bash: maybe } }\n`, paths)).toThrow(/\/tools\/policy\/bash/);
  });
});

describe("loadConfig / saveConfigText", () => {
  it("explains how to create a missing config", async () => {
    await expect(loadConfig(paths)).rejects.toThrow(/vex onboard/);
  });

  it("loads the file and returns its text", async () => {
    await writeFile(paths.config, minimal, "utf8");
    const { config, text } = await loadConfig(paths);
    expect(config.model.id).toBe("deepseek-v4-pro");
    expect(text).toBe(minimal);
  });

  it("saves valid text and refuses invalid text without touching the file", async () => {
    await saveConfigText(paths, minimal);
    expect(await readFile(paths.config, "utf8")).toBe(minimal);
    await expect(saveConfigText(paths, "model: 1\n")).rejects.toThrow(ConfigError);
    expect(await readFile(paths.config, "utf8")).toBe(minimal);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL，无法解析 `../src/config/load.js`。

- [ ] **Step 3: 实现**

`src/config/schema.ts`：

```ts
import { Type, type Static } from "typebox";

export const DecisionSchema = Type.Union([Type.Literal("allow"), Type.Literal("ask"), Type.Literal("deny")]);

const ThinkingSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);

const ModelRefSchema = Type.Object({
  provider: Type.String({ minLength: 1 }),
  id: Type.String({ minLength: 1 }),
  thinking: Type.Optional(ThinkingSchema),
});

const CustomModelSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  contextWindow: Type.Optional(Type.Integer({ minimum: 1 })),
  maxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
  reasoning: Type.Optional(Type.Boolean()),
  input: Type.Optional(Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]))),
});

const ProviderSchema = Type.Object({
  apiKey: Type.Optional(Type.String()),
  api: Type.Optional(Type.Union([Type.Literal("openai-completions"), Type.Literal("anthropic-messages")])),
  baseUrl: Type.Optional(Type.String({ minLength: 1 })),
  models: Type.Optional(Type.Array(CustomModelSchema)),
});

export const ConfigSchema = Type.Object({
  model: ModelRefSchema,
  backgroundModel: Type.Optional(ModelRefSchema),
  providers: Type.Optional(Type.Record(Type.String(), ProviderSchema)),
  web: Type.Optional(
    Type.Object({
      host: Type.Optional(Type.String({ minLength: 1 })),
      port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
      token: Type.Optional(Type.String()),
    }),
  ),
  workspace: Type.Optional(Type.String({ minLength: 1 })),
  tools: Type.Optional(Type.Object({ policy: Type.Optional(Type.Record(Type.String(), DecisionSchema)) })),
  bashEnvPassthrough: Type.Optional(Type.Array(Type.String())),
});

export type Decision = Static<typeof DecisionSchema>;
export type ThinkingSetting = Static<typeof ThinkingSchema>;
export type ModelRef = Static<typeof ModelRefSchema>;
export type CustomModelConfig = Static<typeof CustomModelSchema>;
export type ProviderConfig = Static<typeof ProviderSchema>;

export interface VexConfig {
  model: ModelRef;
  backgroundModel: ModelRef;
  providers: Record<string, ProviderConfig>;
  web: { host: string; port: number; token?: string };
  workspace: string;
  toolPolicy: Record<string, Decision>;
  bashEnvPassthrough: string[];
}
```

`src/config/load.ts`：

```ts
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Value } from "typebox/value";
import { parse } from "yaml";
import { expandHome, type VexPaths } from "../paths.js";
import { writeFileAtomic } from "../store/atomic.js";
import { ConfigSchema, type VexConfig } from "./schema.js";

export class ConfigError extends Error {}

export function parseConfig(text: string, paths: VexPaths): VexConfig {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    throw new ConfigError(`config.yaml 不是合法的 YAML：${(err as Error).message}`);
  }
  if (!Value.Check(ConfigSchema, raw)) {
    const details = [...Value.Errors(ConfigSchema, raw)]
      .slice(0, 5)
      .map((e) => `${e.instancePath || "/"} ${e.message}`)
      .join("；");
    throw new ConfigError(`config.yaml 校验失败：${details}`);
  }
  return {
    model: raw.model,
    backgroundModel: raw.backgroundModel ?? raw.model,
    providers: raw.providers ?? {},
    web: {
      host: raw.web?.host ?? "127.0.0.1",
      port: raw.web?.port ?? 7860,
      token: raw.web?.token || undefined,
    },
    workspace: raw.workspace ? resolve(paths.home, expandHome(raw.workspace)) : paths.defaultWorkspace,
    toolPolicy: raw.tools?.policy ?? {},
    bashEnvPassthrough: raw.bashEnvPassthrough ?? [],
  };
}

export async function loadConfig(paths: VexPaths): Promise<{ config: VexConfig; text: string }> {
  let text: string;
  try {
    text = await readFile(paths.config, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ConfigError(`找不到配置文件 ${paths.config}，请先运行 vex onboard`);
    }
    throw err;
  }
  return { config: parseConfig(text, paths), text };
}

export async function saveConfigText(paths: VexPaths, text: string): Promise<void> {
  parseConfig(text, paths);
  await writeFileAtomic(paths.config, text);
}
```

- [ ] **Step 4: 运行测试与类型检查**

Run: `npx vitest run tests/config.test.ts && npm run lint`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/config tests/config.test.ts
git commit -m "feat: config loading and validation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 模型解析

**Files:**
- Create: `src/providers/models.ts`, `tests/helpers/faux.ts`
- Test: `tests/models.test.ts`

**Interfaces:**
- Consumes: `ModelRef`、`ProviderConfig`（Task 2）
- Produces:
  - `class ModelResolutionError extends Error`
  - `type CompleteFn = (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => Promise<AssistantMessage>`
  - `interface ModelRegistry { resolve(ref: ModelRef): Model<Api>; getApiKey(provider: string): string | undefined; streamFn: StreamFn; completeSimple: CompleteFn }`
  - `createModelRegistry(providers: Record<string, ProviderConfig>, base?: MutableModels): ModelRegistry`（`base` 默认为 `builtinModels()`；测试传入挂了 faux 提供方的集合）
  - 测试辅助（`tests/helpers/faux.ts`，后续任务的测试共用）：`createFaux(tokensPerSecond?: number): FauxProviderHandle`、`fauxModels(faux): MutableModels`、`fauxStreamFn(faux): StreamFn`、`lastUserText(context: TranscriptContext): string`

规则（spec §12）：
- `providers.<名称>` 同时声明了 `api` 与 `baseUrl` 时，用 `createProvider()` 注册为自定义提供方：声明了 `models` 时只接受列表中的 id，未声明时接受任意 id。
- 其余提供方必须是 `base` 集合中已有的提供方，模型 id 精确匹配（区分大小写），找不到时列出可用 id。
- `getApiKey` 返回配置中的 `apiKey`；未配置时返回 `undefined`，由 pi-ai 按提供方约定的环境变量（如 `DEEPSEEK_API_KEY`）解析。
- `streamFn` 交给 pi `Agent`；`completeSimple` 用于标题生成等后台调用。

- [ ] **Step 1: 写测试辅助与失败的测试**

`tests/helpers/faux.ts`：

```ts
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createModels,
  fauxProvider,
  type FauxProviderHandle,
  type MutableModels,
  type TranscriptContext,
} from "@earendil-works/pi-ai";

export function createFaux(tokensPerSecond?: number): FauxProviderHandle {
  return fauxProvider(tokensPerSecond ? { tokensPerSecond } : {});
}

export function fauxModels(faux: FauxProviderHandle): MutableModels {
  const models = createModels();
  models.setProvider(faux.provider);
  return models;
}

export function fauxStreamFn(faux: FauxProviderHandle): StreamFn {
  const models = fauxModels(faux);
  return (model, context, options) => models.streamSimple(model, context, options);
}

export function lastUserText(context: TranscriptContext): string {
  const last = [...context.messages].reverse().find((m) => m.role === "user");
  if (!last || last.role !== "user") return "";
  return typeof last.content === "string"
    ? last.content
    : last.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}
```

`tests/models.test.ts`：

```ts
import { createModels, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";
import { createModelRegistry, ModelResolutionError } from "../src/providers/models.js";
import { createFaux } from "./helpers/faux.js";

const firstDeepseek = getBuiltinModels("deepseek")[0]!;

describe("createModelRegistry", () => {
  it("resolves a built-in model", () => {
    const model = createModelRegistry({}).resolve({ provider: "deepseek", id: firstDeepseek.id });
    expect(model.id).toBe(firstDeepseek.id);
    expect(model.api).toBe(firstDeepseek.api);
    expect(model.baseUrl).toBe(firstDeepseek.baseUrl);
  });

  it("matches model ids case-sensitively and lists the available ids", () => {
    const registry = createModelRegistry({});
    const wrongCase = firstDeepseek.id.toUpperCase();
    expect(() => registry.resolve({ provider: "deepseek", id: wrongCase })).toThrow(ModelResolutionError);
    expect(() => registry.resolve({ provider: "deepseek", id: wrongCase })).toThrow(firstDeepseek.id);
  });

  it("rejects an unknown provider", () => {
    expect(() => createModelRegistry({}).resolve({ provider: "nope", id: "x" })).toThrow(/未知的模型提供方 "nope"/);
  });

  it("builds a declared custom model", () => {
    const registry = createModelRegistry({
      stepfun: {
        api: "openai-completions",
        baseUrl: "https://api.stepfun.com/v1",
        models: [{ id: "step-2-16k", contextWindow: 16000, reasoning: true }],
      },
    });
    expect(registry.resolve({ provider: "stepfun", id: "step-2-16k" })).toEqual({
      id: "step-2-16k",
      name: "step-2-16k",
      api: "openai-completions",
      provider: "stepfun",
      baseUrl: "https://api.stepfun.com/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 16000,
      maxTokens: 8192,
    });
    expect(() => registry.resolve({ provider: "stepfun", id: "other" })).toThrow(/未声明模型 "other"/);
  });

  it("accepts any id for a custom provider without a model list", () => {
    const registry = createModelRegistry({
      ollama: { api: "openai-completions", baseUrl: "http://127.0.0.1:11434/v1" },
    });
    const model = registry.resolve({ provider: "ollama", id: "qwen3:14b" });
    expect(model.id).toBe("qwen3:14b");
    expect(model.contextWindow).toBe(128000);
  });

  it("returns the configured api key", () => {
    const registry = createModelRegistry({ deepseek: { apiKey: "from-config" } });
    expect(registry.getApiKey("deepseek")).toBe("from-config");
    expect(registry.getApiKey("moonshotai-cn")).toBeUndefined();
  });

  it("streams and completes through the collection", async () => {
    const faux = createFaux();
    const base = createModels();
    base.setProvider(faux.provider);
    const registry = createModelRegistry({}, base);
    const model = registry.resolve({ provider: faux.getModel().provider, id: faux.getModel().id });
    faux.setResponses([fauxAssistantMessage("hi")]);
    const result = await registry.completeSimple(model, { messages: [{ role: "user", content: "x", timestamp: 1 }] });
    expect(result.content).toEqual([{ type: "text", text: "hi" }]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/models.test.ts`
Expected: FAIL，无法解析 `../src/providers/models.js`。

- [ ] **Step 3: 实现**

`src/providers/models.ts`：

```ts
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createProvider,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type MutableModels,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { CustomModelConfig, ModelRef, ProviderConfig } from "../config/schema.js";

export class ModelResolutionError extends Error {}

export type CompleteFn = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => Promise<AssistantMessage>;

export interface ModelRegistry {
  resolve(ref: ModelRef): Model<Api>;
  getApiKey(provider: string): string | undefined;
  streamFn: StreamFn;
  completeSimple: CompleteFn;
}

interface CustomProvider {
  api: NonNullable<ProviderConfig["api"]>;
  baseUrl: string;
  declared: CustomModelConfig[] | undefined;
}

export function createModelRegistry(
  providers: Record<string, ProviderConfig>,
  base: MutableModels = builtinModels(),
): ModelRegistry {
  const custom = new Map<string, CustomProvider>();
  for (const [id, config] of Object.entries(providers)) {
    if (!config.api || !config.baseUrl) continue;
    const entry: CustomProvider = { api: config.api, baseUrl: config.baseUrl, declared: config.models };
    custom.set(id, entry);
    base.setProvider(
      createProvider({
        id,
        name: id,
        baseUrl: config.baseUrl,
        // The key is passed explicitly per request, so the provider itself resolves as keyless.
        auth: { apiKey: { name: `${id} API key`, resolve: async () => ({ auth: {} }) } },
        models: (config.models ?? []).map((m) => customModel(id, entry, m.id)),
        api: config.api === "openai-completions" ? openAICompletionsApi() : anthropicMessagesApi(),
      }),
    );
  }

  return {
    resolve(ref) {
      const entry = custom.get(ref.provider);
      if (entry) {
        if (entry.declared?.length && !entry.declared.some((m) => m.id === ref.id)) {
          throw new ModelResolutionError(
            `提供方 ${ref.provider} 未声明模型 "${ref.id}"。已声明：${entry.declared.map((m) => m.id).join(", ")}`,
          );
        }
        return customModel(ref.provider, entry, ref.id);
      }
      if (!base.getProvider(ref.provider)) {
        const known = base.getProviders().map((p) => p.id);
        throw new ModelResolutionError(
          `未知的模型提供方 "${ref.provider}"。内置提供方：${known.join(", ")}；自定义提供方需在 providers.${ref.provider} 中声明 api 与 baseUrl`,
        );
      }
      const model = base.getModel(ref.provider, ref.id);
      if (!model) {
        const ids = base.getModels(ref.provider).map((m) => m.id);
        throw new ModelResolutionError(`提供方 ${ref.provider} 没有模型 "${ref.id}"。可用：${ids.join(", ")}`);
      }
      return model;
    },
    getApiKey(provider) {
      return providers[provider]?.apiKey || undefined;
    },
    streamFn: (model, context, options) => base.streamSimple(model, context, options),
    completeSimple: (model, context, options) => base.completeSimple(model, context, options),
  };
}

function customModel(provider: string, entry: CustomProvider, id: string): Model<Api> {
  const declared = entry.declared?.find((m) => m.id === id);
  return {
    id,
    name: id,
    api: entry.api,
    provider,
    baseUrl: entry.baseUrl,
    reasoning: declared?.reasoning ?? false,
    input: declared?.input ?? ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: declared?.contextWindow ?? 128_000,
    maxTokens: declared?.maxTokens ?? 8_192,
  };
}
```

- [ ] **Step 4: 运行测试与类型检查**

Run: `npx vitest run tests/models.test.ts && npm run lint`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/providers tests/helpers/faux.ts tests/models.test.ts
git commit -m "feat: model registry over pi-ai with custom providers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 4: 工作区与 system prompt 组装

**Files:**
- Create: `src/workspace/templates.ts`, `src/workspace/workspace.ts`, `src/context/prompt.ts`
- Test: `tests/workspace.test.ts`, `tests/prompt.test.ts`

**Interfaces:**
- Produces:
  - `WORKSPACE_TEMPLATES: Record<string, string>`（键为相对路径：`SOUL.md`、`USER.md`、`MEMORY.md`、`HEARTBEAT.md`）
  - `ensureWorkspace(dir: string): Promise<void>`：创建目录、`memory/`、`skills/`，只在文件缺失时写入模板
  - `readWorkspaceFile(dir: string, name: string): Promise<string>`：文件缺失返回 `""`
  - `interface PromptContext { windowLabel: string; now: Date }`
  - `type PromptSection = (ctx: PromptContext) => Promise<string | undefined> | string | undefined`
  - `class SystemPromptBuilder { constructor(sections: PromptSection[]); build(ctx: PromptContext): Promise<string> }`
  - `baseInstructionsSection(workspace: string): PromptSection`
  - `residentFileSection(opts: { workspace: string; file: string; maxLines: number }): PromptSection`
  - `timeSection(timeZone?: string): PromptSection`
  - `formatNow(now: Date, timeZone: string): string`
  - `describeTimeOfDay(hour: number): string`

后续计划会在 `SystemPromptBuilder` 的分节列表中插入情绪描述（计划 4）和 Skills 清单（计划 5），分节顺序由组装方（`daemon.ts`）决定。

- [ ] **Step 1: 写失败的测试**

`tests/workspace.test.ts`：

```ts
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WORKSPACE_TEMPLATES } from "../src/workspace/templates.js";
import { ensureWorkspace, readWorkspaceFile } from "../src/workspace/workspace.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

let dir: string;
beforeEach(async () => { dir = await makeTmpDir(); });
afterEach(async () => { await removeTmpDir(dir); });

describe("ensureWorkspace", () => {
  it("creates directories and template files", async () => {
    const ws = join(dir, "ws");
    await ensureWorkspace(ws);
    expect((await stat(join(ws, "memory"))).isDirectory()).toBe(true);
    expect((await stat(join(ws, "skills"))).isDirectory()).toBe(true);
    for (const [name, content] of Object.entries(WORKSPACE_TEMPLATES)) {
      expect(await readFile(join(ws, name), "utf8")).toBe(content);
    }
    expect(await readFile(join(ws, "HEARTBEAT.md"), "utf8")).toBe("");
  });

  it("never overwrites existing files", async () => {
    await ensureWorkspace(dir);
    await writeFile(join(dir, "SOUL.md"), "my soul", "utf8");
    await ensureWorkspace(dir);
    expect(await readFile(join(dir, "SOUL.md"), "utf8")).toBe("my soul");
  });
});

describe("readWorkspaceFile", () => {
  it("returns an empty string for a missing file", async () => {
    expect(await readWorkspaceFile(dir, "nope.md")).toBe("");
  });
});
```

`tests/prompt.test.ts`：

```ts
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  baseInstructionsSection,
  describeTimeOfDay,
  formatNow,
  residentFileSection,
  SystemPromptBuilder,
  timeSection,
} from "../src/context/prompt.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

let dir: string;
beforeEach(async () => { dir = await makeTmpDir(); });
afterEach(async () => { await removeTmpDir(dir); });

const ctx = { windowLabel: "微信", now: new Date("2026-10-02T06:03:00Z") };

describe("SystemPromptBuilder", () => {
  it("joins non-empty sections in order", async () => {
    const builder = new SystemPromptBuilder([() => "A", () => undefined, async () => "  ", async () => "B"]);
    expect(await builder.build(ctx)).toBe("A\n\nB");
  });
});

describe("baseInstructionsSection", () => {
  it("names the workspace and the resident files", async () => {
    const text = await baseInstructionsSection("/ws")(ctx);
    expect(text).toContain("/ws");
    for (const name of ["SOUL.md", "USER.md", "MEMORY.md", "memory/YYYY-MM-DD.md"]) expect(text).toContain(name);
  });
});

describe("residentFileSection", () => {
  it("wraps the file under a heading", async () => {
    await writeFile(join(dir, "SOUL.md"), "be kind\n", "utf8");
    const section = residentFileSection({ workspace: dir, file: "SOUL.md", maxLines: 10 });
    expect(await section(ctx)).toBe("## SOUL.md\nbe kind");
  });

  it("is skipped when the file is missing or blank", async () => {
    await writeFile(join(dir, "USER.md"), "  \n", "utf8");
    expect(await residentFileSection({ workspace: dir, file: "USER.md", maxLines: 10 })(ctx)).toBeUndefined();
    expect(await residentFileSection({ workspace: dir, file: "MEMORY.md", maxLines: 10 })(ctx)).toBeUndefined();
  });

  it("truncates beyond the line limit and asks for a cleanup", async () => {
    await writeFile(join(dir, "MEMORY.md"), ["1", "2", "3", "4"].join("\n"), "utf8");
    const text = await residentFileSection({ workspace: dir, file: "MEMORY.md", maxLines: 2 })(ctx);
    expect(text).toBe("## MEMORY.md\n1\n2\n\n（MEMORY.md 共 4 行，超过 2 行上限，以上为截断内容。请精简这个文件。）");
  });
});

describe("time", () => {
  it("formats local time with weekday, offset and part of day", () => {
    expect(formatNow(new Date("2026-10-02T06:03:00Z"), "Asia/Shanghai")).toBe(
      "2026-10-02 14:03 星期五（Asia/Shanghai，UTC+08:00，下午）",
    );
    expect(formatNow(new Date("2026-10-02T16:03:00Z"), "UTC")).toBe("2026-10-02 16:03 星期五（UTC，UTC，下午）");
  });

  it("names parts of the day", () => {
    expect([2, 6, 10, 13, 15, 19, 22].map(describeTimeOfDay)).toEqual([
      "深夜", "早晨", "上午", "中午", "下午", "傍晚", "夜间",
    ]);
  });

  it("renders the time section with the window label", async () => {
    expect(await timeSection("Asia/Shanghai")(ctx)).toBe(
      "## 当前\n时间：2026-10-02 14:03 星期五（Asia/Shanghai，UTC+08:00，下午）\n窗口：微信",
    );
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/workspace.test.ts tests/prompt.test.ts`
Expected: FAIL，无法解析模块。

- [ ] **Step 3: 实现**

`src/workspace/templates.ts`：

```ts
export const WORKSPACE_TEMPLATES: Record<string, string> = {
  "SOUL.md": [
    "# SOUL",
    "",
    "你是主人的私人助手。",
    "",
    "## 语气",
    "- 自然、口语化，像熟悉的朋友",
    "- 回答简洁，先给结论",
    "",
    "## 准则",
    "- 不确定时直说，不编造",
    "- 删除、发送、付款等不可逆操作之前先和主人确认",
    "",
  ].join("\n"),
  "USER.md": ["# USER", "", "（记录你对主人的认识：称呼、身份、偏好、习惯。）", ""].join("\n"),
  "MEMORY.md": ["# MEMORY", "", "（记录提炼后的长期事实与决定，保持在 100 行以内。）", ""].join("\n"),
  "HEARTBEAT.md": "",
};
```

`src/workspace/workspace.ts`：

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WORKSPACE_TEMPLATES } from "./templates.js";

export async function ensureWorkspace(dir: string): Promise<void> {
  await mkdir(join(dir, "memory"), { recursive: true });
  await mkdir(join(dir, "skills"), { recursive: true });
  for (const [name, content] of Object.entries(WORKSPACE_TEMPLATES)) {
    try {
      await writeFile(join(dir, name), content, { encoding: "utf8", flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
}

export async function readWorkspaceFile(dir: string, name: string): Promise<string> {
  try {
    return await readFile(join(dir, name), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}
```

`src/context/prompt.ts`：

```ts
import { readWorkspaceFile } from "../workspace/workspace.js";

export interface PromptContext {
  windowLabel: string;
  now: Date;
}

export type PromptSection = (ctx: PromptContext) => Promise<string | undefined> | string | undefined;

export class SystemPromptBuilder {
  constructor(private readonly sections: PromptSection[]) {}

  async build(ctx: PromptContext): Promise<string> {
    const parts: string[] = [];
    for (const section of this.sections) {
      const text = (await section(ctx))?.trim();
      if (text) parts.push(text);
    }
    return parts.join("\n\n");
  }
}

export function baseInstructionsSection(workspace: string): PromptSection {
  const text = [
    "你是主人的个人助手，运行在主人自己的设备上，只服务主人一个人。主人通过微信或网页与你对话。",
    "",
    "## 工作区",
    `你的工作区是 ${workspace}。文件工具的相对路径基于工作区，bash 的默认工作目录也是工作区。`,
    "工作区中的这些文件构成你的长期状态：",
    "- SOUL.md：你的人设、语气与行为准则",
    "- USER.md：你对主人的认识",
    "- MEMORY.md：提炼后的长期事实与决定，保持在 100 行以内",
    "- memory/YYYY-MM-DD.md：每日笔记",
    "SOUL.md、USER.md、MEMORY.md 的当前内容附在下文。",
    "",
    "## 记忆约定",
    "- 一次性的事实、事件、对话要点：追加到当天的 memory/YYYY-MM-DD.md",
    "- 关于主人的稳定认知：更新 USER.md",
    "- 长期有效的事实与决定：更新 MEMORY.md",
    "- 主人要求改变你的人设或行为准则：更新 SOUL.md",
    "",
    "## 工具与审批",
    "在工作区内读写文件无需批准；写工作区以外的文件和执行 bash 命令需要主人批准。被拒绝时接受结果，换一种方式继续或向主人说明。",
  ].join("\n");
  return () => text;
}

export function residentFileSection(opts: { workspace: string; file: string; maxLines: number }): PromptSection {
  return async () => {
    const content = (await readWorkspaceFile(opts.workspace, opts.file)).trim();
    if (!content) return undefined;
    const lines = content.split("\n");
    if (lines.length <= opts.maxLines) return `## ${opts.file}\n${content}`;
    return [
      `## ${opts.file}`,
      lines.slice(0, opts.maxLines).join("\n"),
      "",
      `（${opts.file} 共 ${lines.length} 行，超过 ${opts.maxLines} 行上限，以上为截断内容。请精简这个文件。）`,
    ].join("\n");
  };
}

export function timeSection(timeZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone): PromptSection {
  return ({ now, windowLabel }) => `## 当前\n时间：${formatNow(now, timeZone)}\n窗口：${windowLabel}`;
}

export function formatNow(now: Date, timeZone: string): string {
  const parts: Record<string, string> = {};
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "long",
    timeZoneName: "longOffset",
  });
  for (const part of formatter.formatToParts(now)) parts[part.type] = part.value;
  const offset = (parts.timeZoneName ?? "GMT").replace("GMT", "UTC");
  const hour = Number(parts.hour);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${parts.weekday}（${timeZone}，${offset}，${describeTimeOfDay(hour)}）`;
}

export function describeTimeOfDay(hour: number): string {
  if (hour < 5) return "深夜";
  if (hour < 9) return "早晨";
  if (hour < 12) return "上午";
  if (hour < 14) return "中午";
  if (hour < 18) return "下午";
  if (hour < 21) return "傍晚";
  return "夜间";
}
```

- [ ] **Step 4: 运行测试与类型检查**

Run: `npx vitest run tests/workspace.test.ts tests/prompt.test.ts && npm run lint`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/workspace src/context tests/workspace.test.ts tests/prompt.test.ts
git commit -m "feat: workspace templates and system prompt assembly

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 文件工具 read / write / edit

**Files:**
- Create: `src/tools/paths.ts`, `src/tools/fs.ts`
- Test: `tests/tools-fs.test.ts`

**Interfaces:**
- Consumes: `expandHome`（Task 1）
- Produces:
  - `resolveToolPath(workspace: string, p: string): string`：相对路径基于工作区，支持 `~`
  - `isInside(root: string, target: string): boolean`
  - `displayPath(workspace: string, abs: string): string`：工作区内返回相对路径，否则返回绝对路径
  - `createReadTool(workspace: string)`、`createWriteTool(workspace: string)`、`createEditTool(workspace: string)`，均返回 pi `AgentTool`，工具名分别为 `read`、`write`、`edit`

工具按 pi 约定在失败时抛出异常，pi 会把异常信息作为错误工具结果返回给模型。

- [ ] **Step 1: 写失败的测试**

`tests/tools-fs.test.ts`：

```ts
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEditTool, createReadTool, createWriteTool } from "../src/tools/fs.js";
import { displayPath, isInside, resolveToolPath } from "../src/tools/paths.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

let ws: string;
beforeEach(async () => { ws = await makeTmpDir(); });
afterEach(async () => { await removeTmpDir(ws); });

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((c) => c.text ?? "").join("");
}

describe("tool paths", () => {
  it("resolves relative paths against the workspace", () => {
    expect(resolveToolPath("/ws", "notes/a.md")).toBe("/ws/notes/a.md");
    expect(resolveToolPath("/ws", "/etc/hosts")).toBe("/etc/hosts");
    expect(resolveToolPath("/ws", "~/x")).toBe(join(homedir(), "x"));
  });

  it("detects containment without being fooled by look-alike names", () => {
    expect(isInside("/ws", "/ws")).toBe(true);
    expect(isInside("/ws", "/ws/a/b")).toBe(true);
    expect(isInside("/ws", "/ws/../etc")).toBe(false);
    expect(isInside("/ws", "/ws2/a")).toBe(false);
    expect(isInside("/ws", "/ws/..hidden")).toBe(true);
  });

  it("shows workspace paths relatively", () => {
    expect(displayPath("/ws", "/ws/a/b.md")).toBe("a/b.md");
    expect(displayPath("/ws", "/etc/hosts")).toBe("/etc/hosts");
  });
});

describe("read", () => {
  it("returns numbered lines", async () => {
    await writeFile(join(ws, "a.txt"), "one\ntwo\nthree", "utf8");
    const result = await createReadTool(ws).execute("1", { path: "a.txt" });
    expect(textOf(result)).toBe("1\tone\n2\ttwo\n3\tthree");
  });

  it("supports offset and limit and says how to continue", async () => {
    await writeFile(join(ws, "a.txt"), "1\n2\n3\n4\n5", "utf8");
    const result = await createReadTool(ws).execute("1", { path: "a.txt", offset: 2, limit: 2 });
    expect(textOf(result)).toBe("2\t2\n3\t3\n…（共 5 行，用 offset 继续读取）");
  });

  it("throws for a missing file", async () => {
    await expect(createReadTool(ws).execute("1", { path: "nope.txt" })).rejects.toThrow();
  });
});

describe("write", () => {
  it("creates parent directories", async () => {
    const result = await createWriteTool(ws).execute("1", { path: "memory/2026-10-02.md", content: "note" });
    expect(await readFile(join(ws, "memory/2026-10-02.md"), "utf8")).toBe("note");
    expect(textOf(result)).toBe("已写入 memory/2026-10-02.md（4 字节）");
  });
});

describe("edit", () => {
  beforeEach(async () => { await writeFile(join(ws, "f.md"), "a b a $1", "utf8"); });

  it("replaces a unique occurrence literally", async () => {
    const result = await createEditTool(ws).execute("1", { path: "f.md", oldText: "b", newText: "$&c" });
    expect(await readFile(join(ws, "f.md"), "utf8")).toBe("a $&c a $1");
    expect(textOf(result)).toBe("已修改 f.md（替换 1 处）");
  });

  it("refuses an ambiguous match unless replaceAll is set", async () => {
    await expect(createEditTool(ws).execute("1", { path: "f.md", oldText: "a", newText: "x" })).rejects.toThrow(/出现了 2 次/);
    await createEditTool(ws).execute("1", { path: "f.md", oldText: "a", newText: "x", replaceAll: true });
    expect(await readFile(join(ws, "f.md"), "utf8")).toBe("x b x $1");
  });

  it("fails when the text is absent or empty", async () => {
    await expect(createEditTool(ws).execute("1", { path: "f.md", oldText: "zzz", newText: "x" })).rejects.toThrow(/没有找到/);
    await expect(createEditTool(ws).execute("1", { path: "f.md", oldText: "", newText: "x" })).rejects.toThrow(/不能为空/);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/tools-fs.test.ts`
Expected: FAIL，无法解析模块。

- [ ] **Step 3: 实现**

`src/tools/paths.ts`：

```ts
import { isAbsolute, relative, resolve, sep } from "node:path";
import { expandHome } from "../paths.js";

export function resolveToolPath(workspace: string, p: string): string {
  return resolve(workspace, expandHome(p));
}

export function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function displayPath(workspace: string, abs: string): string {
  return isInside(workspace, abs) ? relative(workspace, abs) || "." : abs;
}
```

`src/tools/fs.ts`：

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { displayPath, resolveToolPath } from "./paths.js";

const ReadParams = Type.Object({
  path: Type.String({ description: "文件路径，相对路径基于工作区" }),
  offset: Type.Optional(Type.Integer({ minimum: 1, description: "起始行号（从 1 开始）" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, description: "最多读取的行数，默认 2000" })),
});

export function createReadTool(workspace: string): AgentTool<typeof ReadParams> {
  return {
    name: "read",
    label: "读取文件",
    description: "读取文本文件，每行前带行号。",
    parameters: ReadParams,
    async execute(_id, { path, offset = 1, limit = 2000 }) {
      const abs = resolveToolPath(workspace, path);
      const lines = (await readFile(abs, "utf8")).split("\n");
      const start = offset - 1;
      const body = lines
        .slice(start, start + limit)
        .map((line, i) => `${offset + i}\t${line}`)
        .join("\n");
      const more = start + limit < lines.length ? `\n…（共 ${lines.length} 行，用 offset 继续读取）` : "";
      return { content: [{ type: "text", text: body + more }], details: { path: abs } };
    },
  };
}

const WriteParams = Type.Object({
  path: Type.String({ description: "文件路径，相对路径基于工作区" }),
  content: Type.String({ description: "完整文件内容" }),
});

export function createWriteTool(workspace: string): AgentTool<typeof WriteParams> {
  return {
    name: "write",
    label: "写入文件",
    description: "写入完整文件内容，文件存在时覆盖，父目录不存在时自动创建。",
    parameters: WriteParams,
    async execute(_id, { path, content }) {
      const abs = resolveToolPath(workspace, path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf8");
      const bytes = Buffer.byteLength(content, "utf8");
      return {
        content: [{ type: "text", text: `已写入 ${displayPath(workspace, abs)}（${bytes} 字节）` }],
        details: { path: abs },
      };
    },
  };
}

const EditParams = Type.Object({
  path: Type.String({ description: "文件路径，相对路径基于工作区" }),
  oldText: Type.String({ description: "要替换的原文，必须与文件内容完全一致" }),
  newText: Type.String({ description: "替换后的文本" }),
  replaceAll: Type.Optional(Type.Boolean({ description: "替换所有出现，默认只允许唯一匹配" })),
});

export function createEditTool(workspace: string): AgentTool<typeof EditParams> {
  return {
    name: "edit",
    label: "编辑文件",
    description: "把文件中的 oldText 精确替换为 newText。oldText 必须唯一出现，除非设置 replaceAll。",
    parameters: EditParams,
    async execute(_id, { path, oldText, newText, replaceAll = false }) {
      if (oldText === "") throw new Error("oldText 不能为空");
      const abs = resolveToolPath(workspace, path);
      const original = await readFile(abs, "utf8");
      const count = original.split(oldText).length - 1;
      if (count === 0) throw new Error(`在 ${displayPath(workspace, abs)} 中没有找到 oldText`);
      if (count > 1 && !replaceAll) {
        throw new Error(`oldText 出现了 ${count} 次，请提供更多上下文使其唯一，或设置 replaceAll`);
      }
      const updated = replaceAll ? original.split(oldText).join(newText) : original.replace(oldText, () => newText);
      await writeFile(abs, updated, "utf8");
      return {
        content: [{ type: "text", text: `已修改 ${displayPath(workspace, abs)}（替换 ${replaceAll ? count : 1} 处）` }],
        details: { path: abs },
      };
    },
  };
}
```

- [ ] **Step 4: 运行测试与类型检查**

Run: `npx vitest run tests/tools-fs.test.ts && npm run lint`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/tools tests/tools-fs.test.ts
git commit -m "feat: read, write and edit tools

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: bash 工具

**Files:**
- Create: `src/tools/bash.ts`
- Test: `tests/tools-bash.test.ts`

**Interfaces:**
- Produces:
  - `buildChildEnv(passthrough: string[], source?: NodeJS.ProcessEnv): NodeJS.ProcessEnv`
  - `truncateMiddle(text: string, max: number): string`
  - `createBashTool(opts: { workspace: string; envPassthrough: string[] })`：工具名 `bash`，参数 `{ command: string; timeout?: number }`（秒，默认 120，最长 600）

行为：工作目录为工作区；子进程只继承环境变量白名单（含 `LC_*`）与 `envPassthrough`；标准输出与标准错误合并，结果超过 30000 字符时保留首尾各一半；非零退出码、超时、中断都抛出异常；超时与中断会杀掉整个进程组。

- [ ] **Step 1: 写失败的测试**

`tests/tools-bash.test.ts`：

```ts
import { realpath } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildChildEnv, createBashTool, truncateMiddle } from "../src/tools/bash.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

let ws: string;
beforeEach(async () => { ws = await realpath(await makeTmpDir()); });
afterEach(async () => { await removeTmpDir(ws); });

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((c) => c.text ?? "").join("");
}

describe("buildChildEnv", () => {
  it("keeps only allowlisted, locale and passthrough variables", () => {
    const env = buildChildEnv(["GITHUB_TOKEN"], {
      PATH: "/bin",
      HOME: "/h",
      LC_ALL: "zh_CN.UTF-8",
      DEEPSEEK_API_KEY: "secret",
      GITHUB_TOKEN: "gh",
    });
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", LC_ALL: "zh_CN.UTF-8", GITHUB_TOKEN: "gh" });
  });
});

describe("truncateMiddle", () => {
  it("keeps short text and elides the middle of long text", () => {
    expect(truncateMiddle("abc", 10)).toBe("abc");
    expect(truncateMiddle("aaaaXXXXbbbb", 8)).toBe("aaaa\n…（省略 4 个字符）…\nbbbb");
  });
});

describe("bash tool", () => {
  it("runs in the workspace and merges stderr", async () => {
    const tool = createBashTool({ workspace: ws, envPassthrough: [] });
    const result = await tool.execute("1", { command: "pwd; echo oops >&2" });
    expect(textOf(result)).toBe(`${ws}\noops\n`);
  });

  it("reports an empty output explicitly", async () => {
    const tool = createBashTool({ workspace: ws, envPassthrough: [] });
    expect(textOf(await tool.execute("1", { command: "true" }))).toBe("(无输出)");
  });

  it("does not leak secrets from the parent environment", async () => {
    process.env.VEX_TEST_SECRET = "leak";
    try {
      const tool = createBashTool({ workspace: ws, envPassthrough: [] });
      expect(textOf(await tool.execute("1", { command: 'echo "[$VEX_TEST_SECRET]"' }))).toBe("[]\n");
      const allowed = createBashTool({ workspace: ws, envPassthrough: ["VEX_TEST_SECRET"] });
      expect(textOf(await allowed.execute("1", { command: 'echo "[$VEX_TEST_SECRET]"' }))).toBe("[leak]\n");
    } finally {
      delete process.env.VEX_TEST_SECRET;
    }
  });

  it("throws with output and exit code on failure", async () => {
    const tool = createBashTool({ workspace: ws, envPassthrough: [] });
    await expect(tool.execute("1", { command: "echo bad; exit 3" })).rejects.toThrow("bad\n\n[退出码 3]");
  });

  it("kills the command on timeout", async () => {
    const tool = createBashTool({ workspace: ws, envPassthrough: [] });
    const started = Date.now();
    await expect(tool.execute("1", { command: "echo start; sleep 30", timeout: 1 })).rejects.toThrow(/超时（1 秒）/);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("kills the command when aborted", async () => {
    const tool = createBashTool({ workspace: ws, envPassthrough: [] });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    await expect(tool.execute("1", { command: "sleep 30" }, controller.signal)).rejects.toThrow("命令已中断");
  });

  it("truncates huge output in the middle", async () => {
    const tool = createBashTool({ workspace: ws, envPassthrough: [] });
    const text = textOf(await tool.execute("1", { command: "head -c 100000 /dev/zero | tr '\\0' a; echo; echo END" }));
    expect(text.length).toBeLessThan(31_000);
    expect(text).toContain("…（省略");
    expect(text.endsWith("END\n")).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/tools-bash.test.ts`
Expected: FAIL，无法解析模块。

- [ ] **Step 3: 实现**

`src/tools/bash.ts`：

```ts
import { spawn } from "node:child_process";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

const BASE_ENV_ALLOWLIST = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TERM", "TMPDIR", "TZ",
  "http_proxy", "https_proxy", "ftp_proxy", "all_proxy", "no_proxy",
  "HTTP_PROXY", "HTTPS_PROXY", "FTP_PROXY", "ALL_PROXY", "NO_PROXY",
];

const MAX_RESULT_CHARS = 30_000;
const HALF = MAX_RESULT_CHARS / 2;

export function buildChildEnv(passthrough: string[], source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allow = new Set([...BASE_ENV_ALLOWLIST, ...passthrough]);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && (allow.has(key) || key.startsWith("LC_"))) env[key] = value;
  }
  return env;
}

export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n…（省略 ${text.length - half * 2} 个字符）…\n${text.slice(text.length - half)}`;
}

const BashParams = Type.Object({
  command: Type.String({ description: "要执行的 shell 命令" }),
  timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: 600, description: "超时秒数，默认 120，最长 600" })),
});

interface BashOptions {
  workspace: string;
  envPassthrough: string[];
}

export function createBashTool(opts: BashOptions): AgentTool<typeof BashParams> {
  return {
    name: "bash",
    label: "执行命令",
    description: "在 bash 中执行命令，返回合并后的标准输出与标准错误。默认工作目录是工作区。",
    parameters: BashParams,
    execute: (_id, { command, timeout = 120 }, signal) => runCommand(command, opts, timeout, signal),
  };
}

function runCommand(
  command: string,
  opts: BashOptions,
  timeoutSec: number,
  signal: AbortSignal | undefined,
): Promise<AgentToolResult<{ exitCode: number }>> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("命令已中断"));
      return;
    }
    const child = spawn("bash", ["-c", command], {
      cwd: opts.workspace,
      env: buildChildEnv(opts.envPassthrough),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Keep only the head and a rolling tail so huge outputs never sit in memory.
    let head = "";
    let tail = "";
    let total = 0;
    const collect = (chunk: string) => {
      total += chunk.length;
      let rest = chunk;
      if (head.length < HALF) {
        const take = rest.slice(0, HALF - head.length);
        head += take;
        rest = rest.slice(take.length);
      }
      if (rest) tail = (tail + rest).slice(-HALF);
    };
    child.stdout.setEncoding("utf8").on("data", collect);
    child.stderr.setEncoding("utf8").on("data", collect);
    const output = () =>
      total <= MAX_RESULT_CHARS ? head + tail : `${head}\n…（省略 ${total - head.length - tail.length} 个字符）…\n${tail}`;

    let stopReason: "timeout" | "aborted" | undefined;
    const killGroup = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The group already exited.
      }
    };
    const timer = setTimeout(() => {
      stopReason = "timeout";
      killGroup();
    }, timeoutSec * 1000);
    const onAbort = () => {
      stopReason = "aborted";
      killGroup();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    child.on("error", (err) => {
      cleanup();
      reject(err);
    });
    child.on("close", (code) => {
      cleanup();
      const text = output();
      if (stopReason === "timeout") {
        reject(new Error(`命令超时（${timeoutSec} 秒）已终止\n${text}`));
      } else if (stopReason === "aborted") {
        reject(new Error("命令已中断"));
      } else if (code !== 0) {
        reject(new Error(`${text}\n[退出码 ${code ?? "未知"}]`));
      } else {
        resolve({ content: [{ type: "text", text: text || "(无输出)" }], details: { exitCode: 0 } });
      }
    });
  });
}
```

- [ ] **Step 4: 运行测试与类型检查**

Run: `npx vitest run tests/tools-bash.test.ts && npm run lint`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/tools/bash.ts tests/tools-bash.test.ts
git commit -m "feat: bash tool with env allowlist, timeout and abort

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: 搜索工具 grep / find 与核心工具集合

**Files:**
- Create: `src/tools/search.ts`, `src/tools/registry.ts`
- Test: `tests/tools-search.test.ts`

**Interfaces:**
- Consumes: `resolveToolPath`、`displayPath`（Task 5）、`createReadTool`/`createWriteTool`/`createEditTool`（Task 5）、`createBashTool`（Task 6）
- Produces:
  - `createGrepTool(workspace: string)`：工具名 `grep`，参数 `{ pattern: string; path?: string; glob?: string; ignoreCase?: boolean }`
  - `createFindTool(workspace: string)`：工具名 `find`，参数 `{ pattern: string; path?: string }`
  - `interface CoreToolOptions { workspace: string; bashEnvPassthrough: string[] }`
  - `createCoreTools(opts: CoreToolOptions): AgentTool<any>[]`，顺序为 `read, write, edit, bash, grep, find`

规则：遍历跳过 `.git`、`node_modules`；grep 跳过大于 1 MB 或前 8 KB 含 `\0` 的文件，每行输出 `路径:行号:内容`（内容截断到 300 字符），最多 200 条；find 用 `path.matchesGlob` 匹配相对搜索目录的路径，最多 500 条，按字典序排序。

- [ ] **Step 1: 写失败的测试**

`tests/tools-search.test.ts`：

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCoreTools } from "../src/tools/registry.js";
import { createFindTool, createGrepTool } from "../src/tools/search.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

let ws: string;
beforeEach(async () => {
  ws = await makeTmpDir();
  await mkdir(join(ws, "memory"), { recursive: true });
  await mkdir(join(ws, "node_modules", "x"), { recursive: true });
  await writeFile(join(ws, "MEMORY.md"), "主人喜欢咖啡\n不喝茶\n", "utf8");
  await writeFile(join(ws, "memory", "2026-10-01.md"), "今天喝了 Coffee\n", "utf8");
  await writeFile(join(ws, "memory", "notes.txt"), "coffee beans\n", "utf8");
  await writeFile(join(ws, "node_modules", "x", "a.md"), "coffee\n", "utf8");
  await writeFile(join(ws, "bin.dat"), Buffer.from([0x63, 0x00, 0x6f]));
});
afterEach(async () => { await removeTmpDir(ws); });

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((c) => c.text ?? "").join("");
}

describe("grep", () => {
  it("finds matches with path and line number, skipping vendored and binary files", async () => {
    const out = textOf(await createGrepTool(ws).execute("1", { pattern: "coffee", ignoreCase: true }));
    expect(out.split("\n").sort()).toEqual(["memory/2026-10-01.md:1:今天喝了 Coffee", "memory/notes.txt:1:coffee beans"]);
  });

  it("filters by glob and handles CJK patterns", async () => {
    expect(textOf(await createGrepTool(ws).execute("1", { pattern: "coffee", ignoreCase: true, glob: "**/*.md" }))).toBe(
      "memory/2026-10-01.md:1:今天喝了 Coffee",
    );
    expect(textOf(await createGrepTool(ws).execute("1", { pattern: "咖啡" }))).toBe("MEMORY.md:1:主人喜欢咖啡");
  });

  it("searches a single file", async () => {
    expect(textOf(await createGrepTool(ws).execute("1", { pattern: "茶", path: "MEMORY.md" }))).toBe("MEMORY.md:2:不喝茶");
  });

  it("says so when nothing matches and rejects bad regexes", async () => {
    expect(textOf(await createGrepTool(ws).execute("1", { pattern: "zzz" }))).toBe("没有匹配");
    await expect(createGrepTool(ws).execute("1", { pattern: "(" })).rejects.toThrow();
  });

  it("caps the number of matches", async () => {
    await writeFile(join(ws, "many.txt"), "hit\n".repeat(300), "utf8");
    const out = textOf(await createGrepTool(ws).execute("1", { pattern: "hit", path: "many.txt" }));
    expect(out.split("\n")).toHaveLength(201);
    expect(out.endsWith("…（结果超过 200 条，已截断）")).toBe(true);
  });
});

describe("find", () => {
  it("lists matching files relative to the search directory", async () => {
    expect(textOf(await createFindTool(ws).execute("1", { pattern: "**/*.md" }))).toBe("MEMORY.md\nmemory/2026-10-01.md");
    expect(textOf(await createFindTool(ws).execute("1", { pattern: "*.txt", path: "memory" }))).toBe("notes.txt");
    expect(textOf(await createFindTool(ws).execute("1", { pattern: "*.zip" }))).toBe("没有找到匹配的文件");
  });
});

describe("createCoreTools", () => {
  it("returns the core tools in a stable order", () => {
    expect(createCoreTools({ workspace: ws, bashEnvPassthrough: [] }).map((t) => t.name)).toEqual([
      "read", "write", "edit", "bash", "grep", "find",
    ]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/tools-search.test.ts`
Expected: FAIL，无法解析模块。

- [ ] **Step 3: 实现**

`src/tools/search.ts`：

```ts
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, matchesGlob, relative } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { displayPath, resolveToolPath } from "./paths.js";

const SKIP_DIRS = new Set([".git", "node_modules"]);
const MAX_FILE_BYTES = 1_000_000;
const MAX_GREP_MATCHES = 200;
const MAX_FIND_RESULTS = 500;

async function* walkFiles(root: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walkFiles(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

async function* single(file: string): AsyncGenerator<string> {
  yield file;
}

const GrepParams = Type.Object({
  pattern: Type.String({ description: "JavaScript 正则表达式" }),
  path: Type.Optional(Type.String({ description: "要搜索的文件或目录，默认工作区" })),
  glob: Type.Optional(Type.String({ description: "只搜索匹配该 glob 的文件（相对搜索目录），例如 **/*.md" })),
  ignoreCase: Type.Optional(Type.Boolean({ description: "忽略大小写" })),
});

export function createGrepTool(workspace: string): AgentTool<typeof GrepParams> {
  return {
    name: "grep",
    label: "搜索内容",
    description: "按正则表达式搜索文件内容，输出“路径:行号:内容”。",
    parameters: GrepParams,
    async execute(_id, { pattern, path, glob, ignoreCase = false }) {
      const regex = new RegExp(pattern, ignoreCase ? "i" : "");
      const base = resolveToolPath(workspace, path ?? ".");
      const isFile = (await stat(base)).isFile();
      const root = isFile ? dirname(base) : base;
      const matches: string[] = [];
      let truncated = false;
      outer: for await (const file of isFile ? single(base) : walkFiles(base)) {
        if (glob && !matchesGlob(relative(root, file), glob)) continue;
        const buf = await readFile(file);
        if (buf.length > MAX_FILE_BYTES || buf.subarray(0, 8000).includes(0)) continue;
        const lines = buf.toString("utf8").split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] ?? "";
          if (!regex.test(line)) continue;
          if (matches.length >= MAX_GREP_MATCHES) {
            truncated = true;
            break outer;
          }
          matches.push(`${displayPath(workspace, file)}:${i + 1}:${line.slice(0, 300)}`);
        }
      }
      const text =
        matches.length === 0
          ? "没有匹配"
          : matches.join("\n") + (truncated ? `\n…（结果超过 ${MAX_GREP_MATCHES} 条，已截断）` : "");
      return { content: [{ type: "text", text }], details: { count: matches.length } };
    },
  };
}

const FindParams = Type.Object({
  pattern: Type.String({ description: "glob 模式（相对搜索目录），例如 **/*.md" }),
  path: Type.Optional(Type.String({ description: "搜索目录，默认工作区" })),
});

export function createFindTool(workspace: string): AgentTool<typeof FindParams> {
  return {
    name: "find",
    label: "查找文件",
    description: "按 glob 模式查找文件，输出相对搜索目录的路径。",
    parameters: FindParams,
    async execute(_id, { pattern, path }) {
      const base = resolveToolPath(workspace, path ?? ".");
      const found: string[] = [];
      for await (const file of walkFiles(base)) {
        const rel = relative(base, file);
        if (matchesGlob(rel, pattern)) found.push(rel);
      }
      found.sort();
      const shown = found.slice(0, MAX_FIND_RESULTS);
      const text =
        shown.length === 0
          ? "没有找到匹配的文件"
          : shown.join("\n") + (found.length > shown.length ? `\n…（共 ${found.length} 个，只列出前 ${MAX_FIND_RESULTS} 个）` : "");
      return { content: [{ type: "text", text }], details: { count: found.length } };
    },
  };
}
```

`src/tools/registry.ts`：

```ts
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createBashTool } from "./bash.js";
import { createEditTool, createReadTool, createWriteTool } from "./fs.js";
import { createFindTool, createGrepTool } from "./search.js";

export interface CoreToolOptions {
  workspace: string;
  bashEnvPassthrough: string[];
}

export function createCoreTools(opts: CoreToolOptions): AgentTool<any>[] {
  return [
    createReadTool(opts.workspace),
    createWriteTool(opts.workspace),
    createEditTool(opts.workspace),
    createBashTool({ workspace: opts.workspace, envPassthrough: opts.bashEnvPassthrough }),
    createGrepTool(opts.workspace),
    createFindTool(opts.workspace),
  ];
}
```

- [ ] **Step 4: 运行测试与类型检查**

Run: `npx vitest run tests/tools-search.test.ts && npm run lint`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/tools tests/tools-search.test.ts
git commit -m "feat: grep and find tools, core tool set

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 8: 工具审批策略与参数摘要

**Files:**
- Create: `src/tools/summary.ts`, `src/policy/policy.ts`
- Test: `tests/policy.test.ts`

**Interfaces:**
- Consumes: `Decision`（Task 2）、`isInside`、`resolveToolPath`（Task 5）
- Produces:
  - `summarizeArgs(toolName: string, args: unknown): string`：bash 取 `command`，其他工具依次取 `path`、`pattern`，都没有时为 JSON；超过 300 字符截断加 `…`
  - `DEFAULT_DECISIONS: Record<string, Decision>`（`read`/`grep`/`find` 为 `allow`，`bash` 为 `ask`）
  - `class ToolPolicy { constructor(opts: { workspace: string; overrides: Record<string, Decision> }); decide(toolName: string, args: unknown): Decision; filter<T extends { name: string }>(tools: T[]): T[] }`

规则（spec §7.3）：配置覆盖优先；`write`/`edit` 目标在工作区内为 `allow`、否则 `ask`；未登记的工具默认 `ask`；`filter` 去掉被配置为 `deny` 的工具。后续计划在 `DEFAULT_DECISIONS` 中登记新工具的默认策略。

- [ ] **Step 1: 写失败的测试**

`tests/policy.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { ToolPolicy } from "../src/policy/policy.js";
import { summarizeArgs } from "../src/tools/summary.js";

describe("summarizeArgs", () => {
  it("picks the most telling argument", () => {
    expect(summarizeArgs("bash", { command: "ls -la", timeout: 5 })).toBe("ls -la");
    expect(summarizeArgs("write", { path: "a.md", content: "x" })).toBe("a.md");
    expect(summarizeArgs("grep", { pattern: "咖啡" })).toBe("咖啡");
    expect(summarizeArgs("other", { a: 1 })).toBe('{"a":1}');
  });

  it("truncates long summaries", () => {
    const summary = summarizeArgs("bash", { command: "x".repeat(400) });
    expect(summary).toBe(`${"x".repeat(300)}…`);
  });
});

describe("ToolPolicy", () => {
  const policy = new ToolPolicy({ workspace: "/ws", overrides: {} });

  it("applies the default decisions", () => {
    expect(policy.decide("read", { path: "/etc/passwd" })).toBe("allow");
    expect(policy.decide("grep", {})).toBe("allow");
    expect(policy.decide("find", {})).toBe("allow");
    expect(policy.decide("bash", { command: "ls" })).toBe("ask");
    expect(policy.decide("mystery", {})).toBe("ask");
  });

  it("allows writes inside the workspace only", () => {
    expect(policy.decide("write", { path: "memory/a.md" })).toBe("allow");
    expect(policy.decide("edit", { path: "/ws/SOUL.md" })).toBe("allow");
    expect(policy.decide("write", { path: "/etc/hosts" })).toBe("ask");
    expect(policy.decide("edit", { path: "../outside.md" })).toBe("ask");
    expect(policy.decide("write", {})).toBe("ask");
  });

  it("lets configuration override everything", () => {
    const custom = new ToolPolicy({ workspace: "/ws", overrides: { bash: "allow", write: "ask", grep: "deny" } });
    expect(custom.decide("bash", { command: "rm -rf /" })).toBe("allow");
    expect(custom.decide("write", { path: "a.md" })).toBe("ask");
    expect(custom.decide("grep", {})).toBe("deny");
  });

  it("filters out denied tools", () => {
    const custom = new ToolPolicy({ workspace: "/ws", overrides: { bash: "deny" } });
    expect(custom.filter([{ name: "read" }, { name: "bash" }]).map((t) => t.name)).toEqual(["read"]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/policy.test.ts`
Expected: FAIL，无法解析模块。

- [ ] **Step 3: 实现**

`src/tools/summary.ts`：

```ts
const MAX_SUMMARY = 300;

export function summarizeArgs(toolName: string, args: unknown): string {
  const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const pick = (key: string): string | undefined => {
    const value = record[key];
    return typeof value === "string" ? value : undefined;
  };
  const text = (toolName === "bash" ? pick("command") : undefined) ?? pick("path") ?? pick("pattern") ?? JSON.stringify(args ?? {});
  return text.length > MAX_SUMMARY ? `${text.slice(0, MAX_SUMMARY)}…` : text;
}
```

`src/policy/policy.ts`：

```ts
import type { Decision } from "../config/schema.js";
import { isInside, resolveToolPath } from "../tools/paths.js";

export const DEFAULT_DECISIONS: Record<string, Decision> = {
  read: "allow",
  grep: "allow",
  find: "allow",
  bash: "ask",
};

const PATH_SCOPED_TOOLS = new Set(["write", "edit"]);

export class ToolPolicy {
  private readonly workspace: string;
  private readonly overrides: Record<string, Decision>;

  constructor(opts: { workspace: string; overrides: Record<string, Decision> }) {
    this.workspace = opts.workspace;
    this.overrides = opts.overrides;
  }

  decide(toolName: string, args: unknown): Decision {
    const override = this.overrides[toolName];
    if (override) return override;
    if (PATH_SCOPED_TOOLS.has(toolName)) return this.decideByPath(args);
    return DEFAULT_DECISIONS[toolName] ?? "ask";
  }

  filter<T extends { name: string }>(tools: T[]): T[] {
    return tools.filter((tool) => this.overrides[tool.name] !== "deny");
  }

  private decideByPath(args: unknown): Decision {
    const path = args && typeof args === "object" ? (args as Record<string, unknown>).path : undefined;
    if (typeof path !== "string") return "ask";
    return isInside(this.workspace, resolveToolPath(this.workspace, path)) ? "allow" : "ask";
  }
}
```

- [ ] **Step 4: 运行测试与类型检查**

Run: `npx vitest run tests/policy.test.ts && npm run lint`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/tools/summary.ts src/policy/policy.ts tests/policy.test.ts
git commit -m "feat: tool approval policy

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: 事件总线、挂起审批与工具把关

**Files:**
- Create: `src/core/events.ts`, `src/policy/approvals.ts`, `src/policy/gate.ts`
- Test: `tests/events.test.ts`, `tests/approvals.test.ts`

**Interfaces:**
- Consumes: `summarizeArgs`、`ToolPolicy`（Task 8）
- Produces（`src/core/events.ts`）：

```ts
export type SessionEvent =
  | { kind: "user_message"; text: string; timestamp: number }
  | { kind: "text_delta"; delta: string }
  | { kind: "assistant_message"; text: string; stopReason: string; timestamp: number }
  | { kind: "tool_start"; toolCallId: string; toolName: string; summary: string }
  | { kind: "tool_end"; toolCallId: string; toolName: string; isError: boolean }
  | { kind: "busy"; busy: boolean }
  | { kind: "error"; message: string };

export type HistoryItem =
  | { kind: "user"; text: string; timestamp: number }
  | { kind: "assistant"; text: string; stopReason: string; timestamp: number }
  | { kind: "tool"; toolCallId: string; toolName: string; summary: string; isError?: boolean };

export type VexEvent =
  | { type: "session"; sessionKey: string; event: SessionEvent }
  | { type: "sessions_changed" }
  | { type: "approvals_changed" };

export class EventBus {
  constructor(onListenerError?: (err: unknown) => void);
  on(listener: (event: VexEvent) => void): () => void;
  emit(event: VexEvent): void;
}
```

- Produces（`src/policy/approvals.ts`）：
  - `type ApprovalAnswer = "allow" | "allow_session" | "deny"`
  - `interface ApprovalRequest { id: string; sessionKey: string; windowLabel: string; toolName: string; summary: string; createdAt: number; expiresAt: number }`
  - `interface ApprovalOutcome { allowed: boolean; reason?: string }`
  - `class ApprovalManager { constructor(opts?: { timeoutMs?: number; now?: () => number; onChange?: () => void }); request(input: { sessionKey: string; windowLabel: string; toolName: string; args: unknown; signal?: AbortSignal }): Promise<ApprovalOutcome>; answer(id: string, answer: ApprovalAnswer): boolean; pending(): ApprovalRequest[]; isSessionAllowed(sessionKey: string, toolName: string): boolean; dispose(): void }`
- Produces（`src/policy/gate.ts`）：
  - `createToolGate(deps: { policy: ToolPolicy; approvals: ApprovalManager; sessionKey: string; windowLabel: () => string }): (ctx: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>`

审批规则（spec §7.3）：任一窗口首先给出的答复生效，之后的答复返回 `false`；默认 10 分钟超时视为拒绝；本轮被中断时视为拒绝；`allow_session` 记住“本会话总是允许该工具”；`dispose` 拒绝所有挂起请求。每次挂起列表变化都调用 `onChange`。

- [ ] **Step 1: 写失败的测试**

`tests/events.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest";
import { EventBus, type VexEvent } from "../src/core/events.js";

describe("EventBus", () => {
  it("delivers events to subscribers until they unsubscribe", () => {
    const bus = new EventBus();
    const seen: VexEvent[] = [];
    const off = bus.on((e) => seen.push(e));
    bus.emit({ type: "sessions_changed" });
    off();
    bus.emit({ type: "approvals_changed" });
    expect(seen).toEqual([{ type: "sessions_changed" }]);
  });

  it("isolates a throwing listener", () => {
    const onError = vi.fn();
    const bus = new EventBus(onError);
    const good = vi.fn();
    bus.on(() => { throw new Error("bad"); });
    bus.on(good);
    bus.emit({ type: "sessions_changed" });
    expect(good).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "bad" }));
  });
});
```

`tests/approvals.test.ts`：

```ts
import type { BeforeToolCallContext } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalManager } from "../src/policy/approvals.js";
import { createToolGate } from "../src/policy/gate.js";
import { ToolPolicy } from "../src/policy/policy.js";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

const input = { sessionKey: "web:1", windowLabel: "网页会话「测试」", toolName: "bash", args: { command: "ls" } };

describe("ApprovalManager", () => {
  it("lists a pending request and resolves it with the first answer", async () => {
    const onChange = vi.fn();
    const approvals = new ApprovalManager({ onChange, now: () => 1000 });
    const outcome = approvals.request(input);
    const [request] = approvals.pending();
    expect(request).toMatchObject({ sessionKey: "web:1", windowLabel: "网页会话「测试」", toolName: "bash", summary: "ls", createdAt: 1000, expiresAt: 601000 });
    expect(approvals.answer(request!.id, "allow")).toBe(true);
    expect(approvals.answer(request!.id, "deny")).toBe(false);
    await expect(outcome).resolves.toEqual({ allowed: true });
    expect(approvals.pending()).toEqual([]);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("explains a denial", async () => {
    const approvals = new ApprovalManager();
    const outcome = approvals.request(input);
    approvals.answer(approvals.pending()[0]!.id, "deny");
    await expect(outcome).resolves.toEqual({ allowed: false, reason: "主人拒绝了这次 bash 调用。" });
  });

  it("remembers allow_session for that session and tool only", async () => {
    const approvals = new ApprovalManager();
    const outcome = approvals.request(input);
    approvals.answer(approvals.pending()[0]!.id, "allow_session");
    await expect(outcome).resolves.toEqual({ allowed: true });
    expect(approvals.isSessionAllowed("web:1", "bash")).toBe(true);
    expect(approvals.isSessionAllowed("web:1", "write")).toBe(false);
    expect(approvals.isSessionAllowed("wechat", "bash")).toBe(false);
  });

  it("denies after ten minutes without an answer", async () => {
    const approvals = new ApprovalManager();
    const outcome = approvals.request(input);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await expect(outcome).resolves.toEqual({ allowed: false, reason: "主人 10 分钟内没有答复，这次 bash 调用已取消。" });
    expect(approvals.pending()).toEqual([]);
  });

  it("denies when the turn is aborted", async () => {
    const approvals = new ApprovalManager();
    const controller = new AbortController();
    const outcome = approvals.request({ ...input, signal: controller.signal });
    controller.abort();
    await expect(outcome).resolves.toEqual({ allowed: false, reason: "本轮已被中断。" });
    const already = approvals.request({ ...input, signal: controller.signal });
    await expect(already).resolves.toEqual({ allowed: false, reason: "本轮已被中断。" });
  });

  it("denies everything on dispose", async () => {
    const approvals = new ApprovalManager();
    const a = approvals.request(input);
    const b = approvals.request({ ...input, toolName: "write" });
    approvals.dispose();
    await expect(a).resolves.toEqual({ allowed: false, reason: "vexd 正在关闭。" });
    await expect(b).resolves.toEqual({ allowed: false, reason: "vexd 正在关闭。" });
  });
});

function ctx(name: string, args: unknown): BeforeToolCallContext {
  return {
    assistantMessage: {} as BeforeToolCallContext["assistantMessage"],
    toolCall: { type: "toolCall", id: "c1", name, arguments: {} },
    args,
    context: { messages: [] },
  };
}

describe("createToolGate", () => {
  const policy = new ToolPolicy({ workspace: "/ws", overrides: { find: "deny" } });

  it("lets allowed tools through without asking", async () => {
    const approvals = new ApprovalManager();
    const gate = createToolGate({ policy, approvals, sessionKey: "web:1", windowLabel: () => "网页" });
    await expect(gate(ctx("read", { path: "/etc/hosts" }))).resolves.toBeUndefined();
    expect(approvals.pending()).toEqual([]);
  });

  it("blocks denied tools", async () => {
    const gate = createToolGate({ policy, approvals: new ApprovalManager(), sessionKey: "web:1", windowLabel: () => "网页" });
    await expect(gate(ctx("find", {}))).resolves.toEqual({ block: true, reason: "工具 find 已被禁用。" });
  });

  it("asks for approval and maps the outcome", async () => {
    const approvals = new ApprovalManager();
    const gate = createToolGate({ policy, approvals, sessionKey: "web:1", windowLabel: () => "网页会话「A」" });
    const allowed = gate(ctx("bash", { command: "ls" }));
    expect(approvals.pending()[0]?.windowLabel).toBe("网页会话「A」");
    approvals.answer(approvals.pending()[0]!.id, "allow_session");
    await expect(allowed).resolves.toBeUndefined();
    await expect(gate(ctx("bash", { command: "pwd" }))).resolves.toBeUndefined();
    expect(approvals.pending()).toEqual([]);

    const denied = gate(ctx("write", { path: "/etc/x" }));
    approvals.answer(approvals.pending()[0]!.id, "deny");
    await expect(denied).resolves.toEqual({ block: true, reason: "主人拒绝了这次 write 调用。" });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/events.test.ts tests/approvals.test.ts`
Expected: FAIL，无法解析模块。

- [ ] **Step 3: 实现**

`src/core/events.ts`：

```ts
export type SessionEvent =
  | { kind: "user_message"; text: string; timestamp: number }
  | { kind: "text_delta"; delta: string }
  | { kind: "assistant_message"; text: string; stopReason: string; timestamp: number }
  | { kind: "tool_start"; toolCallId: string; toolName: string; summary: string }
  | { kind: "tool_end"; toolCallId: string; toolName: string; isError: boolean }
  | { kind: "busy"; busy: boolean }
  | { kind: "error"; message: string };

export type HistoryItem =
  | { kind: "user"; text: string; timestamp: number }
  | { kind: "assistant"; text: string; stopReason: string; timestamp: number }
  | { kind: "tool"; toolCallId: string; toolName: string; summary: string; isError?: boolean };

export type VexEvent =
  | { type: "session"; sessionKey: string; event: SessionEvent }
  | { type: "sessions_changed" }
  | { type: "approvals_changed" };

export class EventBus {
  private readonly listeners = new Set<(event: VexEvent) => void>();

  constructor(private readonly onListenerError?: (err: unknown) => void) {}

  on(listener: (event: VexEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: VexEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (err) {
        this.onListenerError?.(err);
      }
    }
  }
}
```

`src/policy/approvals.ts`：

```ts
import { randomUUID } from "node:crypto";
import { summarizeArgs } from "../tools/summary.js";

export type ApprovalAnswer = "allow" | "allow_session" | "deny";

export interface ApprovalRequest {
  id: string;
  sessionKey: string;
  windowLabel: string;
  toolName: string;
  summary: string;
  createdAt: number;
  expiresAt: number;
}

export interface ApprovalOutcome {
  allowed: boolean;
  reason?: string;
}

interface Pending {
  request: ApprovalRequest;
  settle: (outcome: ApprovalOutcome) => void;
}

const ABORTED: ApprovalOutcome = { allowed: false, reason: "本轮已被中断。" };

export class ApprovalManager {
  private readonly pendingById = new Map<string, Pending>();
  private readonly sessionAllowed = new Map<string, Set<string>>();
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly onChange: () => void;

  constructor(opts: { timeoutMs?: number; now?: () => number; onChange?: () => void } = {}) {
    this.timeoutMs = opts.timeoutMs ?? 10 * 60_000;
    this.now = opts.now ?? Date.now;
    this.onChange = opts.onChange ?? (() => {});
  }

  request(input: {
    sessionKey: string;
    windowLabel: string;
    toolName: string;
    args: unknown;
    signal?: AbortSignal;
  }): Promise<ApprovalOutcome> {
    if (input.signal?.aborted) return Promise.resolve(ABORTED);
    const createdAt = this.now();
    const request: ApprovalRequest = {
      id: randomUUID(),
      sessionKey: input.sessionKey,
      windowLabel: input.windowLabel,
      toolName: input.toolName,
      summary: summarizeArgs(input.toolName, input.args),
      createdAt,
      expiresAt: createdAt + this.timeoutMs,
    };
    return new Promise((resolve) => {
      const minutes = Math.round(this.timeoutMs / 60_000);
      const timer = setTimeout(
        () => finish({ allowed: false, reason: `主人 ${minutes} 分钟内没有答复，这次 ${input.toolName} 调用已取消。` }),
        this.timeoutMs,
      );
      const onAbort = () => finish(ABORTED);
      const finish = (outcome: ApprovalOutcome) => {
        if (!this.pendingById.delete(request.id)) return;
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", onAbort);
        resolve(outcome);
        this.onChange();
      };
      input.signal?.addEventListener("abort", onAbort, { once: true });
      this.pendingById.set(request.id, { request, settle: finish });
      this.onChange();
    });
  }

  answer(id: string, answer: ApprovalAnswer): boolean {
    const pending = this.pendingById.get(id);
    if (!pending) return false;
    const { request } = pending;
    if (answer === "allow_session") {
      const tools = this.sessionAllowed.get(request.sessionKey) ?? new Set<string>();
      tools.add(request.toolName);
      this.sessionAllowed.set(request.sessionKey, tools);
    }
    pending.settle(
      answer === "deny" ? { allowed: false, reason: `主人拒绝了这次 ${request.toolName} 调用。` } : { allowed: true },
    );
    return true;
  }

  pending(): ApprovalRequest[] {
    return [...this.pendingById.values()].map((p) => ({ ...p.request }));
  }

  isSessionAllowed(sessionKey: string, toolName: string): boolean {
    return this.sessionAllowed.get(sessionKey)?.has(toolName) ?? false;
  }

  dispose(): void {
    for (const pending of [...this.pendingById.values()]) {
      pending.settle({ allowed: false, reason: "vexd 正在关闭。" });
    }
  }
}
```

`src/policy/gate.ts`：

```ts
import type { BeforeToolCallContext, BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import type { ApprovalManager } from "./approvals.js";
import type { ToolPolicy } from "./policy.js";

export function createToolGate(deps: {
  policy: ToolPolicy;
  approvals: ApprovalManager;
  sessionKey: string;
  windowLabel: () => string;
}): (ctx: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined> {
  return async ({ toolCall, args }, signal) => {
    const decision = deps.policy.decide(toolCall.name, args);
    if (decision === "allow") return undefined;
    if (decision === "deny") return { block: true, reason: `工具 ${toolCall.name} 已被禁用。` };
    if (deps.approvals.isSessionAllowed(deps.sessionKey, toolCall.name)) return undefined;
    const outcome = await deps.approvals.request({
      sessionKey: deps.sessionKey,
      windowLabel: deps.windowLabel(),
      toolName: toolCall.name,
      args,
      signal,
    });
    return outcome.allowed ? undefined : { block: true, reason: outcome.reason };
  };
}
```

- [ ] **Step 4: 运行测试与类型检查**

Run: `npx vitest run tests/events.test.ts tests/approvals.test.ts && npm run lint`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/core/events.ts src/policy tests/events.test.ts tests/approvals.test.ts
git commit -m "feat: event bus, pending approvals and tool gate

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 10: Session（包装 pi Agent）

**Files:**
- Create: `src/core/session.ts`
- Test: `tests/session.test.ts`

**Interfaces:**
- Consumes: `appendJsonl`、`readJsonl`（Task 1）、`ThinkingSetting`（Task 2）、测试辅助 `createFaux`/`fauxStreamFn`/`lastUserText`（Task 3）、`summarizeArgs`（Task 8）、`SessionEvent`、`HistoryItem`（Task 9）
- Produces:

```ts
export interface SessionOptions {
  key: string;
  transcriptPath: string;
  model: Model<Api>;
  thinking?: ThinkingSetting;
  tools: AgentTool<any>[];
  streamFn: StreamFn;
  getApiKey: (provider: string) => string | undefined;
  buildSystemPrompt: () => Promise<string>;
  beforeToolCall?: (ctx: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
  emit: (event: SessionEvent) => void;
  onError?: (err: unknown) => void;
  retry?: { attempts: number; baseDelayMs: number };   // 默认 { attempts: 3, baseDelayMs: 1000 }
}

export class Session {
  readonly key: string;
  static open(opts: SessionOptions): Promise<Session>;   // 从 transcriptPath 恢复历史
  get busy(): boolean;
  send(text: string): void;       // 空闲则开始一轮；运行中则作为插话
  stop(): void;                   // 中断当前轮并清空插话队列
  whenIdle(): Promise<void>;
  history(): { items: HistoryItem[]; streaming?: string };
  dispose(): Promise<void>;       // stop + whenIdle
}
```

行为（spec §6）：
- 每次模型请求前（含工具调用后的续写、插话与重试）在 pi 的 `prepareRequest` 中调用 `buildSystemPrompt()`，用结果替换请求上下文中首条 system 消息的内容，工具声明保持不变；持久化的对话记录不受影响。
- 对话记录只保存 `user`、`assistant`、`toolResult` 消息；system 消息在每次打开会话时由 pi 根据当前工具集重新生成。
- 每条 `message_end` 追加写入 JSONL；`stopReason === "error"` 的助手消息不写入，并从内存历史中移除后按 1s、2s、4s 退避重试，最多 3 次；仍失败时发出 `{ kind: "error", message: "模型调用失败：<原因>" }`。
- 被中断的助手消息照常写入（pi-ai 在后续请求中会自动跳过它）。
- 一轮从开始到结束只发出一次 `busy: true` 与一次 `busy: false`。

- [ ] **Step 1: 写失败的测试**

`tests/session.test.ts`：

```ts
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt, type FauxProviderHandle } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionEvent } from "../src/core/events.js";
import { Session, type SessionOptions } from "../src/core/session.js";
import { readJsonl } from "../src/store/jsonl.js";
import { createFaux, fauxStreamFn, lastUserText } from "./helpers/faux.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

let dir: string;
let faux: FauxProviderHandle;
let events: SessionEvent[];

beforeEach(async () => {
  dir = await makeTmpDir();
  events = [];
});
afterEach(async () => {
  await removeTmpDir(dir);
});

const EchoParams = Type.Object({ text: Type.String() });
const echoTool: AgentTool<typeof EchoParams> = {
  name: "echo",
  label: "Echo",
  description: "echo",
  parameters: EchoParams,
  execute: async (_id, { text }) => ({ content: [{ type: "text", text: `echo:${text}` }], details: {} }),
};

function open(overrides: Partial<SessionOptions> = {}): Promise<Session> {
  return Session.open({
    key: "web:1",
    transcriptPath: join(dir, "t.jsonl"),
    model: faux.getModel(),
    tools: [echoTool],
    streamFn: fauxStreamFn(faux),
    getApiKey: () => "test-key",
    buildSystemPrompt: async () => "SYSTEM",
    emit: (event) => events.push(event),
    retry: { attempts: 3, baseDelayMs: 1 },
    ...overrides,
  });
}

const kinds = () => events.filter((e) => e.kind !== "text_delta").map((e) => e.kind);

describe("Session", () => {
  it("streams a reply, persists the transcript and reports busy once", async () => {
    faux = createFaux();
    faux.setResponses([(ctx) => fauxAssistantMessage(`sys=${getCurrentSystemPrompt(ctx.messages)}`)]);
    const session = await open();
    session.send("你好");
    expect(session.busy).toBe(true);
    await session.whenIdle();
    expect(session.busy).toBe(false);
    expect(kinds()).toEqual(["busy", "user_message", "assistant_message", "busy"]);
    expect(events.filter((e) => e.kind === "text_delta").map((e) => e.delta).join("")).toBe("sys=SYSTEM");
    expect(events.at(-2)).toMatchObject({ kind: "assistant_message", text: "sys=SYSTEM", stopReason: "stop" });
    const saved = await readJsonl<{ role: string }>(join(dir, "t.jsonl"));
    expect(saved.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("restores history from the transcript", async () => {
    faux = createFaux();
    faux.setResponses([
      fauxAssistantMessage("第一次"),
      (ctx) => fauxAssistantMessage(`看到 ${ctx.messages.filter((m) => m.role !== "system").length} 条消息`),
    ]);
    const first = await open();
    first.send("一");
    await first.whenIdle();

    const second = await open();
    expect(second.history().items).toMatchObject([
      { kind: "user", text: "一" },
      { kind: "assistant", text: "第一次" },
    ]);
    second.send("二");
    await second.whenIdle();
    expect(events.at(-2)).toMatchObject({ kind: "assistant_message", text: "看到 3 条消息" });
  });

  it("runs tools and reports them", async () => {
    faux = createFaux();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("echo", { text: "hi" }, { id: "call-1" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    const session = await open();
    session.send("go");
    await session.whenIdle();
    expect(kinds()).toEqual(["busy", "user_message", "tool_start", "tool_end", "assistant_message", "busy"]);
    expect(events.find((e) => e.kind === "tool_start")).toEqual({
      kind: "tool_start", toolCallId: "call-1", toolName: "echo", summary: '{"text":"hi"}',
    });
    expect(session.history().items).toEqual([
      expect.objectContaining({ kind: "user", text: "go" }),
      { kind: "tool", toolCallId: "call-1", toolName: "echo", summary: '{"text":"hi"}', isError: false },
      expect.objectContaining({ kind: "assistant", text: "done" }),
    ]);
  });

  it("feeds a blocked tool's reason back to the model", async () => {
    faux = createFaux();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("echo", { text: "x" }), { stopReason: "toolUse" }),
      (ctx) => {
        const result = ctx.messages.at(-1);
        const text = result?.role === "toolResult" ? result.content.map((c) => (c.type === "text" ? c.text : "")).join("") : "";
        return fauxAssistantMessage(`model saw: ${text}`);
      },
    ]);
    const session = await open({ beforeToolCall: async () => ({ block: true, reason: "主人拒绝了这次 echo 调用。" }) });
    session.send("go");
    await session.whenIdle();
    expect(events.find((e) => e.kind === "tool_end")).toMatchObject({ isError: true });
    expect(events.at(-2)).toMatchObject({ text: "model saw: 主人拒绝了这次 echo 调用。" });
  });

  it("injects a message sent while busy into the same run", async () => {
    faux = createFaux(20);
    faux.setResponses([
      fauxAssistantMessage("aaaa bbbb cccc dddd eeee"),
      (ctx) => fauxAssistantMessage(`回应：${lastUserText(ctx)}`),
    ]);
    const session = await open();
    session.send("一");
    await new Promise((r) => setTimeout(r, 100));
    session.send("二");
    await session.whenIdle();
    expect(kinds()).toEqual(["busy", "user_message", "assistant_message", "user_message", "assistant_message", "busy"]);
    expect(events.at(-2)).toMatchObject({ text: "回应：二" });
  });

  it("stops the current turn and drops queued messages", async () => {
    faux = createFaux(20);
    faux.setResponses([fauxAssistantMessage("long ".repeat(80)), fauxAssistantMessage("never")]);
    const session = await open();
    session.send("go");
    await new Promise((r) => setTimeout(r, 200));
    session.send("queued");
    session.stop();
    await session.whenIdle();
    const last = events.filter((e) => e.kind === "assistant_message").at(-1);
    expect(last).toMatchObject({ stopReason: "aborted" });
    expect(events.some((e) => e.kind === "user_message" && e.text === "queued")).toBe(false);
    expect(faux.getPendingResponseCount()).toBe(1);
  });

  it("retries a failed model call and keeps errors out of the transcript", async () => {
    faux = createFaux();
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" }),
      fauxAssistantMessage("ok"),
    ]);
    const session = await open();
    session.send("go");
    await session.whenIdle();
    expect(kinds()).toEqual(["busy", "user_message", "assistant_message", "busy"]);
    const saved = await readJsonl<{ role: string; stopReason?: string }>(join(dir, "t.jsonl"));
    expect(saved.map((m) => m.stopReason ?? m.role)).toEqual(["user", "stop"]);
  });

  it("reports the error after exhausting retries", async () => {
    faux = createFaux();
    const failure = fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" });
    faux.setResponses([failure, failure, failure, failure]);
    const session = await open();
    session.send("go");
    await session.whenIdle();
    expect(events).toContainEqual({ kind: "error", message: "模型调用失败：boom" });
    expect(faux.getPendingResponseCount()).toBe(0);
    expect(session.history().items.map((i) => i.kind)).toEqual(["user"]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/session.test.ts`
Expected: FAIL，无法解析 `../src/core/session.js`。

- [ ] **Step 3: 实现**

`src/core/session.ts`：

```ts
import { setTimeout as delay } from "node:timers/promises";
import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type BeforeToolCallContext,
  type BeforeToolCallResult,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, ImageContent, Model, TextContent, UserMessage } from "@earendil-works/pi-ai";
import type { ThinkingSetting } from "../config/schema.js";
import { appendJsonl, readJsonl } from "../store/jsonl.js";
import { summarizeArgs } from "../tools/summary.js";
import type { HistoryItem, SessionEvent } from "./events.js";

export interface SessionOptions {
  key: string;
  transcriptPath: string;
  model: Model<Api>;
  thinking?: ThinkingSetting;
  tools: AgentTool<any>[];
  streamFn: StreamFn;
  getApiKey: (provider: string) => string | undefined;
  buildSystemPrompt: () => Promise<string>;
  beforeToolCall?: (ctx: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
  emit: (event: SessionEvent) => void;
  onError?: (err: unknown) => void;
  retry?: { attempts: number; baseDelayMs: number };
}

const DEFAULT_RETRY = { attempts: 3, baseDelayMs: 1000 };

export class Session {
  readonly key: string;
  private readonly agent: Agent;
  private current: Promise<void> | undefined;
  private stopRequested = false;

  static async open(opts: SessionOptions): Promise<Session> {
    const records = await readJsonl<AgentMessage>(opts.transcriptPath);
    return new Session(opts, records.filter(isTranscriptMessage));
  }

  private constructor(
    private readonly opts: SessionOptions,
    messages: AgentMessage[],
  ) {
    this.key = opts.key;
    this.agent = new Agent({
      initialState: {
        systemPrompt: "",
        model: opts.model,
        thinkingLevel: opts.thinking ?? "off",
        tools: opts.tools,
        messages,
      },
      streamFn: opts.streamFn,
      getApiKey: opts.getApiKey,
      beforeToolCall: opts.beforeToolCall,
      // Rebuilt before every request so time, window and workspace files are always current.
      prepareRequest: async ({ context }) => ({
        context: { ...context, messages: withSystemPrompt(context.messages, await opts.buildSystemPrompt()) },
      }),
      sessionId: opts.key,
    });
    this.agent.subscribe((event) => this.onAgentEvent(event));
  }

  get busy(): boolean {
    return this.current !== undefined;
  }

  send(text: string): void {
    const message: UserMessage = { role: "user", content: text, timestamp: Date.now() };
    if (this.current) {
      this.agent.steer(message);
      return;
    }
    this.stopRequested = false;
    this.opts.emit({ kind: "busy", busy: true });
    this.current = this.run(message)
      .catch((err: unknown) => {
        this.opts.onError?.(err);
        this.opts.emit({ kind: "error", message: `处理消息时出错：${err instanceof Error ? err.message : String(err)}` });
      })
      .finally(() => {
        this.current = undefined;
        this.opts.emit({ kind: "busy", busy: false });
      });
  }

  stop(): void {
    if (!this.current) return;
    this.stopRequested = true;
    this.agent.clearAllQueues();
    this.agent.abort();
  }

  whenIdle(): Promise<void> {
    return this.current ?? Promise.resolve();
  }

  async dispose(): Promise<void> {
    this.stop();
    await this.whenIdle();
  }

  history(): { items: HistoryItem[]; streaming?: string } {
    const items: HistoryItem[] = [];
    const toolItems = new Map<string, Extract<HistoryItem, { kind: "tool" }>>();
    for (const message of this.agent.state.messages) {
      if (message.role === "user") {
        items.push({ kind: "user", text: contentText(message.content), timestamp: message.timestamp });
      } else if (message.role === "assistant") {
        const text = assistantText(message);
        if (text || message.stopReason === "aborted") {
          items.push({ kind: "assistant", text, stopReason: message.stopReason, timestamp: message.timestamp });
        }
        for (const block of message.content) {
          if (block.type !== "toolCall") continue;
          const item: Extract<HistoryItem, { kind: "tool" }> = {
            kind: "tool",
            toolCallId: block.id,
            toolName: block.name,
            summary: summarizeArgs(block.name, block.arguments),
          };
          toolItems.set(block.id, item);
          items.push(item);
        }
      } else if (message.role === "toolResult") {
        const item = toolItems.get(message.toolCallId);
        if (item) item.isError = message.isError;
      }
    }
    const streaming = this.agent.state.streamingMessage;
    return { items, streaming: streaming?.role === "assistant" ? assistantText(streaming) : undefined };
  }

  private async run(first: UserMessage): Promise<void> {
    await this.agent.prompt(first);
    await this.settle();
    // A message steered in just as the loop finished is still queued; run it now.
    while (!this.stopRequested && this.agent.hasQueuedMessages()) {
      await this.agent.continue();
      await this.settle();
    }
  }

  private async settle(): Promise<void> {
    const { attempts, baseDelayMs } = this.opts.retry ?? DEFAULT_RETRY;
    for (let attempt = 1; ; attempt++) {
      const last = this.agent.state.messages.at(-1);
      if (last?.role !== "assistant" || last.stopReason !== "error") return;
      this.agent.state.messages = this.agent.state.messages.slice(0, -1);
      if (this.stopRequested) return;
      if (attempt > attempts) {
        this.opts.emit({ kind: "error", message: `模型调用失败：${last.errorMessage ?? "未知错误"}` });
        return;
      }
      await delay(baseDelayMs * 2 ** (attempt - 1));
      if (this.stopRequested) return;
      await this.agent.continue();
    }
  }

  private async onAgentEvent(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case "message_update":
        if (event.assistantMessageEvent.type === "text_delta") {
          this.opts.emit({ kind: "text_delta", delta: event.assistantMessageEvent.delta });
        }
        return;
      case "message_end": {
        const message = event.message;
        // System messages are rebuilt from the current prompt and tools on every start.
        if (message.role === "system") return;
        if (message.role === "assistant" && message.stopReason === "error") return;
        await appendJsonl(this.opts.transcriptPath, message);
        if (message.role === "user") {
          this.opts.emit({ kind: "user_message", text: contentText(message.content), timestamp: message.timestamp });
        } else if (message.role === "assistant") {
          const text = assistantText(message);
          if (text || message.stopReason === "aborted") {
            this.opts.emit({ kind: "assistant_message", text, stopReason: message.stopReason, timestamp: message.timestamp });
          }
        }
        return;
      }
      case "tool_execution_start":
        this.opts.emit({
          kind: "tool_start",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          summary: summarizeArgs(event.toolName, event.args),
        });
        return;
      case "tool_execution_end":
        this.opts.emit({ kind: "tool_end", toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError });
        return;
      default:
        return;
    }
  }
}

function isTranscriptMessage(value: unknown): value is AgentMessage {
  if (!value || typeof value !== "object") return false;
  const role = (value as { role?: unknown }).role;
  return role === "user" || role === "assistant" || role === "toolResult";
}

function withSystemPrompt(messages: AgentMessage[], prompt: string): AgentMessage[] {
  const [head, ...rest] = messages;
  if (head?.role === "system") return [{ ...head, content: prompt }, ...rest];
  return [{ role: "system", content: prompt, timestamp: Date.now() }, ...messages];
}

function contentText(content: string | (TextContent | ImageContent)[]): string {
  if (typeof content === "string") return content;
  return content.map((c) => (c.type === "text" ? c.text : "[图片]")).join("");
}

function assistantText(message: AssistantMessage): string {
  return message.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
}
```

- [ ] **Step 4: 运行测试与类型检查**

Run: `npx vitest run tests/session.test.ts && npm run lint`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/core/session.ts tests/session.test.ts
git commit -m "feat: session over pi agent with steering, stop, retry and persistence

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: WebChat 会话索引、标题生成与 SessionManager

**Files:**
- Create: `src/core/webSessions.ts`, `src/core/title.ts`, `src/core/sessionManager.ts`
- Test: `tests/title.test.ts`, `tests/session-manager.test.ts`

**Interfaces:**
- Consumes: `VexPaths`、`writeFileAtomic`（Task 1）、`EventBus`、`VexEvent`（Task 9）、`Session`（Task 10）
- Produces（`src/core/webSessions.ts`）：
  - `interface WebSessionMeta { id: string; title: string; titled: boolean; createdAt: number; updatedAt: number }`
  - `DEFAULT_TITLE = "新对话"`
  - `class WebSessionIndex { constructor(file: string, dir: string); load(): Promise<void>; list(): WebSessionMeta[]; get(id: string): WebSessionMeta | undefined; create(now: number): Promise<WebSessionMeta>; update(id: string, patch: Partial<Pick<WebSessionMeta, "title" | "titled" | "updatedAt">>): Promise<WebSessionMeta | undefined>; remove(id: string): Promise<void> }`
- Produces（`src/core/title.ts`）：
  - `cleanTitle(raw: string): string`
  - `createTitleGenerator(opts: { model: Model<Api>; complete: CompleteFn; getApiKey: (provider: string) => string | undefined }): (userText: string, assistantText: string) => Promise<string>`（`CompleteFn` 来自 Task 3）
- Produces（`src/core/sessionManager.ts`）：
  - `WECHAT_SESSION_KEY = "wechat"`、`webSessionKey(id: string): string`（返回 `web:<id>`）
  - `class UnknownSessionError extends Error`
  - `interface SessionManagerOptions { paths: VexPaths; bus: EventBus; openSession: (key: string, transcriptPath: string, windowLabel: () => string) => Promise<Session>; generateTitle?: (userText: string, assistantText: string) => Promise<string>; onError?: (err: unknown) => void }`
  - `class SessionManager { constructor(opts: SessionManagerOptions); init(): Promise<void>; get(key: string): Promise<Session>; windowLabel(key: string): string; listWeb(): WebSessionMeta[]; createWeb(): Promise<WebSessionMeta>; renameWeb(id: string, title: string): Promise<void>; deleteWeb(id: string): Promise<void>; shutdown(): Promise<void> }`

规则：
- 会话文件：微信 `sessions/wechat.jsonl`，WebChat `sessions/web/<id>.jsonl`，索引 `sessions/web/index.json`。
- 索引缺失或损坏时，按 `sessions/web/*.jsonl` 重建，标题为“未命名对话”且不再自动生成。
- WebChat 会话收到首条回复后，用后台模型生成标题；主人手动改名后不再自动生成。
- 列表按最近活动时间倒序；会话有新消息、新建、改名、删除时发出 `sessions_changed`。
- 窗口名称：微信为“微信”，WebChat 为“网页会话「标题」”。

- [ ] **Step 1: 写失败的测试**

`tests/title.test.ts`：

```ts
import { fauxAssistantMessage, type FauxProviderHandle } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { cleanTitle, createTitleGenerator } from "../src/core/title.js";
import { createFaux, fauxModels, lastUserText } from "./helpers/faux.js";

let faux: FauxProviderHandle;

describe("cleanTitle", () => {
  it("keeps the first line without quotes or a label", () => {
    expect(cleanTitle("「周末去爬山」\n多余")).toBe("周末去爬山");
    expect(cleanTitle("标题：“咖啡推荐”")).toBe("咖啡推荐");
    expect(cleanTitle("一".repeat(30))).toBe("一".repeat(20));
  });
});

describe("createTitleGenerator", () => {
  it("asks the model with both sides of the exchange", async () => {
    faux = createFaux();
    let seen = "";
    faux.setResponses([(ctx) => { seen = lastUserText(ctx); return fauxAssistantMessage("《咖啡推荐》"); }]);
    const models = fauxModels(faux);
    const generate = createTitleGenerator({
      model: faux.getModel(),
      complete: (model, context, options) => models.completeSimple(model, context, options),
      getApiKey: () => "k",
    });
    await expect(generate("推荐咖啡", "试试耶加雪菲")).resolves.toBe("咖啡推荐");
    expect(seen).toBe("主人：推荐咖啡\n助手：试试耶加雪菲");
  });

  it("fails on a model error or an empty title", async () => {
    faux = createFaux();
    faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" }), fauxAssistantMessage("  ")]);
    const models = fauxModels(faux);
    const generate = createTitleGenerator({
      model: faux.getModel(),
      complete: (model, context, options) => models.completeSimple(model, context, options),
      getApiKey: () => "k",
    });
    await expect(generate("a", "b")).rejects.toThrow(/boom/);
    await expect(generate("a", "b")).rejects.toThrow(/为空/);
  });
});
```

`tests/session-manager.test.ts`：

```ts
import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, getCurrentSystemPrompt, type FauxProviderHandle } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventBus, type VexEvent } from "../src/core/events.js";
import { Session } from "../src/core/session.js";
import { SessionManager, UnknownSessionError, WECHAT_SESSION_KEY, webSessionKey } from "../src/core/sessionManager.js";
import { resolvePaths, type VexPaths } from "../src/paths.js";
import { createFaux, fauxStreamFn } from "./helpers/faux.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

let dir: string;
let paths: VexPaths;
let faux: FauxProviderHandle;
let busEvents: VexEvent[];

beforeEach(async () => {
  dir = await makeTmpDir();
  paths = resolvePaths(dir);
  busEvents = [];
});
afterEach(async () => {
  await removeTmpDir(dir);
});

function makeManager(generateTitle?: (u: string, a: string) => Promise<string>) {
  const bus = new EventBus();
  bus.on((e) => busEvents.push(e));
  const manager = new SessionManager({
    paths,
    bus,
    generateTitle,
    openSession: (key, transcriptPath, windowLabel) =>
      Session.open({
        key,
        transcriptPath,
        model: faux.getModel(),
        tools: [],
        streamFn: fauxStreamFn(faux),
        getApiKey: () => "k",
        buildSystemPrompt: async () => windowLabel(),
        emit: (event) => bus.emit({ type: "session", sessionKey: key, event }),
      }),
  });
  return manager;
}

describe("SessionManager", () => {
  it("creates web sessions and persists the index", async () => {
    faux = createFaux();
    const manager = makeManager();
    await manager.init();
    const meta = await manager.createWeb();
    expect(meta).toMatchObject({ title: "新对话", titled: false });
    expect(busEvents).toContainEqual({ type: "sessions_changed" });

    const again = makeManager();
    await again.init();
    expect(again.listWeb().map((m) => m.id)).toEqual([meta.id]);
  });

  it("labels windows for the system prompt", async () => {
    faux = createFaux();
    const prompts: string[] = [];
    faux.setResponses([
      (ctx) => { prompts.push(getCurrentSystemPrompt(ctx.messages)); return fauxAssistantMessage("a"); },
      (ctx) => { prompts.push(getCurrentSystemPrompt(ctx.messages)); return fauxAssistantMessage("b"); },
    ]);
    const manager = makeManager();
    await manager.init();
    const meta = await manager.createWeb();
    const web = await manager.get(webSessionKey(meta.id));
    web.send("hi");
    await web.whenIdle();
    const wechat = await manager.get(WECHAT_SESSION_KEY);
    wechat.send("hi");
    await wechat.whenIdle();
    expect(prompts).toEqual(["网页会话「新对话」", "微信"]);
    expect((await stat(join(paths.sessions, "wechat.jsonl"))).isFile()).toBe(true);
  });

  it("returns the same session instance for the same key", async () => {
    faux = createFaux();
    const manager = makeManager();
    await manager.init();
    const [a, b] = await Promise.all([manager.get(WECHAT_SESSION_KEY), manager.get(WECHAT_SESSION_KEY)]);
    expect(a).toBe(b);
  });

  it("titles a web session after its first reply", async () => {
    faux = createFaux();
    faux.setResponses([fauxAssistantMessage("推荐耶加雪菲"), fauxAssistantMessage("不客气")]);
    const generateTitle = vi.fn(async (_user: string, _assistant: string) => "咖啡推荐");
    const manager = makeManager(generateTitle);
    await manager.init();
    const meta = await manager.createWeb();
    const session = await manager.get(webSessionKey(meta.id));
    session.send("推荐咖啡");
    await session.whenIdle();
    await vi.waitFor(() => expect(manager.listWeb()[0]).toMatchObject({ title: "咖啡推荐", titled: true }));
    session.send("谢谢");
    await session.whenIdle();
    expect(generateTitle).toHaveBeenCalledTimes(1);
    expect(generateTitle).toHaveBeenCalledWith("推荐咖啡", "推荐耶加雪菲");
  });

  it("does not auto-title a renamed session", async () => {
    faux = createFaux();
    faux.setResponses([fauxAssistantMessage("x")]);
    const generateTitle = vi.fn(async (_user: string, _assistant: string) => "自动");
    const manager = makeManager(generateTitle);
    await manager.init();
    const meta = await manager.createWeb();
    await manager.renameWeb(meta.id, "  我的标题  ");
    const session = await manager.get(webSessionKey(meta.id));
    session.send("hi");
    await session.whenIdle();
    expect(generateTitle).not.toHaveBeenCalled();
    expect(manager.listWeb()[0]?.title).toBe("我的标题");
    expect(manager.windowLabel(webSessionKey(meta.id))).toBe("网页会话「我的标题」");
  });

  it("orders sessions by latest activity", async () => {
    faux = createFaux();
    faux.setResponses([fauxAssistantMessage("x")]);
    const manager = makeManager();
    await manager.init();
    const older = await manager.createWeb();
    await new Promise((r) => setTimeout(r, 5));
    const newer = await manager.createWeb();
    expect(manager.listWeb().map((m) => m.id)).toEqual([newer.id, older.id]);
    await new Promise((r) => setTimeout(r, 5));
    const session = await manager.get(webSessionKey(older.id));
    session.send("hi");
    await session.whenIdle();
    await vi.waitFor(() => expect(manager.listWeb().map((m) => m.id)).toEqual([older.id, newer.id]));
  });

  it("deletes a session with its transcript", async () => {
    faux = createFaux();
    faux.setResponses([fauxAssistantMessage("x")]);
    const manager = makeManager();
    await manager.init();
    const meta = await manager.createWeb();
    const session = await manager.get(webSessionKey(meta.id));
    session.send("hi");
    await session.whenIdle();
    await manager.deleteWeb(meta.id);
    expect(manager.listWeb()).toEqual([]);
    await expect(stat(join(paths.webSessions, `${meta.id}.jsonl`))).rejects.toThrow();
    await expect(manager.get(webSessionKey(meta.id))).rejects.toThrow(UnknownSessionError);
    await expect(manager.deleteWeb(meta.id)).rejects.toThrow(UnknownSessionError);
  });

  it("rejects unknown keys", async () => {
    faux = createFaux();
    const manager = makeManager();
    await manager.init();
    await expect(manager.get("web:nope")).rejects.toThrow(UnknownSessionError);
    await expect(manager.get("../etc")).rejects.toThrow(UnknownSessionError);
  });

  it("rebuilds a corrupt index from transcripts", async () => {
    faux = createFaux();
    await mkdir(paths.webSessions, { recursive: true });
    await writeFile(join(paths.webSessions, "abc.jsonl"), "", "utf8");
    await writeFile(join(paths.webSessions, "index.json"), "{not json", "utf8");
    const manager = makeManager();
    await manager.init();
    expect(manager.listWeb()).toEqual([expect.objectContaining({ id: "abc", title: "未命名对话", titled: true })]);
    expect(JSON.parse(await readFile(join(paths.webSessions, "index.json"), "utf8"))).toHaveLength(1);
  });

  it("stops running sessions on shutdown", async () => {
    faux = createFaux(20);
    faux.setResponses([fauxAssistantMessage("long ".repeat(80))]);
    const manager = makeManager();
    await manager.init();
    const session = await manager.get(WECHAT_SESSION_KEY);
    session.send("go");
    await new Promise((r) => setTimeout(r, 100));
    await manager.shutdown();
    expect(session.busy).toBe(false);
    expect(session.history().items.at(-1)).toMatchObject({ kind: "assistant", stopReason: "aborted" });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/title.test.ts tests/session-manager.test.ts`
Expected: FAIL，无法解析模块。

- [ ] **Step 3: 实现**

`src/core/webSessions.ts`：

```ts
import { randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../store/atomic.js";

export interface WebSessionMeta {
  id: string;
  title: string;
  titled: boolean;
  createdAt: number;
  updatedAt: number;
}

export const DEFAULT_TITLE = "新对话";
const RECOVERED_TITLE = "未命名对话";

export class WebSessionIndex {
  private metas = new Map<string, WebSessionMeta>();
  private saving: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly dir: string,
  ) {}

  async load(): Promise<void> {
    let text: string | undefined;
    try {
      text = await readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (text !== undefined) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (Array.isArray(parsed)) {
          this.metas = new Map(parsed.filter(isMeta).map((m) => [m.id, m]));
          return;
        }
      } catch {
        // Fall through and rebuild from the transcripts on disk.
      }
    }
    await this.rebuild();
  }

  list(): WebSessionMeta[] {
    return [...this.metas.values()].sort((a, b) => b.updatedAt - a.updatedAt).map((m) => ({ ...m }));
  }

  get(id: string): WebSessionMeta | undefined {
    const meta = this.metas.get(id);
    return meta ? { ...meta } : undefined;
  }

  async create(now: number): Promise<WebSessionMeta> {
    const meta: WebSessionMeta = { id: randomUUID(), title: DEFAULT_TITLE, titled: false, createdAt: now, updatedAt: now };
    this.metas.set(meta.id, meta);
    await this.save();
    return { ...meta };
  }

  async update(
    id: string,
    patch: Partial<Pick<WebSessionMeta, "title" | "titled" | "updatedAt">>,
  ): Promise<WebSessionMeta | undefined> {
    const meta = this.metas.get(id);
    if (!meta) return undefined;
    Object.assign(meta, patch);
    await this.save();
    return { ...meta };
  }

  async remove(id: string): Promise<void> {
    if (this.metas.delete(id)) await this.save();
  }

  private async rebuild(): Promise<void> {
    this.metas.clear();
    let names: string[] = [];
    try {
      names = await readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const info = await stat(join(this.dir, name));
      const id = name.slice(0, -".jsonl".length);
      this.metas.set(id, {
        id,
        title: RECOVERED_TITLE,
        titled: true,
        createdAt: Math.floor(info.birthtimeMs || info.mtimeMs),
        updatedAt: Math.floor(info.mtimeMs),
      });
    }
    if (this.metas.size > 0) await this.save();
  }

  private save(): Promise<void> {
    // Serialize writes so an older snapshot can never land after a newer one.
    const run = this.saving.then(() => writeFileAtomic(this.file, JSON.stringify([...this.metas.values()], null, 2)));
    this.saving = run.catch(() => {});
    return run;
  }
}

function isMeta(value: unknown): value is WebSessionMeta {
  if (!value || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.id === "string" &&
    typeof m.title === "string" &&
    typeof m.titled === "boolean" &&
    typeof m.createdAt === "number" &&
    typeof m.updatedAt === "number"
  );
}
```

`src/core/title.ts`：

```ts
import type { Api, Model } from "@earendil-works/pi-ai";
import type { CompleteFn } from "../providers/models.js";

export function cleanTitle(raw: string): string {
  const firstLine = raw.trim().split("\n")[0] ?? "";
  return firstLine
    .replace(/^标题[:：]\s*/, "")
    .replace(/["'“”‘’「」《》]/g, "")
    .trim()
    .slice(0, 20);
}

export function createTitleGenerator(opts: {
  model: Model<Api>;
  complete: CompleteFn;
  getApiKey: (provider: string) => string | undefined;
}): (userText: string, assistantText: string) => Promise<string> {
  return async (userText, assistantText) => {
    const result = await opts.complete(
      opts.model,
      {
        systemPrompt: "你为一段对话起标题。只输出标题本身，不超过 12 个字，不加引号和句末标点。",
        messages: [
          {
            role: "user",
            content: `主人：${userText.slice(0, 500)}\n助手：${assistantText.slice(0, 500)}`,
            timestamp: Date.now(),
          },
        ],
      },
      { apiKey: opts.getApiKey(opts.model.provider), maxTokens: 256 },
    );
    if (result.stopReason === "error" || result.stopReason === "aborted") {
      throw new Error(`生成标题失败：${result.errorMessage ?? result.stopReason}`);
    }
    const title = cleanTitle(result.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join(""));
    if (!title) throw new Error("生成标题失败：模型返回为空");
    return title;
  };
}
```

`src/core/sessionManager.ts`：

```ts
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { VexPaths } from "../paths.js";
import type { EventBus, VexEvent } from "./events.js";
import type { Session } from "./session.js";
import { WebSessionIndex, type WebSessionMeta } from "./webSessions.js";

export const WECHAT_SESSION_KEY = "wechat";
const WEB_PREFIX = "web:";

export function webSessionKey(id: string): string {
  return `${WEB_PREFIX}${id}`;
}

export class UnknownSessionError extends Error {}

export interface SessionManagerOptions {
  paths: VexPaths;
  bus: EventBus;
  openSession: (key: string, transcriptPath: string, windowLabel: () => string) => Promise<Session>;
  generateTitle?: (userText: string, assistantText: string) => Promise<string>;
  onError?: (err: unknown) => void;
}

export class SessionManager {
  private readonly sessions = new Map<string, Promise<Session>>();
  private readonly index: WebSessionIndex;
  private readonly untitledFirstMessage = new Map<string, string>();
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly opts: SessionManagerOptions) {
    this.index = new WebSessionIndex(join(opts.paths.webSessions, "index.json"), opts.paths.webSessions);
  }

  async init(): Promise<void> {
    await this.index.load();
    this.unsubscribe = this.opts.bus.on((event) => this.onEvent(event));
  }

  get(key: string): Promise<Session> {
    const existing = this.sessions.get(key);
    if (existing) return existing;
    let transcriptPath: string;
    try {
      transcriptPath = this.transcriptPath(key);
    } catch (err) {
      return Promise.reject(err);
    }
    const opening = this.opts.openSession(key, transcriptPath, () => this.windowLabel(key));
    this.sessions.set(key, opening);
    opening.catch(() => this.sessions.delete(key));
    return opening;
  }

  windowLabel(key: string): string {
    if (key === WECHAT_SESSION_KEY) return "微信";
    const meta = this.index.get(key.slice(WEB_PREFIX.length));
    return `网页会话「${meta?.title ?? "未命名"}」`;
  }

  listWeb(): WebSessionMeta[] {
    return this.index.list();
  }

  async createWeb(): Promise<WebSessionMeta> {
    const meta = await this.index.create(Date.now());
    this.opts.bus.emit({ type: "sessions_changed" });
    return meta;
  }

  async renameWeb(id: string, title: string): Promise<void> {
    const updated = await this.index.update(id, { title: title.trim().slice(0, 100), titled: true });
    if (!updated) throw new UnknownSessionError(`没有这个网页会话：${id}`);
    this.untitledFirstMessage.delete(id);
    this.opts.bus.emit({ type: "sessions_changed" });
  }

  async deleteWeb(id: string): Promise<void> {
    if (!this.index.get(id)) throw new UnknownSessionError(`没有这个网页会话：${id}`);
    const key = webSessionKey(id);
    const transcriptPath = this.transcriptPath(key);
    const loaded = this.sessions.get(key);
    this.sessions.delete(key);
    const session = await loaded?.catch(() => undefined);
    await session?.dispose();
    await rm(transcriptPath, { force: true });
    await this.index.remove(id);
    this.untitledFirstMessage.delete(id);
    this.opts.bus.emit({ type: "sessions_changed" });
  }

  async shutdown(): Promise<void> {
    this.unsubscribe?.();
    const settled = await Promise.allSettled([...this.sessions.values()]);
    const open = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    for (const session of open) session.stop();
    await Promise.allSettled(open.map((s) => s.whenIdle()));
  }

  private transcriptPath(key: string): string {
    if (key === WECHAT_SESSION_KEY) return join(this.opts.paths.sessions, "wechat.jsonl");
    if (key.startsWith(WEB_PREFIX)) {
      const id = key.slice(WEB_PREFIX.length);
      if (this.index.get(id)) return join(this.opts.paths.webSessions, `${id}.jsonl`);
    }
    throw new UnknownSessionError(`没有这个会话：${key}`);
  }

  private onEvent(event: VexEvent): void {
    if (event.type !== "session" || !event.sessionKey.startsWith(WEB_PREFIX)) return;
    const id = event.sessionKey.slice(WEB_PREFIX.length);
    const meta = this.index.get(id);
    if (!meta) return;
    const e = event.event;
    if (e.kind === "user_message") {
      if (!meta.titled && !this.untitledFirstMessage.has(id)) this.untitledFirstMessage.set(id, e.text);
      this.index
        .update(id, { updatedAt: e.timestamp })
        .then(() => this.opts.bus.emit({ type: "sessions_changed" }))
        .catch((err: unknown) => this.opts.onError?.(err));
    } else if (e.kind === "assistant_message" && e.stopReason !== "aborted" && e.text) {
      const userText = this.untitledFirstMessage.get(id);
      if (userText === undefined || !this.opts.generateTitle) return;
      this.untitledFirstMessage.delete(id);
      void this.applyTitle(id, userText, e.text);
    }
  }

  private async applyTitle(id: string, userText: string, assistantText: string): Promise<void> {
    try {
      const title = await this.opts.generateTitle!(userText, assistantText);
      const current = this.index.get(id);
      if (!current || current.titled) return;
      await this.index.update(id, { title, titled: true });
      this.opts.bus.emit({ type: "sessions_changed" });
    } catch (err) {
      this.opts.onError?.(err);
    }
  }
}
```

- [ ] **Step 4: 运行测试与类型检查**

Run: `npx vitest run tests/title.test.ts tests/session-manager.test.ts && npm run lint`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/core tests/title.test.ts tests/session-manager.test.ts
git commit -m "feat: web session index, titles and session manager

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 12: WebChat 协议

**Files:**
- Create: `src/protocol/messages.ts`
- Test: `tests/protocol.test.ts`

**Interfaces:**
- Consumes: `SessionEvent`、`HistoryItem`（Task 9）、`ApprovalRequest`（Task 9）、`WebSessionMeta`（Task 11）
- Produces:

```ts
export const ClientMessageSchema;   // TypeBox union，见下方实现
export type ClientMessage =
  | { type: "open"; sessionId: string }
  | { type: "send"; sessionId: string; text: string }
  | { type: "stop"; sessionId: string }
  | { type: "create_session" }
  | { type: "rename_session"; sessionId: string; title: string }
  | { type: "delete_session"; sessionId: string }
  | { type: "approve"; id: string; answer: "allow" | "allow_session" | "deny" }
  | { type: "get_config" }
  | { type: "save_config"; text: string };

export type ServerMessage =
  | { type: "sessions"; sessions: WebSessionMeta[] }
  | { type: "session_created"; session: WebSessionMeta }
  | { type: "history"; sessionId: string; items: HistoryItem[]; busy: boolean; streaming?: string }
  | { type: "event"; sessionId: string; event: SessionEvent }
  | { type: "approvals"; pending: ApprovalRequest[] }
  | { type: "config"; text: string }
  | { type: "config_saved"; ok: boolean; error?: string }
  | { type: "error"; message: string };

export function parseClientMessage(raw: string): ClientMessage | undefined;
```

- [ ] **Step 1: 写失败的测试**

`tests/protocol.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { parseClientMessage } from "../src/protocol/messages.js";

describe("parseClientMessage", () => {
  it("accepts every client message shape", () => {
    const valid = [
      { type: "open", sessionId: "s" },
      { type: "send", sessionId: "s", text: "你好" },
      { type: "stop", sessionId: "s" },
      { type: "create_session" },
      { type: "rename_session", sessionId: "s", title: "t" },
      { type: "delete_session", sessionId: "s" },
      { type: "approve", id: "a", answer: "allow_session" },
      { type: "get_config" },
      { type: "save_config", text: "model: {}" },
    ];
    for (const message of valid) expect(parseClientMessage(JSON.stringify(message))).toEqual(message);
  });

  it("rejects malformed input", () => {
    expect(parseClientMessage("not json")).toBeUndefined();
    expect(parseClientMessage(JSON.stringify({ type: "send", sessionId: "s", text: "" }))).toBeUndefined();
    expect(parseClientMessage(JSON.stringify({ type: "approve", id: "a", answer: "maybe" }))).toBeUndefined();
    expect(parseClientMessage(JSON.stringify({ type: "unknown" }))).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/protocol.test.ts`
Expected: FAIL，无法解析模块。

- [ ] **Step 3: 实现**

`src/protocol/messages.ts`：

```ts
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { HistoryItem, SessionEvent } from "../core/events.js";
import type { WebSessionMeta } from "../core/webSessions.js";
import type { ApprovalRequest } from "../policy/approvals.js";

const SessionId = Type.String({ minLength: 1, maxLength: 100 });

export const ClientMessageSchema = Type.Union([
  Type.Object({ type: Type.Literal("open"), sessionId: SessionId }),
  Type.Object({ type: Type.Literal("send"), sessionId: SessionId, text: Type.String({ minLength: 1, maxLength: 100_000 }) }),
  Type.Object({ type: Type.Literal("stop"), sessionId: SessionId }),
  Type.Object({ type: Type.Literal("create_session") }),
  Type.Object({
    type: Type.Literal("rename_session"),
    sessionId: SessionId,
    title: Type.String({ minLength: 1, maxLength: 100 }),
  }),
  Type.Object({ type: Type.Literal("delete_session"), sessionId: SessionId }),
  Type.Object({
    type: Type.Literal("approve"),
    id: Type.String({ minLength: 1 }),
    answer: Type.Union([Type.Literal("allow"), Type.Literal("allow_session"), Type.Literal("deny")]),
  }),
  Type.Object({ type: Type.Literal("get_config") }),
  Type.Object({ type: Type.Literal("save_config"), text: Type.String({ maxLength: 1_000_000 }) }),
]);

export type ClientMessage = Static<typeof ClientMessageSchema>;

export type ServerMessage =
  | { type: "sessions"; sessions: WebSessionMeta[] }
  | { type: "session_created"; session: WebSessionMeta }
  | { type: "history"; sessionId: string; items: HistoryItem[]; busy: boolean; streaming?: string }
  | { type: "event"; sessionId: string; event: SessionEvent }
  | { type: "approvals"; pending: ApprovalRequest[] }
  | { type: "config"; text: string }
  | { type: "config_saved"; ok: boolean; error?: string }
  | { type: "error"; message: string };

export function parseClientMessage(raw: string): ClientMessage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return Value.Check(ClientMessageSchema, value) ? value : undefined;
}
```

- [ ] **Step 4: 运行测试与类型检查**

Run: `npx vitest run tests/protocol.test.ts && npm run lint`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/protocol tests/protocol.test.ts
git commit -m "feat: webchat protocol schema

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: WebChat 前端

**Files:**
- Create: `src/web/static/index.html`, `src/web/static/login.html`, `src/web/static/app.js`, `src/web/static/style.css`

**Interfaces:**
- Consumes: Task 12 的协议（浏览器端以纯 JavaScript 实现同样的消息格式）；Task 14 提供的路由 `/`、`/login`、`/app.js`、`/style.css`、`POST /api/login`、`/ws`

功能（spec §5、§6.2、§7.3、§13）：
- 左侧会话列表：新建、点击切换、双击改名、删除（需确认）；记住上次打开的会话。
- 聊天区：逐字流式显示回复；显示工具调用中 / 成功 / 失败；被中断的回复标注“（已中断）”；错误提示；运行中显示“停止”按钮，运行中仍可发送（插话）。
- 输入框：Enter 发送，Shift+Enter 换行，输入法组字时 Enter 不发送。
- 审批卡片：显示来源窗口、工具名、参数摘要与自动拒绝时间；按钮“允许 / 本会话总是允许 / 拒绝”。
- 设置页：编辑 `config.yaml` 全文并保存，提示“保存后重启 vexd 生效”或显示校验错误。
- 断线自动重连（1 秒起，指数退避，最长 10 秒），重连后重新拉取当前会话。
- 跟随系统浅色 / 深色主题。

本任务没有自动化测试；Task 14 的测试会验证页面可被访问，Task 17 做人工验证。

- [ ] **Step 1: 写入 `src/web/static/index.html`**

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Vex</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <div id="app">
    <aside id="sidebar">
      <div class="sidebar-head">
        <span class="brand">Vex</span>
        <button id="new-session" type="button">新对话</button>
      </div>
      <ul id="session-list"></ul>
      <button id="open-settings" type="button" class="link">设置</button>
    </aside>
    <main id="main">
      <div id="status" hidden></div>
      <section id="approvals"></section>
      <section id="chat">
        <div id="messages"></div>
        <form id="composer">
          <textarea id="input" rows="1" placeholder="说点什么…（Enter 发送，Shift+Enter 换行）"></textarea>
          <button id="stop" type="button" class="secondary" hidden>停止</button>
          <button id="send" type="submit">发送</button>
        </form>
      </section>
      <section id="settings" hidden>
        <div class="settings-head">
          <h2>设置</h2>
          <button id="close-settings" type="button" class="link">返回</button>
        </div>
        <p class="hint">编辑 config.yaml，保存后重启 vexd 生效。</p>
        <textarea id="config-text" spellcheck="false"></textarea>
        <div class="settings-actions">
          <button id="save-config" type="button">保存</button>
          <span id="config-result"></span>
        </div>
      </section>
    </main>
  </div>
  <script type="module" src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: 写入 `src/web/static/login.html`**

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Vex · 登录</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body class="login-page">
  <form id="login">
    <h1>Vex</h1>
    <input id="token" type="password" autocomplete="current-password" placeholder="访问口令" required>
    <button type="submit">进入</button>
    <p id="login-error" hidden>口令不正确</p>
  </form>
  <script>
    document.getElementById("login").addEventListener("submit", async (event) => {
      event.preventDefault();
      const token = document.getElementById("token").value;
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (res.ok) location.href = "/";
      else document.getElementById("login-error").hidden = false;
    });
  </script>
</body>
</html>
```

`/login` 与 `/style.css` 无需登录即可访问（Task 14），其余页面与 `/ws` 需要登录。

- [ ] **Step 3: 写入 `src/web/static/app.js`**

```js
const $ = (id) => document.getElementById(id);

const state = {
  ws: null,
  retryMs: 1000,
  sessions: [],
  currentId: null,
  creating: false,
  busy: false,
  pending: [],
  streamEl: null,
  toolEls: new Map(),
};

function send(message) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(message));
}

function connect() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  state.ws = ws;
  ws.addEventListener("open", () => {
    state.retryMs = 1000;
    setStatus("");
    if (state.currentId) send({ type: "open", sessionId: state.currentId });
  });
  ws.addEventListener("message", (event) => handle(JSON.parse(event.data)));
  ws.addEventListener("close", () => {
    setStatus("连接已断开，正在重连…");
    setTimeout(connect, state.retryMs);
    state.retryMs = Math.min(state.retryMs * 2, 10000);
  });
}

function handle(msg) {
  switch (msg.type) {
    case "sessions":
      state.sessions = msg.sessions;
      renderSessions();
      ensureCurrentSession();
      break;
    case "session_created":
      state.creating = false;
      selectSession(msg.session.id);
      break;
    case "history":
      if (msg.sessionId === state.currentId) renderHistory(msg);
      break;
    case "event":
      if (msg.sessionId === state.currentId) applyEvent(msg.event);
      break;
    case "approvals":
      state.pending = msg.pending;
      renderApprovals();
      break;
    case "config":
      $("config-text").value = msg.text;
      break;
    case "config_saved":
      $("config-result").textContent = msg.ok ? "已保存，重启 vexd 后生效" : msg.error;
      $("config-result").className = msg.ok ? "ok" : "bad";
      break;
    case "error":
      flash(msg.message);
      break;
  }
}

function ensureCurrentSession() {
  if (state.currentId && state.sessions.some((s) => s.id === state.currentId)) return;
  const remembered = readRemembered();
  const target = state.sessions.find((s) => s.id === remembered) ?? state.sessions[0];
  if (target) selectSession(target.id);
  else createSession();
}

function createSession() {
  if (state.creating) return;
  state.creating = true;
  send({ type: "create_session" });
}

function selectSession(id) {
  state.currentId = id;
  remember(id);
  clearMessages();
  renderSessions();
  showChat();
  send({ type: "open", sessionId: id });
}

function renderSessions() {
  const list = $("session-list");
  list.replaceChildren();
  for (const session of state.sessions) {
    const li = document.createElement("li");
    li.className = session.id === state.currentId ? "active" : "";
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = session.title;
    title.title = "双击改名";
    title.addEventListener("click", () => selectSession(session.id));
    title.addEventListener("dblclick", () => {
      const next = prompt("会话名称", session.title);
      if (next && next.trim()) send({ type: "rename_session", sessionId: session.id, title: next.trim() });
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon";
    remove.textContent = "×";
    remove.title = "删除";
    remove.addEventListener("click", () => {
      if (confirm(`删除「${session.title}」？`)) send({ type: "delete_session", sessionId: session.id });
    });
    li.append(title, remove);
    list.append(li);
  }
}

function clearMessages() {
  $("messages").replaceChildren();
  state.streamEl = null;
  state.toolEls.clear();
  setBusy(false);
}

function renderHistory(msg) {
  clearMessages();
  for (const item of msg.items) {
    if (item.kind === "user") addBubble("user", item.text);
    else if (item.kind === "assistant") addBubble("assistant", item.text, item.stopReason === "aborted");
    else addTool(item.toolCallId, item.toolName, item.summary, item.isError === undefined ? "running" : item.isError ? "error" : "done");
  }
  if (msg.streaming !== undefined) state.streamEl = addBubble("assistant streaming", msg.streaming);
  setBusy(msg.busy);
}

function applyEvent(event) {
  switch (event.kind) {
    case "user_message":
      addBubble("user", event.text);
      break;
    case "text_delta":
      if (!state.streamEl) state.streamEl = addBubble("assistant streaming", "");
      state.streamEl.firstChild.textContent += event.delta;
      scrollToBottom();
      break;
    case "assistant_message":
      if (state.streamEl) {
        state.streamEl.remove();
        state.streamEl = null;
      }
      addBubble("assistant", event.text, event.stopReason === "aborted");
      break;
    case "tool_start":
      addTool(event.toolCallId, event.toolName, event.summary, "running");
      break;
    case "tool_end":
      updateTool(event.toolCallId, event.isError ? "error" : "done");
      break;
    case "busy":
      setBusy(event.busy);
      if (!event.busy && state.streamEl) {
        state.streamEl.classList.remove("streaming");
        state.streamEl = null;
      }
      break;
    case "error":
      addNotice(event.message);
      break;
  }
}

function addBubble(kind, text, aborted = false) {
  const el = document.createElement("div");
  el.className = `bubble ${kind}`;
  const body = document.createElement("div");
  body.className = "text";
  body.textContent = text;
  el.append(body);
  if (aborted) {
    const tag = document.createElement("div");
    tag.className = "tag";
    tag.textContent = "（已中断）";
    el.append(tag);
  }
  $("messages").append(el);
  scrollToBottom();
  return el;
}

const TOOL_ICONS = { running: "⋯", done: "✓", error: "✗" };

function addTool(id, name, summary, status) {
  const el = document.createElement("div");
  el.className = `tool ${status}`;
  el.dataset.label = `${name}：${summary}`;
  el.textContent = `${TOOL_ICONS[status]} ${el.dataset.label}`;
  $("messages").append(el);
  state.toolEls.set(id, el);
  scrollToBottom();
}

function updateTool(id, status) {
  const el = state.toolEls.get(id);
  if (!el) return;
  el.className = `tool ${status}`;
  el.textContent = `${TOOL_ICONS[status]} ${el.dataset.label}`;
}

function addNotice(text) {
  const el = document.createElement("div");
  el.className = "notice";
  el.textContent = text;
  $("messages").append(el);
  scrollToBottom();
}

function setBusy(busy) {
  state.busy = busy;
  $("stop").hidden = !busy;
}

function renderApprovals() {
  const box = $("approvals");
  box.replaceChildren();
  for (const request of state.pending) {
    const card = document.createElement("div");
    card.className = "approval";
    const head = document.createElement("div");
    head.className = "approval-head";
    const deadline = new Date(request.expiresAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    head.textContent = `${request.windowLabel} 请求执行 ${request.toolName}（${deadline} 前未答复将自动拒绝）`;
    const summary = document.createElement("pre");
    summary.textContent = request.summary;
    const actions = document.createElement("div");
    actions.className = "approval-actions";
    for (const [answer, label, cls] of [
      ["allow", "允许", ""],
      ["allow_session", "本会话总是允许", "secondary"],
      ["deny", "拒绝", "danger"],
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.className = cls;
      button.addEventListener("click", () => send({ type: "approve", id: request.id, answer }));
      actions.append(button);
    }
    card.append(head, summary, actions);
    box.append(card);
  }
}

function showChat() {
  $("settings").hidden = true;
  $("chat").hidden = false;
}

function showSettings() {
  $("chat").hidden = true;
  $("settings").hidden = false;
  $("config-result").textContent = "";
  send({ type: "get_config" });
}

function setStatus(text) {
  $("status").textContent = text;
  $("status").hidden = !text;
}

let flashTimer;
function flash(text) {
  setStatus(text);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => setStatus(""), 4000);
}

function scrollToBottom() {
  const box = $("messages");
  box.scrollTop = box.scrollHeight;
}

function remember(id) {
  try {
    localStorage.setItem("vex.session", id);
  } catch {
    // Storage can be unavailable in private windows.
  }
}

function readRemembered() {
  try {
    return localStorage.getItem("vex.session");
  } catch {
    return null;
  }
}

function autoGrow() {
  const input = $("input");
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
}

$("composer").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("input");
  const text = input.value.trim();
  if (!text || !state.currentId) return;
  send({ type: "send", sessionId: state.currentId, text });
  input.value = "";
  autoGrow();
});

$("input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $("composer").requestSubmit();
  }
});
$("input").addEventListener("input", autoGrow);
$("stop").addEventListener("click", () => {
  if (state.currentId) send({ type: "stop", sessionId: state.currentId });
});
$("new-session").addEventListener("click", createSession);
$("open-settings").addEventListener("click", showSettings);
$("close-settings").addEventListener("click", showChat);
$("save-config").addEventListener("click", () => {
  $("config-result").textContent = "保存中…";
  $("config-result").className = "";
  send({ type: "save_config", text: $("config-text").value });
});

connect();
```

- [ ] **Step 4: 写入 `src/web/static/style.css`**

```css
:root {
  --bg: #f7f7f5;
  --panel: #ffffff;
  --border: #e4e4e0;
  --text: #1d1d1b;
  --muted: #74746f;
  --accent: #2f6f5e;
  --accent-text: #ffffff;
  --user: #e6f0ec;
  --danger: #b4423a;
  --warn-bg: #fff6e0;
  --warn-border: #e8c76a;
  color-scheme: light;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #161615;
    --panel: #1f1f1d;
    --border: #33332f;
    --text: #ecece8;
    --muted: #9a9a94;
    --accent: #5fae97;
    --accent-text: #0f1f1a;
    --user: #233530;
    --danger: #e0756c;
    --warn-bg: #2e2716;
    --warn-border: #7a6526;
    color-scheme: dark;
  }
}

* { box-sizing: border-box; }

body {
  margin: 0;
  font: 15px/1.6 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  background: var(--bg);
  color: var(--text);
}

button {
  font: inherit;
  border: 0;
  border-radius: 8px;
  padding: 6px 14px;
  background: var(--accent);
  color: var(--accent-text);
  cursor: pointer;
}
button.secondary { background: transparent; color: var(--accent); border: 1px solid var(--accent); }
button.danger { background: var(--danger); color: #fff; }
button.link { background: none; color: var(--muted); padding: 4px 0; }
button.icon { background: none; color: var(--muted); padding: 0 6px; font-size: 18px; line-height: 1; }

#app { display: flex; height: 100vh; }

#sidebar {
  width: 240px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px 12px;
  border-right: 1px solid var(--border);
  background: var(--panel);
}
.sidebar-head { display: flex; align-items: center; justify-content: space-between; }
.brand { font-weight: 700; font-size: 18px; letter-spacing: 0.04em; }
#session-list { list-style: none; margin: 0; padding: 0; overflow-y: auto; flex: 1; }
#session-list li { display: flex; align-items: center; border-radius: 8px; }
#session-list li.active { background: var(--user); }
#session-list .title {
  flex: 1;
  padding: 8px 10px;
  cursor: pointer;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
#session-list li .icon { visibility: hidden; }
#session-list li:hover .icon { visibility: visible; }

#main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
#status { padding: 6px 16px; background: var(--warn-bg); border-bottom: 1px solid var(--warn-border); font-size: 13px; }

#approvals { display: flex; flex-direction: column; gap: 8px; padding: 0 16px; }
#approvals:not(:empty) { padding-top: 12px; }
.approval { border: 1px solid var(--warn-border); background: var(--warn-bg); border-radius: 10px; padding: 10px 12px; }
.approval-head { font-weight: 600; }
.approval pre {
  margin: 6px 0 8px;
  padding: 6px 8px;
  background: var(--panel);
  border-radius: 6px;
  white-space: pre-wrap;
  word-break: break-all;
  font-size: 13px;
}
.approval-actions { display: flex; gap: 8px; flex-wrap: wrap; }

#chat { flex: 1; display: flex; flex-direction: column; min-height: 0; }
#chat[hidden], #settings[hidden] { display: none; }
#messages { flex: 1; overflow-y: auto; padding: 20px 16px; display: flex; flex-direction: column; gap: 10px; }

.bubble { max-width: min(760px, 85%); padding: 8px 12px; border-radius: 12px; }
.bubble .text { white-space: pre-wrap; word-break: break-word; }
.bubble.user { align-self: flex-end; background: var(--user); }
.bubble.assistant { align-self: flex-start; background: var(--panel); border: 1px solid var(--border); }
.bubble.streaming .text::after { content: "▍"; color: var(--muted); }
.bubble .tag { color: var(--muted); font-size: 12px; }
.tool { align-self: flex-start; font-size: 13px; color: var(--muted); font-family: ui-monospace, monospace; }
.tool.error { color: var(--danger); }
.notice { align-self: center; font-size: 13px; color: var(--danger); }

#composer { display: flex; gap: 8px; align-items: flex-end; padding: 12px 16px 16px; border-top: 1px solid var(--border); }
#input {
  flex: 1;
  resize: none;
  font: inherit;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel);
  color: var(--text);
  max-height: 200px;
}

#settings { flex: 1; display: flex; flex-direction: column; gap: 8px; padding: 16px; min-height: 0; }
.settings-head { display: flex; align-items: center; justify-content: space-between; }
.settings-head h2 { margin: 0; font-size: 18px; }
.hint { margin: 0; color: var(--muted); font-size: 13px; }
#config-text {
  flex: 1;
  font: 13px/1.5 ui-monospace, monospace;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel);
  color: var(--text);
  resize: none;
}
.settings-actions { display: flex; gap: 12px; align-items: center; }
#config-result.ok { color: var(--accent); }
#config-result.bad { color: var(--danger); white-space: pre-wrap; }

.login-page { display: grid; place-items: center; height: 100vh; }
#login { display: flex; flex-direction: column; gap: 10px; width: 260px; }
#login h1 { margin: 0 0 6px; text-align: center; }
#login input {
  font: inherit;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
  color: var(--text);
}
#login-error { margin: 0; color: var(--danger); text-align: center; }

@media (max-width: 640px) {
  #sidebar { width: 168px; padding: 12px 8px; }
}
```

- [ ] **Step 5: 提交**

```bash
git add src/web/static
git commit -m "feat: webchat frontend

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 14: Gateway（HTTP + WebSocket + 口令）

**Files:**
- Create: `src/gateway/auth.ts`, `src/gateway/server.ts`, `tests/helpers/client.ts`
- Test: `tests/auth.test.ts`, `tests/gateway.test.ts`

**Interfaces:**
- Consumes: `ConfigError`、`saveConfigText`（Task 2）、`EventBus`、`VexEvent`（Task 9）、`ApprovalManager`（Task 9）、`SessionManager`、`webSessionKey`（Task 11）、`parseClientMessage`、`ClientMessage`、`ServerMessage`（Task 12）、前端静态文件（Task 13）
- Produces（`src/gateway/auth.ts`）：
  - `COOKIE_NAME = "vex_auth"`
  - `isLoopback(host: string): boolean`
  - `parseCookies(header: string | undefined): Record<string, string>`
  - `class WebAuth { constructor(token: string | undefined); get required(): boolean; checkToken(candidate: string): boolean; isAuthorized(cookieHeader: string | undefined): boolean; setCookieHeader(): string }`
- Produces（`src/gateway/server.ts`）：
  - `interface GatewayOptions { host: string; port: number; auth: WebAuth; sessions: SessionManager; approvals: ApprovalManager; bus: EventBus; config: { read: () => Promise<string>; save: (text: string) => Promise<void> }; staticDir: string; log: Logger; loginDelayMs?: number }`
  - `class Gateway { constructor(opts: GatewayOptions); start(): Promise<{ port: number }>; stop(): Promise<void> }`
- Produces（`tests/helpers/client.ts`）：`class TestClient { static connect(url: string, options?: { cookie?: string; origin?: string }): Promise<TestClient>; messages: ServerMessage[]; send(message: ClientMessage): void; waitFor(predicate: (m: ServerMessage) => boolean): Promise<ServerMessage>; close(): void }`

路由：

| 路径 | 是否需要登录 | 说明 |
|---|---|---|
| `GET /login` | 否 | 登录页 |
| `GET /style.css` | 否 | 样式 |
| `POST /api/login` | 否 | `{ token }`，正确返回 204 并设置 cookie，错误等待 1 秒后返回 401 |
| `GET /`、`GET /app.js` | 是 | 未登录访问 `/` 重定向到 `/login`，其余返回 401 |
| `GET /ws`（WebSocket 升级） | 是 | 还要求 `Origin` 缺省或与 `Host` 一致，防止其他网站连接本机 WebSocket |

未设置 `web.token` 时视为无需登录（只允许在本机地址上这样运行，由 Task 15 检查）。cookie 值为 `HMAC-SHA256(token, "vex-web-auth")`，属性 `HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`。

连接建立后服务端先推送 `sessions` 与 `approvals`；之后转发 `web:` 会话的事件、会话列表变化与审批列表变化。

- [ ] **Step 1: 写测试辅助与失败的测试**

`tests/helpers/client.ts`：

```ts
import { vi } from "vitest";
import WebSocket from "ws";
import type { ClientMessage, ServerMessage } from "../../src/protocol/messages.js";

export class TestClient {
  readonly messages: ServerMessage[] = [];

  private constructor(private readonly ws: WebSocket) {
    ws.on("message", (data) => this.messages.push(JSON.parse(data.toString()) as ServerMessage));
  }

  static connect(url: string, options: { cookie?: string; origin?: string } = {}): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (options.cookie) headers.Cookie = options.cookie;
      const ws = new WebSocket(url, { headers, origin: options.origin });
      const client = new TestClient(ws);
      ws.once("open", () => resolve(client));
      ws.once("error", reject);
    });
  }

  send(message: ClientMessage): void {
    this.ws.send(JSON.stringify(message));
  }

  waitFor(predicate: (m: ServerMessage) => boolean): Promise<ServerMessage> {
    return vi.waitFor(
      () => {
        const found = this.messages.find(predicate);
        if (!found) throw new Error("message not received yet");
        return found;
      },
      { timeout: 5000, interval: 10 },
    );
  }

  close(): void {
    this.ws.close();
  }
}
```

`tests/auth.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { COOKIE_NAME, isLoopback, parseCookies, WebAuth } from "../src/gateway/auth.js";

describe("isLoopback", () => {
  it("recognizes local addresses", () => {
    expect(["127.0.0.1", "127.0.0.2", "::1", "localhost"].every(isLoopback)).toBe(true);
    expect(["0.0.0.0", "192.168.1.2", "::"].some(isLoopback)).toBe(false);
  });
});

describe("parseCookies", () => {
  it("parses pairs and tolerates bad encoding", () => {
    expect(parseCookies("a=1; b=x%20y; bad=%E0%A4%A; flag")).toEqual({ a: "1", b: "x y", bad: "%E0%A4%A" });
    expect(parseCookies(undefined)).toEqual({});
  });
});

describe("WebAuth", () => {
  it("requires nothing without a token", () => {
    const auth = new WebAuth(undefined);
    expect(auth.required).toBe(false);
    expect(auth.isAuthorized(undefined)).toBe(true);
  });

  it("checks the token and the cookie it issues", () => {
    const auth = new WebAuth("secret");
    expect(auth.required).toBe(true);
    expect(auth.checkToken("secret")).toBe(true);
    expect(auth.checkToken("Secret")).toBe(false);
    const header = auth.setCookieHeader();
    expect(header).toMatch(new RegExp(`^${COOKIE_NAME}=[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000$`));
    const cookie = header.split(";")[0]!;
    expect(auth.isAuthorized(cookie)).toBe(true);
    expect(auth.isAuthorized(`${COOKIE_NAME}=forged`)).toBe(false);
    expect(new WebAuth("other").isAuthorized(cookie)).toBe(false);
  });
});
```

`tests/gateway.test.ts`：

```ts
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall, type FauxProviderHandle, type FauxResponseStep } from "@earendil-works/pi-ai";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveConfigText } from "../src/config/load.js";
import { EventBus } from "../src/core/events.js";
import { Session } from "../src/core/session.js";
import { SessionManager } from "../src/core/sessionManager.js";
import { WebAuth } from "../src/gateway/auth.js";
import { Gateway } from "../src/gateway/server.js";
import { resolvePaths, type VexPaths } from "../src/paths.js";
import { ApprovalManager } from "../src/policy/approvals.js";
import { createToolGate } from "../src/policy/gate.js";
import { ToolPolicy } from "../src/policy/policy.js";
import type { ServerMessage } from "../src/protocol/messages.js";
import { createCoreTools } from "../src/tools/registry.js";
import { TestClient } from "./helpers/client.js";
import { createFaux, fauxStreamFn } from "./helpers/faux.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

const staticDir = fileURLToPath(new URL("../src/web/static/", import.meta.url));

let dir: string;
let paths: VexPaths;
let faux: FauxProviderHandle;
let gateway: Gateway | undefined;
let sessions: SessionManager | undefined;
let clients: TestClient[];

beforeEach(async () => {
  dir = await makeTmpDir();
  paths = resolvePaths(dir);
  clients = [];
});
afterEach(async () => {
  for (const c of clients) c.close();
  await sessions?.shutdown();
  await gateway?.stop();
  gateway = undefined;
  sessions = undefined;
  await removeTmpDir(dir);
});

async function start(opts: { token?: string; responses?: FauxResponseStep[] } = {}): Promise<string> {
  faux = createFaux();
  faux.setResponses(opts.responses ?? []);
  const bus = new EventBus();
  const approvals = new ApprovalManager({ onChange: () => bus.emit({ type: "approvals_changed" }) });
  const policy = new ToolPolicy({ workspace: dir, overrides: {} });
  const tools = createCoreTools({ workspace: dir, bashEnvPassthrough: [] });
  sessions = new SessionManager({
    paths,
    bus,
    openSession: (key, transcriptPath, windowLabel) =>
      Session.open({
        key,
        transcriptPath,
        model: faux.getModel(),
        tools,
        streamFn: fauxStreamFn(faux),
        getApiKey: () => "k",
        buildSystemPrompt: async () => "SYSTEM",
        beforeToolCall: createToolGate({ policy, approvals, sessionKey: key, windowLabel }),
        emit: (event) => bus.emit({ type: "session", sessionKey: key, event }),
      }),
  });
  await sessions.init();
  gateway = new Gateway({
    host: "127.0.0.1",
    port: 0,
    auth: new WebAuth(opts.token),
    sessions,
    approvals,
    bus,
    config: { read: () => readFile(paths.config, "utf8"), save: (text) => saveConfigText(paths, text) },
    staticDir,
    log: pino({ level: "silent" }),
    loginDelayMs: 10,
  });
  const { port } = await gateway.start();
  return `127.0.0.1:${port}`;
}

async function connect(host: string, options: { cookie?: string; origin?: string } = {}): Promise<TestClient> {
  const client = await TestClient.connect(`ws://${host}/ws`, options);
  clients.push(client);
  return client;
}

const isType = <T extends ServerMessage["type"]>(type: T) => (m: ServerMessage): m is Extract<ServerMessage, { type: T }> => m.type === type;

describe("Gateway HTTP", () => {
  it("serves the app without a token", async () => {
    const host = await start();
    const res = await fetch(`http://${host}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>Vex</title>");
    expect((await fetch(`http://${host}/app.js`)).headers.get("content-type")).toContain("javascript");
    expect((await fetch(`http://${host}/nope`)).status).toBe(404);
  });

  it("guards pages and the socket with the token", async () => {
    const host = await start({ token: "secret" });
    const redirect = await fetch(`http://${host}/`, { redirect: "manual" });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("/login");
    expect((await fetch(`http://${host}/login`)).status).toBe(200);
    expect((await fetch(`http://${host}/style.css`)).status).toBe(200);
    expect((await fetch(`http://${host}/app.js`)).status).toBe(401);

    const wrong = await fetch(`http://${host}/api/login`, { method: "POST", body: JSON.stringify({ token: "nope" }) });
    expect(wrong.status).toBe(401);
    const right = await fetch(`http://${host}/api/login`, { method: "POST", body: JSON.stringify({ token: "secret" }) });
    expect(right.status).toBe(204);
    const cookie = right.headers.get("set-cookie")!.split(";")[0]!;

    expect((await fetch(`http://${host}/`, { headers: { cookie } })).status).toBe(200);
    await expect(connect(host)).rejects.toThrow();
    const client = await connect(host, { cookie });
    await client.waitFor(isType("sessions"));
  });

  it("rejects cross-origin sockets", async () => {
    const host = await start();
    await expect(connect(host, { origin: "http://evil.example" })).rejects.toThrow();
    const client = await connect(host, { origin: `http://${host}` });
    await client.waitFor(isType("sessions"));
  });
});

describe("Gateway chat", () => {
  it("creates a session and streams a conversation", async () => {
    const host = await start({ responses: [fauxAssistantMessage("你好呀")] });
    const client = await connect(host);
    await client.waitFor(isType("sessions"));
    await client.waitFor(isType("approvals"));

    client.send({ type: "create_session" });
    const created = await client.waitFor(isType("session_created"));
    if (created.type !== "session_created") throw new Error("unreachable");
    const sessionId = created.session.id;

    client.send({ type: "open", sessionId });
    await client.waitFor((m) => m.type === "history" && m.sessionId === sessionId && m.items.length === 0 && !m.busy);

    client.send({ type: "send", sessionId, text: "你好" });
    await client.waitFor((m) => m.type === "event" && m.event.kind === "user_message" && m.event.text === "你好");
    await client.waitFor((m) => m.type === "event" && m.event.kind === "text_delta");
    await client.waitFor((m) => m.type === "event" && m.event.kind === "assistant_message" && m.event.text === "你好呀");
    await client.waitFor((m) => m.type === "event" && m.event.kind === "busy" && !m.event.busy);

    const other = await connect(host);
    other.send({ type: "open", sessionId });
    await other.waitFor((m) => m.type === "history" && m.items.map((i) => i.kind).join(",") === "user,assistant");
  });

  it("routes approvals through the socket", async () => {
    const host = await start({
      responses: [
        fauxAssistantMessage(fauxToolCall("bash", { command: "echo hi" }, { id: "c1" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("跑完了"),
      ],
    });
    const client = await connect(host);
    client.send({ type: "create_session" });
    const created = await client.waitFor(isType("session_created"));
    if (created.type !== "session_created") throw new Error("unreachable");
    client.send({ type: "send", sessionId: created.session.id, text: "跑一下" });

    const asked = await client.waitFor((m) => m.type === "approvals" && m.pending.length === 1);
    if (asked.type !== "approvals") throw new Error("unreachable");
    expect(asked.pending[0]).toMatchObject({ toolName: "bash", summary: "echo hi", windowLabel: "网页会话「新对话」" });

    client.send({ type: "approve", id: asked.pending[0]!.id, answer: "allow" });
    await client.waitFor((m) => m.type === "event" && m.event.kind === "tool_end" && !m.event.isError);
    await client.waitFor((m) => m.type === "event" && m.event.kind === "assistant_message" && m.event.text === "跑完了");
    expect(client.messages.filter(isType("approvals")).at(-1)?.pending).toEqual([]);
  });

  it("reads and validates the config", async () => {
    const host = await start();
    await writeFile(paths.config, "model: { provider: deepseek, id: deepseek-v4-pro }\n", "utf8");
    const client = await connect(host);
    client.send({ type: "get_config" });
    await client.waitFor((m) => m.type === "config" && m.text.includes("deepseek-v4-pro"));

    client.send({ type: "save_config", text: "model: 1\n" });
    await client.waitFor((m) => m.type === "config_saved" && !m.ok && /校验失败/.test(m.error ?? ""));

    client.send({ type: "save_config", text: "model: { provider: deepseek, id: deepseek-flash }\n" });
    await client.waitFor((m) => m.type === "config_saved" && m.ok);
    expect(await readFile(paths.config, "utf8")).toContain("deepseek-flash");
  });

  it("reports bad requests", async () => {
    const host = await start();
    const client = await connect(host);
    client.send({ type: "open", sessionId: "missing" });
    await client.waitFor((m) => m.type === "error" && m.message.includes("没有这个会话"));
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/auth.test.ts tests/gateway.test.ts`
Expected: FAIL，无法解析 `../src/gateway/*.js`。

- [ ] **Step 3: 实现**

`src/gateway/auth.ts`：

```ts
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const COOKIE_NAME = "vex_auth";

export function isLoopback(host: string): boolean {
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }
  return cookies;
}

export class WebAuth {
  constructor(private readonly token: string | undefined) {}

  get required(): boolean {
    return this.token !== undefined;
  }

  checkToken(candidate: string): boolean {
    return this.token === undefined || safeEqual(candidate, this.token);
  }

  isAuthorized(cookieHeader: string | undefined): boolean {
    if (this.token === undefined) return true;
    const value = parseCookies(cookieHeader)[COOKIE_NAME];
    return value !== undefined && safeEqual(value, this.cookieValue());
  }

  setCookieHeader(): string {
    return `${COOKIE_NAME}=${this.cookieValue()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`;
  }

  private cookieValue(): string {
    return createHmac("sha256", this.token ?? "").update("vex-web-auth").digest("hex");
  }
}

function safeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}
```

`src/gateway/server.ts`：

```ts
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "pino";
import { WebSocket, WebSocketServer } from "ws";
import { ConfigError } from "../config/load.js";
import type { EventBus, VexEvent } from "../core/events.js";
import { webSessionKey, type SessionManager } from "../core/sessionManager.js";
import type { ApprovalManager } from "../policy/approvals.js";
import { parseClientMessage, type ClientMessage, type ServerMessage } from "../protocol/messages.js";
import type { WebAuth } from "./auth.js";

export interface GatewayOptions {
  host: string;
  port: number;
  auth: WebAuth;
  sessions: SessionManager;
  approvals: ApprovalManager;
  bus: EventBus;
  config: { read: () => Promise<string>; save: (text: string) => Promise<void> };
  staticDir: string;
  log: Logger;
  loginDelayMs?: number;
}

interface StaticEntry {
  file: string;
  type: string;
  public: boolean;
}

const STATIC_FILES: Record<string, StaticEntry> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8", public: false },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8", public: false },
  "/login": { file: "login.html", type: "text/html; charset=utf-8", public: true },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8", public: true },
};

const WEB_PREFIX = "web:";

export class Gateway {
  private server: Server | undefined;
  private wss: WebSocketServer | undefined;
  private readonly clients = new Set<WebSocket>();
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly opts: GatewayOptions) {}

  async start(): Promise<{ port: number }> {
    const wss = new WebSocketServer({ noServer: true });
    const server = createServer((req, res) => {
      this.handleHttp(req, res).catch((err: unknown) => {
        this.opts.log.error({ err }, "http request failed");
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    server.on("upgrade", (req, socket, head) => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (path !== "/ws" || !this.isSameOrigin(req) || !this.opts.auth.isAuthorized(req.headers.cookie)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
    });
    this.unsubscribe = this.opts.bus.on((event) => this.onBusEvent(event));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.opts.port, this.opts.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
    this.wss = wss;
    const address = server.address();
    return { port: typeof address === "object" && address ? address.port : this.opts.port };
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    for (const ws of this.clients) ws.terminate();
    this.wss?.close();
    const server = this.server;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    this.server = undefined;
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (req.method === "POST" && path === "/api/login") {
      await this.handleLogin(req, res);
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405).end();
      return;
    }
    const entry = STATIC_FILES[path];
    if (!entry) {
      res.writeHead(404).end();
      return;
    }
    if (!entry.public && !this.opts.auth.isAuthorized(req.headers.cookie)) {
      if (path === "/") res.writeHead(302, { Location: "/login" }).end();
      else res.writeHead(401).end();
      return;
    }
    const body = await readFile(join(this.opts.staticDir, entry.file));
    res.writeHead(200, { "Content-Type": entry.type, "Cache-Control": "no-cache" }).end(body);
  }

  private async handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let token = "";
    try {
      const parsed: unknown = JSON.parse(await readBody(req, 4096));
      if (parsed && typeof parsed === "object" && typeof (parsed as { token?: unknown }).token === "string") {
        token = (parsed as { token: string }).token;
      }
    } catch {
      // A malformed body is treated as an empty token.
    }
    if (!this.opts.auth.checkToken(token)) {
      await delay(this.opts.loginDelayMs ?? 1000);
      res.writeHead(401).end();
      return;
    }
    const headers = this.opts.auth.required ? { "Set-Cookie": this.opts.auth.setCookieHeader() } : undefined;
    res.writeHead(204, headers).end();
  }

  private isSameOrigin(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  private onConnection(ws: WebSocket): void {
    this.clients.add(ws);
    ws.on("close", () => this.clients.delete(ws));
    ws.on("message", (data) => {
      void this.onClientMessage(ws, data.toString());
    });
    send(ws, { type: "sessions", sessions: this.opts.sessions.listWeb() });
    send(ws, { type: "approvals", pending: this.opts.approvals.pending() });
  }

  private async onClientMessage(ws: WebSocket, raw: string): Promise<void> {
    const message = parseClientMessage(raw);
    if (!message) {
      send(ws, { type: "error", message: "无法识别的请求" });
      return;
    }
    try {
      await this.handle(ws, message);
    } catch (err) {
      send(ws, { type: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  private async handle(ws: WebSocket, message: ClientMessage): Promise<void> {
    const { sessions } = this.opts;
    switch (message.type) {
      case "open": {
        const session = await sessions.get(webSessionKey(message.sessionId));
        const { items, streaming } = session.history();
        send(ws, { type: "history", sessionId: message.sessionId, items, busy: session.busy, streaming });
        return;
      }
      case "send":
        (await sessions.get(webSessionKey(message.sessionId))).send(message.text);
        return;
      case "stop":
        (await sessions.get(webSessionKey(message.sessionId))).stop();
        return;
      case "create_session":
        send(ws, { type: "session_created", session: await sessions.createWeb() });
        return;
      case "rename_session":
        await sessions.renameWeb(message.sessionId, message.title);
        return;
      case "delete_session":
        await sessions.deleteWeb(message.sessionId);
        return;
      case "approve":
        this.opts.approvals.answer(message.id, message.answer);
        return;
      case "get_config":
        send(ws, { type: "config", text: await this.opts.config.read() });
        return;
      case "save_config":
        try {
          await this.opts.config.save(message.text);
          send(ws, { type: "config_saved", ok: true });
        } catch (err) {
          if (!(err instanceof ConfigError)) throw err;
          send(ws, { type: "config_saved", ok: false, error: err.message });
        }
        return;
    }
  }

  private onBusEvent(event: VexEvent): void {
    if (event.type === "session") {
      if (!event.sessionKey.startsWith(WEB_PREFIX)) return;
      this.broadcast({ type: "event", sessionId: event.sessionKey.slice(WEB_PREFIX.length), event: event.event });
    } else if (event.type === "sessions_changed") {
      this.broadcast({ type: "sessions", sessions: this.opts.sessions.listWeb() });
    } else {
      this.broadcast({ type: "approvals", pending: this.opts.approvals.pending() });
    }
  }

  private broadcast(message: ServerMessage): void {
    for (const ws of this.clients) send(ws, message);
  }
}

function send(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
```

- [ ] **Step 4: 运行测试与类型检查**

Run: `npx vitest run tests/auth.test.ts tests/gateway.test.ts && npm run lint`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/gateway tests/helpers/client.ts tests/auth.test.ts tests/gateway.test.ts
git commit -m "feat: http and websocket gateway with token auth

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 15: 日志与守护进程组装

**Files:**
- Create: `src/logger.ts`, `src/daemon.ts`
- Test: `tests/daemon.test.ts`

**Interfaces:**
- Consumes: Task 1–14 的全部组件
- Produces:
  - `createLogger(opts?: { file?: string; stdout?: boolean }): Logger`（都未指定时返回静默日志）
  - `interface DaemonOptions { paths: VexPaths; config: VexConfig; log: Logger; models?: ModelRegistry; staticDir?: string }`
  - `interface Daemon { url: string; port: number; stop(): Promise<void> }`
  - `startDaemon(opts: DaemonOptions): Promise<Daemon>`

组装顺序（spec §3、§6.3、§15）：
1. `web.host` 非本机地址且未设置 `web.token` 时拒绝启动（`ConfigError`）。
2. 创建工作区模板；解析主模型与后台模型（解析失败直接抛出）。
3. system prompt 分节：基础指令 → `SOUL.md`（200 行）→ `USER.md`（200 行）→ `MEMORY.md`（100 行）→ 当前时间与窗口。
4. 工具 = 核心工具经 `ToolPolicy.filter` 去掉被禁用的；每个会话的 `beforeToolCall` 由 `createToolGate` 生成。
5. WebChat 会话标题使用后台模型生成。
6. 关闭顺序：中断所有会话 → 拒绝所有挂起审批 → 关闭 HTTP 服务；单步失败记录日志后继续下一步。

- [ ] **Step 1: 写失败的测试**

`tests/daemon.test.ts`：

```ts
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, getCurrentSystemPrompt, getCurrentTools, type FauxProviderHandle } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VexConfig } from "../src/config/schema.js";
import { startDaemon, type Daemon } from "../src/daemon.js";
import { createLogger } from "../src/logger.js";
import { resolvePaths, type VexPaths } from "../src/paths.js";
import { createModelRegistry, type ModelRegistry } from "../src/providers/models.js";
import { TestClient } from "./helpers/client.js";
import { createFaux, fauxModels } from "./helpers/faux.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

let dir: string;
let paths: VexPaths;
let faux: FauxProviderHandle;
let daemon: Daemon | undefined;
let client: TestClient | undefined;

beforeEach(async () => {
  dir = await makeTmpDir();
  paths = resolvePaths(dir);
  faux = createFaux();
});
afterEach(async () => {
  client?.close();
  client = undefined;
  await daemon?.stop();
  daemon = undefined;
  await removeTmpDir(dir);
});

function config(overrides: Partial<VexConfig> = {}): VexConfig {
  return {
    model: { provider: faux.getModel().provider, id: faux.getModel().id },
    backgroundModel: { provider: faux.getModel().provider, id: faux.getModel().id },
    providers: {},
    web: { host: "127.0.0.1", port: 0 },
    workspace: join(dir, "workspace"),
    toolPolicy: {},
    bashEnvPassthrough: [],
    ...overrides,
  };
}

function models(): ModelRegistry {
  return createModelRegistry({}, fauxModels(faux));
}

async function chat(text: string): Promise<string> {
  client = await TestClient.connect(`ws://127.0.0.1:${daemon!.port}/ws`);
  client.send({ type: "create_session" });
  const created = await client.waitFor((m) => m.type === "session_created");
  if (created.type !== "session_created") throw new Error("unreachable");
  client.send({ type: "send", sessionId: created.session.id, text });
  await client.waitFor((m) => m.type === "event" && m.event.kind === "busy" && !m.event.busy);
  // Title generation runs in the background; let it land before the test tears down.
  await client.waitFor((m) => m.type === "sessions" && m.sessions.some((x) => x.titled));
  return created.session.id;
}

describe("startDaemon", () => {
  it("serves a working chat with the workspace in the system prompt", async () => {
    let systemPrompt = "";
    faux.setResponses([
      (ctx) => {
        systemPrompt = getCurrentSystemPrompt(ctx.messages);
        return fauxAssistantMessage("在的");
      },
      fauxAssistantMessage("标题"),
    ]);
    daemon = await startDaemon({ paths, config: config(), log: createLogger(), models: models() });
    expect(daemon.url).toBe(`http://127.0.0.1:${daemon.port}`);
    await chat("在吗");

    expect((await stat(join(dir, "workspace", "SOUL.md"))).isFile()).toBe(true);
    expect(systemPrompt).toContain(join(dir, "workspace"));
    expect(systemPrompt).toContain("## SOUL.md");
    expect(systemPrompt).toContain("窗口：网页会话「新对话」");
    expect(client!.messages.some((m) => m.type === "event" && m.event.kind === "assistant_message" && m.event.text === "在的")).toBe(true);
  });

  it("restores conversations after a restart", async () => {
    faux.setResponses([fauxAssistantMessage("记住了"), fauxAssistantMessage("标题")]);
    daemon = await startDaemon({ paths, config: config(), log: createLogger(), models: models() });
    const sessionId = await chat("我叫小王");
    client!.close();
    await daemon.stop();

    daemon = await startDaemon({ paths, config: config(), log: createLogger(), models: models() });
    client = await TestClient.connect(`ws://127.0.0.1:${daemon.port}/ws`);
    client.send({ type: "open", sessionId });
    const history = await client.waitFor((m) => m.type === "history");
    if (history.type !== "history") throw new Error("unreachable");
    expect(history.items).toMatchObject([
      { kind: "user", text: "我叫小王" },
      { kind: "assistant", text: "记住了" },
    ]);
  });

  it("hides denied tools from the model", async () => {
    let toolNames: string[] = [];
    faux.setResponses([
      (ctx) => {
        toolNames = getCurrentTools(ctx.messages).map((t) => t.name);
        return fauxAssistantMessage("ok");
      },
      fauxAssistantMessage("标题"),
    ]);
    daemon = await startDaemon({ paths, config: config({ toolPolicy: { bash: "deny" } }), log: createLogger(), models: models() });
    await chat("hi");
    expect(toolNames).toEqual(["read", "write", "edit", "grep", "find"]);
  });

  it("refuses a public address without a token", async () => {
    await expect(
      startDaemon({ paths, config: config({ web: { host: "0.0.0.0", port: 0 } }), log: createLogger(), models: models() }),
    ).rejects.toThrow(/web.token/);
  });

  it("writes logs to a file", async () => {
    const log = createLogger({ file: paths.logFile });
    daemon = await startDaemon({ paths, config: config(), log, models: models() });
    await daemon.stop();
    daemon = undefined;
    log.flush();
    await new Promise((r) => setTimeout(r, 100));
    expect(await readFile(paths.logFile, "utf8")).toContain("vexd started");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/daemon.test.ts`
Expected: FAIL，无法解析 `../src/daemon.js`。

- [ ] **Step 3: 实现**

`src/logger.ts`：

```ts
import pino, { type Logger } from "pino";

export type { Logger };

export function createLogger(opts: { file?: string; stdout?: boolean } = {}): Logger {
  const streams = [
    ...(opts.stdout ? [{ stream: process.stdout }] : []),
    ...(opts.file ? [{ stream: pino.destination({ dest: opts.file, mkdir: true, sync: false }) }] : []),
  ];
  if (streams.length === 0) return pino({ level: "silent" });
  return pino({}, pino.multistream(streams));
}
```

`src/daemon.ts`：

```ts
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ConfigError, saveConfigText } from "./config/load.js";
import type { VexConfig } from "./config/schema.js";
import {
  baseInstructionsSection,
  residentFileSection,
  SystemPromptBuilder,
  timeSection,
} from "./context/prompt.js";
import { EventBus } from "./core/events.js";
import { Session } from "./core/session.js";
import { SessionManager } from "./core/sessionManager.js";
import { createTitleGenerator } from "./core/title.js";
import { isLoopback, WebAuth } from "./gateway/auth.js";
import { Gateway } from "./gateway/server.js";
import type { Logger } from "./logger.js";
import type { VexPaths } from "./paths.js";
import { ApprovalManager } from "./policy/approvals.js";
import { createToolGate } from "./policy/gate.js";
import { ToolPolicy } from "./policy/policy.js";
import { createModelRegistry, type ModelRegistry } from "./providers/models.js";
import { createCoreTools } from "./tools/registry.js";
import { ensureWorkspace } from "./workspace/workspace.js";

export interface DaemonOptions {
  paths: VexPaths;
  config: VexConfig;
  log: Logger;
  models?: ModelRegistry;
  staticDir?: string;
}

export interface Daemon {
  url: string;
  port: number;
  stop(): Promise<void>;
}

const DEFAULT_STATIC_DIR = fileURLToPath(new URL("./web/static/", import.meta.url));

export async function startDaemon(opts: DaemonOptions): Promise<Daemon> {
  const { paths, config, log } = opts;
  if (!isLoopback(config.web.host) && !config.web.token) {
    throw new ConfigError("web.host 不是本机地址时必须设置 web.token");
  }
  await ensureWorkspace(config.workspace);

  const models = opts.models ?? createModelRegistry(config.providers);
  const model = models.resolve(config.model);
  const backgroundModel = models.resolve(config.backgroundModel);
  const getApiKey = (provider: string) => models.getApiKey(provider);

  const bus = new EventBus((err) => log.error({ err }, "event listener failed"));
  const approvals = new ApprovalManager({ onChange: () => bus.emit({ type: "approvals_changed" }) });
  const policy = new ToolPolicy({ workspace: config.workspace, overrides: config.toolPolicy });
  const tools = policy.filter(
    createCoreTools({ workspace: config.workspace, bashEnvPassthrough: config.bashEnvPassthrough }),
  );
  const prompt = new SystemPromptBuilder([
    baseInstructionsSection(config.workspace),
    residentFileSection({ workspace: config.workspace, file: "SOUL.md", maxLines: 200 }),
    residentFileSection({ workspace: config.workspace, file: "USER.md", maxLines: 200 }),
    residentFileSection({ workspace: config.workspace, file: "MEMORY.md", maxLines: 100 }),
    timeSection(),
  ]);

  const sessions = new SessionManager({
    paths,
    bus,
    openSession: (key, transcriptPath, windowLabel) =>
      Session.open({
        key,
        transcriptPath,
        model,
        thinking: config.model.thinking,
        tools,
        streamFn: models.streamFn,
        getApiKey,
        buildSystemPrompt: () => prompt.build({ windowLabel: windowLabel(), now: new Date() }),
        beforeToolCall: createToolGate({ policy, approvals, sessionKey: key, windowLabel }),
        emit: (event) => bus.emit({ type: "session", sessionKey: key, event }),
        onError: (err) => log.error({ err, session: key }, "session run failed"),
      }),
    generateTitle: createTitleGenerator({ model: backgroundModel, complete: models.completeSimple, getApiKey }),
    onError: (err) => log.warn({ err }, "session manager task failed"),
  });
  await sessions.init();

  const gateway = new Gateway({
    host: config.web.host,
    port: config.web.port,
    auth: new WebAuth(config.web.token),
    sessions,
    approvals,
    bus,
    config: { read: () => readFile(paths.config, "utf8"), save: (text) => saveConfigText(paths, text) },
    staticDir: opts.staticDir ?? DEFAULT_STATIC_DIR,
    log,
  });
  const { port } = await gateway.start();
  const host = config.web.host.includes(":") ? `[${config.web.host}]` : config.web.host;
  const url = `http://${host}:${port}`;
  log.info({ url, model: `${model.provider}/${model.id}` }, "vexd started");

  const step = async (name: string, fn: () => Promise<void> | void) => {
    try {
      await fn();
    } catch (err) {
      log.error({ err, step: name }, "shutdown step failed");
    }
  };

  return {
    url,
    port,
    async stop() {
      await step("sessions", () => sessions.shutdown());
      await step("approvals", () => approvals.dispose());
      await step("gateway", () => gateway.stop());
      log.info("vexd stopped");
    },
  };
}
```

- [ ] **Step 4: 运行测试与类型检查**

Run: `npx vitest run tests/daemon.test.ts && npm run lint`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/logger.ts src/daemon.ts tests/daemon.test.ts
git commit -m "feat: assemble vexd daemon

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: `vex` 命令行

**Files:**
- Create: `src/cli/process.ts`, `src/cli/onboard.ts`, `src/cli/index.ts`
- Test: `tests/cli-process.test.ts`, `tests/onboard.test.ts`

**Interfaces:**
- Consumes: `resolvePaths`（Task 1）、`loadConfig`、`saveConfigText`、`ConfigError`（Task 2）、`ensureWorkspace`（Task 4）、`createLogger`、`startDaemon`（Task 15）
- Produces（`src/cli/process.ts`）：
  - `readPid(file: string): Promise<number | undefined>`
  - `writePid(file: string, pid: number): Promise<void>`
  - `removePid(file: string): Promise<void>`
  - `isAlive(pid: number): boolean`
  - `waitUntil(check: () => boolean | Promise<boolean>, timeoutMs: number, intervalMs?: number): Promise<boolean>`
  - `tailLines(file: string, count: number): Promise<string[]>`
- Produces（`src/cli/onboard.ts`）：
  - `interface OnboardIO { ask(question: string): Promise<string>; print(line: string): void }`
  - `runOnboard(io: OnboardIO, paths: VexPaths, opts: { force: boolean }): Promise<boolean>`

命令：

| 命令 | 行为 |
|---|---|
| `vex start` | 前台运行 vexd，日志写入 `logs/vexd.log`，写 pid 文件；收到 SIGINT / SIGTERM 时按顺序关闭 |
| `vex start -d` | 先校验配置，再以分离进程启动 `vex start`，等待 pid 文件出现（最长 15 秒） |
| `vex stop` | 向 pid 发送 SIGTERM，等待退出（最长 10 秒） |
| `vex status` | 显示是否在运行、pid 与地址 |
| `vex logs [-f]` | 显示最后 200 行日志；`-f` 持续输出新内容 |
| `vex onboard [--force]` | 交互式生成 `config.yaml` 并创建工作区；已有配置时需 `--force` |

onboard 流程：选择提供方（DeepSeek、Kimi、MiniMax、智谱、千问、小米、OpenRouter 中 pi-ai 内置的，加“自定义”）→ 内置提供方选择模型并输入 API key；自定义提供方输入名称、接口类型、baseUrl、模型 id、API key（可留空）→ WebChat 端口（默认 7860）→ 写入配置并创建工作区。

- [ ] **Step 1: 写失败的测试**

`tests/cli-process.test.ts`：

```ts
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isAlive, readPid, removePid, tailLines, waitUntil, writePid } from "../src/cli/process.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

let dir: string;
beforeEach(async () => { dir = await makeTmpDir(); });
afterEach(async () => { await removeTmpDir(dir); });

describe("pid file", () => {
  it("writes, reads and removes", async () => {
    const file = join(dir, "vexd.pid");
    expect(await readPid(file)).toBeUndefined();
    await writePid(file, 4242);
    expect(await readPid(file)).toBe(4242);
    await removePid(file);
    expect(await readPid(file)).toBeUndefined();
  });

  it("ignores garbage", async () => {
    const file = join(dir, "vexd.pid");
    await writeFile(file, "abc", "utf8");
    expect(await readPid(file)).toBeUndefined();
  });
});

describe("isAlive", () => {
  it("detects live and exited processes", async () => {
    expect(isAlive(process.pid)).toBe(true);
    const child = spawn("true");
    await new Promise((r) => child.on("exit", r));
    expect(isAlive(child.pid!)).toBe(false);
  });
});

describe("waitUntil", () => {
  it("resolves true once the check passes and false on timeout", async () => {
    let n = 0;
    expect(await waitUntil(() => ++n >= 3, 1000, 5)).toBe(true);
    expect(await waitUntil(() => false, 50, 5)).toBe(false);
  });
});

describe("tailLines", () => {
  it("returns the last lines of a file", async () => {
    const file = join(dir, "log");
    await writeFile(file, "1\n2\n3\n4\n", "utf8");
    expect(await tailLines(file, 2)).toEqual(["3", "4"]);
    expect(await tailLines(join(dir, "missing"), 2)).toEqual([]);
  });
});
```

`tests/onboard.test.ts`：

```ts
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runOnboard, type OnboardIO } from "../src/cli/onboard.js";
import { loadConfig } from "../src/config/load.js";
import { resolvePaths, type VexPaths } from "../src/paths.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

let dir: string;
let paths: VexPaths;
beforeEach(async () => {
  dir = await makeTmpDir();
  paths = resolvePaths(dir);
});
afterEach(async () => { await removeTmpDir(dir); });

function scripted(answers: string[]): OnboardIO & { output: string[] } {
  const output: string[] = [];
  return {
    output,
    ask: async (question) => {
      output.push(question);
      const answer = answers.shift();
      if (answer === undefined) throw new Error(`unexpected question: ${question}`);
      return answer;
    },
    print: (line) => output.push(line),
  };
}

describe("runOnboard", () => {
  it("configures a built-in provider", async () => {
    const io = scripted(["9", "1", "1", "", "sk-test", ""]);
    expect(await runOnboard(io, paths, { force: false })).toBe(true);
    const { config } = await loadConfig(paths);
    expect(config.model).toEqual({ provider: "deepseek", id: getBuiltinModels("deepseek")[0]!.id });
    expect(config.providers.deepseek?.apiKey).toBe("sk-test");
    expect(config.web.port).toBe(7860);
    expect((await stat(join(dir, "workspace", "SOUL.md"))).isFile()).toBe(true);
    expect(io.output).toContain("请输入 1 到 8 之间的编号");
    expect(io.output).toContain("API key 不能为空");
  });

  it("configures a custom provider", async () => {
    const io = scripted(["8", "stepfun", "1", "https://api.stepfun.com/v1", "step-2-16k", "", "abc", "8000"]);
    expect(await runOnboard(io, paths, { force: false })).toBe(true);
    const { config } = await loadConfig(paths);
    expect(config.model).toEqual({ provider: "stepfun", id: "step-2-16k" });
    expect(config.providers.stepfun).toEqual({
      api: "openai-completions",
      baseUrl: "https://api.stepfun.com/v1",
      models: [{ id: "step-2-16k" }],
    });
    expect(config.web.port).toBe(8000);
    expect(io.output).toContain("请输入 1 到 65535 之间的端口");
  });

  it("refuses to overwrite an existing config without --force", async () => {
    await writeFile(paths.config, "model: { provider: deepseek, id: x }\n", "utf8");
    const io = scripted([]);
    expect(await runOnboard(io, paths, { force: false })).toBe(false);
    expect(io.output[0]).toContain("--force");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/cli-process.test.ts tests/onboard.test.ts`
Expected: FAIL，无法解析模块。

- [ ] **Step 3: 实现**

`src/cli/process.ts`：

```ts
import { readFile, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { writeFileAtomic } from "../store/atomic.js";

export async function readPid(file: string): Promise<number | undefined> {
  try {
    const pid = Number((await readFile(file, "utf8")).trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

export async function writePid(file: string, pid: number): Promise<void> {
  await writeFileAtomic(file, `${pid}\n`);
}

export async function removePid(file: string): Promise<void> {
  await rm(file, { force: true });
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function waitUntil(
  check: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 200,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await delay(intervalMs);
  }
  return check();
}

export async function tailLines(file: string, count: number): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return [];
  }
  return text.split("\n").filter((line) => line.length > 0).slice(-count);
}
```

`src/cli/onboard.ts`：

```ts
import { access } from "node:fs/promises";
import { getBuiltinModels, getBuiltinProviders, type BuiltinProvider } from "@earendil-works/pi-ai/providers/all";
import { stringify } from "yaml";
import { loadConfig, saveConfigText } from "../config/load.js";
import type { VexPaths } from "../paths.js";
import { ensureWorkspace } from "../workspace/workspace.js";

export interface OnboardIO {
  ask(question: string): Promise<string>;
  print(line: string): void;
}

const FEATURED_PROVIDERS = [
  "deepseek",
  "moonshotai-cn",
  "minimax-cn",
  "zai-coding-cn",
  "qwen-token-plan-cn",
  "xiaomi",
  "openrouter",
];

export async function runOnboard(io: OnboardIO, paths: VexPaths, opts: { force: boolean }): Promise<boolean> {
  if (!opts.force && (await exists(paths.config))) {
    io.print(`配置文件已存在：${paths.config}（使用 --force 覆盖）`);
    return false;
  }

  const known: string[] = getBuiltinProviders();
  const providers = FEATURED_PROVIDERS.filter((p) => known.includes(p));
  io.print("选择模型提供方：");
  providers.forEach((p, i) => io.print(`  ${i + 1}. ${p}`));
  io.print(`  ${providers.length + 1}. 自定义（OpenAI / Anthropic 兼容端点）`);
  const choice = await askNumber(io, "编号：", 1, providers.length + 1, "编号");

  const doc: Record<string, unknown> = {};
  const provider = providers[choice - 1];
  if (provider) {
    const ids = getBuiltinModels(provider as BuiltinProvider).map((m) => m.id);
    io.print("选择模型：");
    ids.forEach((id, i) => io.print(`  ${i + 1}. ${id}`));
    const id = ids[(await askNumber(io, "编号：", 1, ids.length, "编号")) - 1]!;
    const apiKey = await askRequired(io, "API key：", "API key");
    doc.model = { provider, id };
    doc.providers = { [provider]: { apiKey } };
  } else {
    const name = await askRequired(io, "提供方名称（如 stepfun）：", "提供方名称");
    io.print("接口类型：");
    io.print("  1. openai-completions");
    io.print("  2. anthropic-messages");
    const api = (await askNumber(io, "编号：", 1, 2, "编号")) === 1 ? "openai-completions" : "anthropic-messages";
    const baseUrl = await askRequired(io, "baseUrl：", "baseUrl");
    const id = await askRequired(io, "模型 id：", "模型 id");
    const apiKey = (await io.ask("API key（没有可留空）：")).trim();
    doc.model = { provider: name, id };
    doc.providers = { [name]: { api, baseUrl, ...(apiKey ? { apiKey } : {}), models: [{ id }] } };
  }

  const port = await askNumber(io, "WebChat 端口（默认 7860）：", 1, 65535, "端口", 7860);
  doc.web = { host: "127.0.0.1", port };

  await saveConfigText(paths, stringify(doc));
  const { config } = await loadConfig(paths);
  await ensureWorkspace(config.workspace);
  io.print(`已写入 ${paths.config}`);
  io.print(`工作区：${config.workspace}`);
  io.print("运行 vex start 启动");
  return true;
}

async function askRequired(io: OnboardIO, question: string, label: string): Promise<string> {
  for (;;) {
    const answer = (await io.ask(question)).trim();
    if (answer) return answer;
    io.print(`${label} 不能为空`);
  }
}

async function askNumber(
  io: OnboardIO,
  question: string,
  min: number,
  max: number,
  label: string,
  fallback?: number,
): Promise<number> {
  for (;;) {
    const answer = (await io.ask(question)).trim();
    if (!answer && fallback !== undefined) return fallback;
    const value = Number(answer);
    if (Number.isInteger(value) && value >= min && value <= max) return value;
    io.print(`请输入 ${min} 到 ${max} 之间的${label}`);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
```

`src/cli/index.ts`：

```ts
#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, open, stat } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadConfig } from "../config/load.js";
import { startDaemon } from "../daemon.js";
import { createLogger } from "../logger.js";
import { resolvePaths, type VexPaths } from "../paths.js";
import { runOnboard } from "./onboard.js";
import { isAlive, readPid, removePid, tailLines, waitUntil, writePid } from "./process.js";

const USAGE = [
  "用法：vex <命令>",
  "  start [-d]          启动 vexd（-d 在后台运行）",
  "  stop                停止后台运行的 vexd",
  "  status              查看运行状态",
  "  logs [-f]           查看日志（-f 持续输出）",
  "  onboard [--force]   生成初始配置",
].join("\n");

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const paths = resolvePaths();
  switch (command) {
    case "start": {
      const { values } = parseArgs({ args: rest, options: { daemon: { type: "boolean", short: "d" } } });
      return values.daemon ? startBackground(paths) : startForeground(paths);
    }
    case "stop":
      return stop(paths);
    case "status":
      return status(paths);
    case "logs": {
      const { values } = parseArgs({ args: rest, options: { follow: { type: "boolean", short: "f" } } });
      return logs(paths, values.follow ?? false);
    }
    case "onboard": {
      const { values } = parseArgs({ args: rest, options: { force: { type: "boolean" } } });
      return onboard(paths, values.force ?? false);
    }
    default:
      console.log(USAGE);
      return command ? 1 : 0;
  }
}

async function runningPid(paths: VexPaths): Promise<number | undefined> {
  const pid = await readPid(paths.pidFile);
  return pid !== undefined && isAlive(pid) ? pid : undefined;
}

async function startForeground(paths: VexPaths): Promise<number> {
  const { config } = await loadConfig(paths);
  const existing = await runningPid(paths);
  if (existing) {
    console.error(`vexd 已在运行（pid ${existing}）`);
    return 1;
  }
  const log = createLogger({ file: paths.logFile });
  const daemon = await startDaemon({ paths, config, log });
  await writePid(paths.pidFile, process.pid);
  console.log(`vexd 已启动：${daemon.url}`);
  return new Promise((resolve) => {
    const shutdown = () => {
      void daemon
        .stop()
        .then(() => removePid(paths.pidFile))
        .finally(() => {
          log.flush();
          resolve(0);
        });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

async function startBackground(paths: VexPaths): Promise<number> {
  const { config } = await loadConfig(paths);
  const existing = await runningPid(paths);
  if (existing) {
    console.error(`vexd 已在运行（pid ${existing}）`);
    return 1;
  }
  await mkdir(paths.logs, { recursive: true });
  const out = await open(paths.logFile, "a");
  const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "start"], {
    detached: true,
    stdio: ["ignore", out.fd, out.fd],
    env: process.env,
  });
  child.unref();
  await out.close();
  const started = await waitUntil(async () => (await readPid(paths.pidFile)) === child.pid, 15_000);
  if (!started) {
    console.error("vexd 未能启动，运行 vex logs 查看原因");
    return 1;
  }
  console.log(`vexd 已在后台启动（pid ${child.pid}）：http://${config.web.host}:${config.web.port}`);
  return 0;
}

async function stop(paths: VexPaths): Promise<number> {
  const pid = await runningPid(paths);
  if (!pid) {
    await removePid(paths.pidFile);
    console.log("vexd 未在运行");
    return 0;
  }
  process.kill(pid, "SIGTERM");
  const stopped = await waitUntil(() => !isAlive(pid), 10_000);
  console.log(stopped ? "vexd 已停止" : `vexd 未在 10 秒内退出（pid ${pid}）`);
  return stopped ? 0 : 1;
}

async function status(paths: VexPaths): Promise<number> {
  const pid = await runningPid(paths);
  if (!pid) {
    console.log("vexd 未在运行");
    return 1;
  }
  const { config } = await loadConfig(paths);
  console.log(`vexd 运行中（pid ${pid}）：http://${config.web.host}:${config.web.port}`);
  return 0;
}

async function logs(paths: VexPaths, follow: boolean): Promise<number> {
  for (const line of await tailLines(paths.logFile, 200)) console.log(line);
  if (!follow) return 0;
  let offset = await fileSize(paths.logFile);
  for (;;) {
    await delay(500);
    const size = await fileSize(paths.logFile);
    if (size < offset) offset = 0;
    if (size === offset) continue;
    const handle = await open(paths.logFile, "r");
    const buffer = Buffer.alloc(size - offset);
    await handle.read(buffer, 0, buffer.length, offset);
    await handle.close();
    process.stdout.write(buffer);
    offset = size;
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

async function onboard(paths: VexPaths, force: boolean): Promise<number> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ok = await runOnboard({ ask: (q) => rl.question(q), print: (line) => console.log(line) }, paths, { force });
    return ok ? 0 : 1;
  } finally {
    rl.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
```

- [ ] **Step 4: 运行测试与类型检查**

Run: `npx vitest run tests/cli-process.test.ts tests/onboard.test.ts && npm run lint`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/cli tests/cli-process.test.ts tests/onboard.test.ts
git commit -m "feat: vex command line

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 17: 构建与端到端验证

**Files:**
- 无新增文件

- [ ] **Step 1: 全量检查**

Run: `npm run lint && npm test && npm run build`
Expected: tsc 无输出；所有测试 PASS；`dist/cli/index.js` 与 `dist/web/static/index.html` 存在。

- [ ] **Step 2: 用隔离数据目录验证 CLI**

需要一个真实的模型 API key，向主人索取后执行（不要把 key 写进仓库或提交信息）：

```bash
export VEX_HOME=$(mktemp -d)
node dist/cli/index.js onboard          # 选择提供方、模型，输入 API key，端口回车默认
node dist/cli/index.js start -d          # 预期：vexd 已在后台启动（pid …）：http://127.0.0.1:7860
node dist/cli/index.js status            # 预期：vexd 运行中（pid …）
node dist/cli/index.js logs | tail -5    # 预期：包含 "vexd started"
```

- [ ] **Step 3: 浏览器验证（与主人一起完成）**

打开 `http://127.0.0.1:7860`，逐项确认：

1. 自动创建“新对话”，发送“你好”后回复逐字出现，随后左侧标题自动变为模型生成的标题。
2. 发送“在工作区写一个 hello.md，内容是 hi”：无需审批，`$VEX_HOME/workspace/hello.md` 被创建。
3. 发送“用 bash 执行 date”：出现审批卡片；点“拒绝”后模型说明被拒绝；再次请求并点“允许”后显示命令结果。
4. 让它写一段 500 字的文章，生成过程中点“停止”：回复停止并标注“（已中断）”。
5. 生成过程中再发送一句补充，模型在同一轮里回应补充内容。
6. 新建第二个会话、双击改名、删除第一个会话，刷新页面后列表与内容保持一致。
7. 打开设置，把 `web.port` 改成非法值保存，看到校验错误；改回后保存成功。
8. 停止并重启 vexd（`vex stop` / `vex start -d`），打开原会话，历史完整。

- [ ] **Step 4: 清理**

```bash
node dist/cli/index.js stop             # 预期：vexd 已停止
rm -rf "$VEX_HOME"; unset VEX_HOME
```
