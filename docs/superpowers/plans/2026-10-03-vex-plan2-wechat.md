# Vex 计划 2：微信接入 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 vexd 通过个人微信（iLink OC API）与主人对话：扫码绑定、只响应主人、一轮一条回复、`/stop` 与 `/y` `/ya` `/n` 指令、审批推送到微信、掉线自动重连。

**Architecture:** `WeChatClient` 用原生 fetch 封装 iLink 接口；`WeChatStore` 把登录态与最近的上下文 token 存在 `~/.vex/wechat/`（0600）；`WeChatChannel` 长轮询收消息、过滤主人、把对话交给 `wechat` 会话，并订阅事件总线把一轮回复、“处理中”提示和审批请求发回微信；`startWeChatChannel` 在 vexd 启动时按配置与登录态决定是否接入；`vex wechat login` 与 `vex onboard` 负责终端扫码绑定。

**Tech Stack:** 计划 1 的技术栈，新增 `qrcode`（终端二维码）。

**Spec:** `docs/superpowers/specs/2026-10-02-vex-design.md`（§5 会话模型、§6.1–6.2、§7.3 审批、§13 配置、§14 数据目录、§15 错误处理）

## Global Constraints

- 运行时 Node.js ≥ 24；ESM only，NodeNext 解析，源码 import 写 `.js` 扩展名
- TypeScript：`strict`、`noUncheckedIndexedAccess`、`noImplicitReturns`、`noFallthroughCasesInSwitch`；不使用 `@ts-ignore`
- 代码注释用英文、一行、只写不明显的原因；用户可见文案（微信消息、终端输出、错误信息）用中文
- 不使用进程级可变单例；依赖经构造参数传入
- 数据目录默认 `~/.vex/`，可用 `VEX_HOME` 覆盖；测试一律使用临时目录，iLink 接口一律用本地假服务器（`tests/helpers/ilink.ts`），不访问真实微信服务
- iLink 默认地址 `https://ilinkai.weixin.qq.com`；所有响应体里 `ret` 或 `errcode` 非 0 都视为失败，`errcode -14` 表示登录失效
- 只响应主人：主人 = 配置 `wechat.ownerId`，缺省为扫码绑定的微信号；其他人的消息直接忽略
- 微信单条消息最多 2000 字，超出按行优先分段
- 一轮运行超过 15 秒先发“处理中…”；长轮询失败指数退避 1 秒起、最长 60 秒
- 登录态文件 `~/.vex/wechat/credentials.json` 与 `state.json` 权限 0600，目录 0700
- 每个任务结束时 `npm run lint` 与 `npm test` 必须通过
- 提交信息末尾附：`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## 文件结构

```
src/
  config/schema.ts, config/load.ts   新增 wechat 配置块（enabled / ownerId / baseUrl）
  paths.ts                           新增 wechat 目录
  channels/wechat/
    store.ts      登录态与上下文 token 的读写
    client.ts     iLink HTTP 客户端（二维码、登录状态、拉取消息、发送文本）
    messages.ts   纯函数：入站文本提取、主人指令解析、长消息分段、审批提示文案
    login.ts      终端扫码登录流程
    channel.ts    WeChatChannel：长轮询、主人过滤、指令、回复与审批推送
    setup.ts      startWeChatChannel：按配置与登录态决定是否接入
  cli/wechat.ts   vex wechat login
  cli/index.ts    新增 wechat 子命令
  cli/onboard.ts  结尾询问是否当场扫码绑定
  daemon.ts       启动时接入微信，关闭时最先停止微信
tests/
  helpers/ilink.ts   iLink 假服务器
  wechat-*.test.ts, daemon-wechat.test.ts
```

---

### Task 1: 微信配置、数据路径与登录态存储

**Files:**
- Modify: `src/config/schema.ts`, `src/config/load.ts`, `src/paths.ts`
- Create: `src/channels/wechat/store.ts`
- Modify: `tests/config.test.ts`, `tests/paths.test.ts`, `tests/daemon.test.ts`
- Test: `tests/wechat-store.test.ts`

**Interfaces:**
- Produces:
  - `VexConfig.wechat: { enabled: boolean; ownerId?: string; baseUrl: string }`（`enabled` 缺省 `true`，`baseUrl` 缺省 `DEFAULT_WECHAT_BASE_URL`）
  - `DEFAULT_WECHAT_BASE_URL = "https://ilinkai.weixin.qq.com"`（`src/config/schema.ts`）
  - `VexPaths.wechat`：`<home>/wechat`
  - `interface WeChatCredentials { token: string; accountId: string; baseUrl: string; userId?: string }`
  - `interface WeChatState { contextToken?: string }`
  - `class WeChatStore { constructor(dir: string); readonly credentialsFile: string; readonly stateFile: string; loadCredentials(): Promise<WeChatCredentials | undefined>; saveCredentials(c: WeChatCredentials): Promise<void>; loadState(): Promise<WeChatState>; saveState(s: WeChatState): Promise<void> }`

文件缺失、损坏或缺少必要字段时，`loadCredentials` 返回 `undefined`，`loadState` 返回 `{}`。写入使用 `writeFileAtomic(path, data, 0o600, 0o700)`。

- [ ] **Step 1: 写测试并修改受影响的测试**

`tests/wechat-store.test.ts`：

```ts
import { stat, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WeChatStore } from "../src/channels/wechat/store.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

let dir: string;
beforeEach(async () => { dir = await makeTmpDir(); });
afterEach(async () => { await removeTmpDir(dir); });

describe("WeChatStore", () => {
  it("returns nothing before login", async () => {
    const store = new WeChatStore(join(dir, "wechat"));
    expect(await store.loadCredentials()).toBeUndefined();
    expect(await store.loadState()).toEqual({});
  });

  it("saves credentials readable only by the owner", async () => {
    const store = new WeChatStore(join(dir, "wechat"));
    const credentials = { token: "t1", accountId: "bot1", baseUrl: "https://example.test", userId: "owner1" };
    await store.saveCredentials(credentials);
    expect(await store.loadCredentials()).toEqual(credentials);
    expect((await stat(store.credentialsFile)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "wechat"))).mode & 0o777).toBe(0o700);
  });

  it("ignores corrupt or incomplete credentials", async () => {
    const store = new WeChatStore(join(dir, "wechat"));
    await mkdir(join(dir, "wechat"), { recursive: true });
    await writeFile(store.credentialsFile, "{oops", "utf8");
    expect(await store.loadCredentials()).toBeUndefined();
    await writeFile(store.credentialsFile, JSON.stringify({ token: "", baseUrl: "x" }), "utf8");
    expect(await store.loadCredentials()).toBeUndefined();
  });

  it("round-trips the last context token", async () => {
    const store = new WeChatStore(join(dir, "wechat"));
    await store.saveState({ contextToken: "ctx-9" });
    expect(await store.loadState()).toEqual({ contextToken: "ctx-9" });
  });
});
```

把以下三个测试文件替换为完整内容。`config.test.ts` 新增了默认值断言和 wechat 配置块测试；`paths.test.ts` 新增了 `wechat` 路径；`daemon.test.ts` 的配置对象补上了 `wechat` 字段。

`tests/config.test.ts`：

```ts
import { readFile, stat, writeFile } from "node:fs/promises";
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
      wechat: { enabled: true, ownerId: undefined, baseUrl: "https://ilinkai.weixin.qq.com" },
    });
  });

  it("reads the wechat block", () => {
    const config = parseConfig(`${minimal}wechat: { enabled: false, ownerId: o9x, baseUrl: "http://127.0.0.1:9000" }\n`, paths);
    expect(config.wechat).toEqual({ enabled: false, ownerId: "o9x", baseUrl: "http://127.0.0.1:9000" });
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

  it("keeps the config file private to the owner", async () => {
    await saveConfigText(paths, minimal);
    expect((await stat(paths.config)).mode & 0o777).toBe(0o600);
  });

  it("creates a missing data directory as owner-only", async () => {
    const home = join(dir, "fresh");
    await saveConfigText(resolvePaths(home), minimal);
    expect((await stat(home)).mode & 0o777).toBe(0o700);
  });
});
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
      wechat: "/data/vex/wechat",
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
    wechat: { enabled: false, baseUrl: "http://127.0.0.1:1" },
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

Run: `npx vitest run tests/wechat-store.test.ts tests/config.test.ts tests/paths.test.ts`
Expected: FAIL：无法解析 `../src/channels/wechat/store.js`；config 与 paths 的默认值断言不匹配。

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
  wechat: Type.Optional(
    Type.Object({
      enabled: Type.Optional(Type.Boolean()),
      ownerId: Type.Optional(Type.String({ minLength: 1 })),
      baseUrl: Type.Optional(Type.String({ minLength: 1 })),
    }),
  ),
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
  wechat: { enabled: boolean; ownerId?: string; baseUrl: string };
}

export const DEFAULT_WECHAT_BASE_URL = "https://ilinkai.weixin.qq.com";
```

`src/config/load.ts`：

```ts
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Value } from "typebox/value";
import { parse } from "yaml";
import { expandHome, type VexPaths } from "../paths.js";
import { writeFileAtomic } from "../store/atomic.js";
import { ConfigSchema, DEFAULT_WECHAT_BASE_URL, type VexConfig } from "./schema.js";

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
    wechat: {
      enabled: raw.wechat?.enabled ?? true,
      ownerId: raw.wechat?.ownerId,
      baseUrl: raw.wechat?.baseUrl ?? DEFAULT_WECHAT_BASE_URL,
    },
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
  await writeFileAtomic(paths.config, text, 0o600, 0o700);
}
```

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
  wechat: string;
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
    wechat: join(root, "wechat"),
  };
}

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}
```

`src/channels/wechat/store.ts`：

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../../store/atomic.js";

export interface WeChatCredentials {
  token: string;
  accountId: string;
  baseUrl: string;
  userId?: string;
}

export interface WeChatState {
  contextToken?: string;
}

export class WeChatStore {
  readonly credentialsFile: string;
  readonly stateFile: string;

  constructor(dir: string) {
    this.credentialsFile = join(dir, "credentials.json");
    this.stateFile = join(dir, "state.json");
  }

  async loadCredentials(): Promise<WeChatCredentials | undefined> {
    const value = await readJson(this.credentialsFile);
    if (!value || typeof value !== "object") return undefined;
    const c = value as Record<string, unknown>;
    if (typeof c.token !== "string" || !c.token || typeof c.baseUrl !== "string" || !c.baseUrl) return undefined;
    return {
      token: c.token,
      accountId: typeof c.accountId === "string" ? c.accountId : "",
      baseUrl: c.baseUrl,
      userId: typeof c.userId === "string" && c.userId ? c.userId : undefined,
    };
  }

  async saveCredentials(credentials: WeChatCredentials): Promise<void> {
    await writeFileAtomic(this.credentialsFile, `${JSON.stringify(credentials, null, 2)}\n`, 0o600, 0o700);
  }

  async loadState(): Promise<WeChatState> {
    const value = await readJson(this.stateFile);
    if (!value || typeof value !== "object") return {};
    const contextToken = (value as Record<string, unknown>).contextToken;
    return typeof contextToken === "string" && contextToken ? { contextToken } : {};
  }

  async saveState(state: WeChatState): Promise<void> {
    await writeFileAtomic(this.stateFile, `${JSON.stringify(state)}\n`, 0o600, 0o700);
  }
}

async function readJson(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 4: 运行测试与类型检查**

Run: `npx vitest run tests/wechat-store.test.ts tests/config.test.ts tests/paths.test.ts && npm run lint && npm test`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/config src/paths.ts src/channels/wechat/store.ts tests/wechat-store.test.ts tests/config.test.ts tests/paths.test.ts tests/daemon.test.ts
git commit -m "feat: wechat config, data paths and credential store

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: iLink 假服务器与微信客户端

**Files:**
- Create: `tests/helpers/ilink.ts`, `src/channels/wechat/client.ts`
- Test: `tests/wechat-client.test.ts`

**Interfaces:**
- Produces（`tests/helpers/ilink.ts`，后续任务的测试共用）：
  - `class FakeIlink { requests: IlinkRequest[]; baseUrl: string; start(): Promise<void>; stop(): Promise<void>; on(path: string, responder: IlinkResponder): void; queueUpdates(...msgs: unknown[]): void; sentTexts(): string[] }`
  - 响应函数返回对象时以 JSON 响应，返回数字时以该 HTTP 状态码响应，返回 Promise 时等它完成（永不完成即模拟挂起的长轮询）
  - 默认路由：`/ilink/bot/getupdates` 每次取出一批 `queueUpdates` 排队的消息（没有时返回空），`/ilink/bot/sendmessage` 返回成功
  - `textMessage(from: string, text: string, extra?: Record<string, unknown>)`：构造一条文本消息，`context_token` 为 `ctx-<from>`
- Produces（`src/channels/wechat/client.ts`）：
  - `SESSION_EXPIRED_ERRCODE = -14`
  - `class WeChatApiError extends Error { endpoint; ret; errcode; errmsg }`
  - `type QrStatus = { status: "wait" } | { status: "expired" } | { status: "cancelled" } | { status: "confirmed"; token; accountId; baseUrl?; userId? }`
  - `interface InboundItem { type: number; text_item?: { text?: string }; voice_item?: { text?: string } }`
  - `interface InboundMessage { messageId: string; fromUserId: string; contextToken: string; items: InboundItem[] }`
  - `class WeChatClient { constructor(opts: { baseUrl: string; token?: string }); getQrCode(botType?: string): Promise<{ qrcode: string; url: string }>; getQrStatus(qrcode: string): Promise<QrStatus>; getUpdates(signal?: AbortSignal): Promise<InboundMessage[]>; sendText(toUserId: string, contextToken: string, text: string): Promise<void> }`

协议细节（沿用旧版 vex-bot 已验证的做法）：
- 请求头：`Content-Type: application/json`、`AuthorizationType: ilink_bot_token`、`X-WECHAT-UIN`（随机 32 位无符号整数的十进制字符串再 base64），需要登录态时加 `Authorization: Bearer <token>`；查询登录状态时加 `iLink-App-ClientVersion: 1`。
- 拉取消息：`POST ilink/bot/getupdates`，请求体 `{ base_info: { channel_version: "vex" } }`。消息没有 id 时，用发送人、时间与内容的 sha1 生成稳定 id，保证重复投递时能去重。
- 发送：`POST ilink/bot/sendmessage`，`message_type: 2`、`message_state: 2`，文本放在 `item_list[0].text_item.text`。

- [ ] **Step 1: 写测试辅助与失败的测试**

`tests/helpers/ilink.ts`：

```ts
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";

export interface IlinkRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  body: unknown;
}

export type IlinkResponder = (req: IlinkRequest) => unknown | Promise<unknown>;

export class FakeIlink {
  readonly requests: IlinkRequest[] = [];
  baseUrl = "";
  private readonly routes = new Map<string, IlinkResponder>();
  private readonly batches: unknown[][] = [];
  private server: Server | undefined;

  constructor() {
    this.routes.set("/ilink/bot/getupdates", () => ({ ret: 0, msgs: this.batches.shift() ?? [] }));
    this.routes.set("/ilink/bot/sendmessage", () => ({ ret: 0 }));
  }

  on(path: string, responder: IlinkResponder): void {
    this.routes.set(path, responder);
  }

  queueUpdates(...msgs: unknown[]): void {
    this.batches.push(msgs);
  }

  sentTexts(): string[] {
    return this.requests
      .filter((r) => r.path === "/ilink/bot/sendmessage")
      .map((r) => {
        const msg = (r.body as { msg: { item_list: { text_item: { text: string } }[] } }).msg;
        return msg.item_list[0]?.text_item.text ?? "";
      });
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const raw = Buffer.concat(chunks).toString("utf8");
        const request: IlinkRequest = {
          method: req.method ?? "GET",
          path: url.pathname,
          query: url.searchParams,
          headers: req.headers,
          body: raw ? (JSON.parse(raw) as unknown) : undefined,
        };
        this.requests.push(request);
        const responder = this.routes.get(url.pathname);
        if (!responder) {
          res.writeHead(404).end();
          return;
        }
        void Promise.resolve(responder(request)).then((result) => {
          if (typeof result === "number") {
            res.writeHead(result).end();
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
        });
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    if (!address || typeof address !== "object") throw new Error("no address");
    this.baseUrl = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

export function textMessage(from: string, text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    from_user_id: from,
    context_token: `ctx-${from}`,
    item_list: [{ type: 1, text_item: { text } }],
    ...extra,
  };
}
```

`tests/wechat-client.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_EXPIRED_ERRCODE, WeChatApiError, WeChatClient } from "../src/channels/wechat/client.js";
import { FakeIlink, textMessage } from "./helpers/ilink.js";

let ilink: FakeIlink;
beforeEach(async () => {
  ilink = new FakeIlink();
  await ilink.start();
});
afterEach(async () => { await ilink.stop(); });

describe("WeChatClient login endpoints", () => {
  it("fetches a login QR code", async () => {
    ilink.on("/ilink/bot/get_bot_qrcode", () => ({ qrcode: "q1", qrcode_img_content: "https://login.example/q1" }));
    const client = new WeChatClient({ baseUrl: `${ilink.baseUrl}/` });
    await expect(client.getQrCode()).resolves.toEqual({ qrcode: "q1", url: "https://login.example/q1" });
    expect(ilink.requests[0]?.query.get("bot_type")).toBe("3");
    expect(ilink.requests[0]?.headers.authorization).toBeUndefined();
  });

  it("rejects a malformed QR response", async () => {
    ilink.on("/ilink/bot/get_bot_qrcode", () => ({ qrcode: "q1" }));
    await expect(new WeChatClient({ baseUrl: ilink.baseUrl }).getQrCode()).rejects.toThrow(/格式不正确/);
  });

  it("maps QR status values", async () => {
    const statuses: unknown[] = [
      { status: "wait" },
      { status: "scaned" },
      { status: "expired" },
      { status: "cancel" },
      { status: "confirmed", bot_token: "tok", ilink_bot_id: "bot1", baseurl: "https://api2.example", ilink_user_id: "owner1" },
      { status: "confirmed" },
    ];
    ilink.on("/ilink/bot/get_qrcode_status", () => statuses.shift());
    const client = new WeChatClient({ baseUrl: ilink.baseUrl });
    await expect(client.getQrStatus("q1")).resolves.toEqual({ status: "wait" });
    await expect(client.getQrStatus("q1")).resolves.toEqual({ status: "wait" });
    await expect(client.getQrStatus("q1")).resolves.toEqual({ status: "expired" });
    await expect(client.getQrStatus("q1")).resolves.toEqual({ status: "cancelled" });
    await expect(client.getQrStatus("q1")).resolves.toEqual({
      status: "confirmed", token: "tok", accountId: "bot1", baseUrl: "https://api2.example", userId: "owner1",
    });
    await expect(client.getQrStatus("q1")).rejects.toThrow(/没有返回 token/);
    expect(ilink.requests[0]?.headers["ilink-app-clientversion"]).toBe("1");
    expect(ilink.requests[0]?.query.get("qrcode")).toBe("q1");
  });
});

describe("WeChatClient messaging", () => {
  it("polls updates with the bot token and normalizes messages", async () => {
    ilink.queueUpdates(
      textMessage("owner1", "你好", { message_id: "m1" }),
      textMessage("owner1", "再见", { msg_id: 42 }),
      textMessage("owner1", "无 id", { create_time_ms: 1790000000000 }),
      { context_token: "ctx", item_list: [] },
      "garbage",
    );
    const client = new WeChatClient({ baseUrl: ilink.baseUrl, token: "tok" });
    const messages = await client.getUpdates();
    expect(messages.map((m) => m.messageId.slice(0, 3))).toEqual(["m1", "42", "wx_"]);
    expect(messages[0]).toEqual({
      messageId: "m1",
      fromUserId: "owner1",
      contextToken: "ctx-owner1",
      items: [{ type: 1, text_item: { text: "你好" } }],
    });
    const request = ilink.requests[0]!;
    expect(request.method).toBe("POST");
    expect(request.headers.authorization).toBe("Bearer tok");
    expect(request.headers.authorizationtype).toBe("ilink_bot_token");
    expect(Buffer.from(String(request.headers["x-wechat-uin"]), "base64").toString("utf8")).toMatch(/^\d+$/);
    expect(request.body).toEqual({ base_info: { channel_version: "vex" } });
  });

  it("gives a redelivered id-less message the same id", async () => {
    const msg = textMessage("owner1", "重复", { create_time: 1790000000 });
    ilink.queueUpdates(msg);
    ilink.queueUpdates(msg);
    const client = new WeChatClient({ baseUrl: ilink.baseUrl, token: "tok" });
    const [a] = await client.getUpdates();
    const [b] = await client.getUpdates();
    expect(a?.messageId).toBe(b?.messageId);
  });

  it("sends a text message", async () => {
    const client = new WeChatClient({ baseUrl: ilink.baseUrl, token: "tok" });
    await client.sendText("owner1", "ctx-owner1", "收到");
    const body = ilink.requests[0]?.body as { msg: Record<string, unknown> };
    expect(body.msg).toMatchObject({
      to_user_id: "owner1",
      context_token: "ctx-owner1",
      message_type: 2,
      message_state: 2,
      item_list: [{ type: 1, text_item: { text: "收到" } }],
    });
    expect(ilink.sentTexts()).toEqual(["收到"]);
  });

  it("surfaces body-level errors and HTTP failures", async () => {
    ilink.on("/ilink/bot/getupdates", () => ({ ret: 0, errcode: SESSION_EXPIRED_ERRCODE, errmsg: "session timeout" }));
    const client = new WeChatClient({ baseUrl: ilink.baseUrl, token: "tok" });
    const err = await client.getUpdates().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WeChatApiError);
    expect((err as WeChatApiError).errcode).toBe(SESSION_EXPIRED_ERRCODE);
    ilink.on("/ilink/bot/sendmessage", () => ({ ret: 1, errmsg: "bad context" }));
    await expect(client.sendText("owner1", "ctx", "x")).rejects.toThrow(/ret=1/);
    ilink.on("/ilink/bot/getupdates", () => 502);
    await expect(client.getUpdates()).rejects.toThrow(/HTTP 502/);
  });

  it("stops polling when aborted", async () => {
    ilink.on("/ilink/bot/getupdates", () => new Promise(() => {}));
    const client = new WeChatClient({ baseUrl: ilink.baseUrl, token: "tok" });
    const controller = new AbortController();
    const pending = client.getUpdates(controller.signal);
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/wechat-client.test.ts`
Expected: FAIL，无法解析 `../src/channels/wechat/client.js`。

- [ ] **Step 3: 实现**

`src/channels/wechat/client.ts`：

```ts
import { createHash, randomBytes, randomUUID } from "node:crypto";

export const SESSION_EXPIRED_ERRCODE = -14;

export class WeChatApiError extends Error {
  constructor(
    readonly endpoint: string,
    readonly ret: number,
    readonly errcode: number,
    readonly errmsg: string,
  ) {
    super(`微信接口 ${endpoint} 失败：ret=${ret} errcode=${errcode} ${errmsg}`);
    this.name = "WeChatApiError";
  }
}

export interface QrCode {
  qrcode: string;
  url: string;
}

export type QrStatus =
  | { status: "wait" }
  | { status: "expired" }
  | { status: "cancelled" }
  | { status: "confirmed"; token: string; accountId: string; baseUrl?: string; userId?: string };

export interface InboundItem {
  type: number;
  text_item?: { text?: string };
  voice_item?: { text?: string };
}

export interface InboundMessage {
  messageId: string;
  fromUserId: string;
  contextToken: string;
  items: InboundItem[];
}

interface RequestOptions {
  query?: Record<string, string>;
  body?: unknown;
  auth: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const UPDATES_TIMEOUT_MS = 45_000;
const QR_STATUS_TIMEOUT_MS = 40_000;

export class WeChatClient {
  private readonly baseUrl: string;

  constructor(private readonly opts: { baseUrl: string; token?: string }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
  }

  async getQrCode(botType = "3"): Promise<QrCode> {
    const data = await this.request("GET", "ilink/bot/get_bot_qrcode", {
      query: { bot_type: botType },
      auth: false,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    const qrcode = typeof data.qrcode === "string" ? data.qrcode.trim() : "";
    const url = typeof data.qrcode_img_content === "string" ? data.qrcode_img_content.trim() : "";
    if (!qrcode || !url) throw new Error("微信登录二维码响应格式不正确");
    return { qrcode, url };
  }

  async getQrStatus(qrcode: string): Promise<QrStatus> {
    const data = await this.request("GET", "ilink/bot/get_qrcode_status", {
      query: { qrcode },
      auth: false,
      timeoutMs: QR_STATUS_TIMEOUT_MS,
      headers: { "iLink-App-ClientVersion": "1" },
    });
    const status = typeof data.status === "string" ? data.status : "wait";
    if (status === "confirmed") {
      const token = typeof data.bot_token === "string" ? data.bot_token : "";
      if (!token) throw new Error("微信登录已确认，但没有返回 token");
      return {
        status: "confirmed",
        token,
        accountId: typeof data.ilink_bot_id === "string" ? data.ilink_bot_id : "",
        baseUrl: typeof data.baseurl === "string" && data.baseurl ? data.baseurl : undefined,
        userId: typeof data.ilink_user_id === "string" && data.ilink_user_id ? data.ilink_user_id : undefined,
      };
    }
    if (status === "expired") return { status: "expired" };
    if (status === "cancel" || status === "canceled" || status === "denied") return { status: "cancelled" };
    return { status: "wait" };
  }

  async getUpdates(signal?: AbortSignal): Promise<InboundMessage[]> {
    const data = await this.request("POST", "ilink/bot/getupdates", {
      body: { base_info: { channel_version: "vex" } },
      auth: true,
      timeoutMs: UPDATES_TIMEOUT_MS,
      signal,
    });
    const msgs = Array.isArray(data.msgs) ? data.msgs : [];
    return msgs.flatMap((raw) => {
      const message = normalizeMessage(raw);
      return message ? [message] : [];
    });
  }

  async sendText(toUserId: string, contextToken: string, text: string): Promise<void> {
    await this.request("POST", "ilink/bot/sendmessage", {
      body: {
        base_info: { channel_version: "vex" },
        msg: {
          from_user_id: "",
          to_user_id: toUserId,
          client_id: randomUUID(),
          message_type: 2,
          message_state: 2,
          context_token: contextToken,
          item_list: [{ type: 1, text_item: { text } }],
        },
      },
      auth: true,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
  }

  private async request(method: string, endpoint: string, opts: RequestOptions): Promise<Record<string, unknown>> {
    const url = new URL(`${this.baseUrl}/${endpoint}`);
    for (const [key, value] of Object.entries(opts.query ?? {})) url.searchParams.set(key, value);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      "X-WECHAT-UIN": randomUin(),
      ...opts.headers,
    };
    if (opts.auth && this.opts.token) headers.Authorization = `Bearer ${this.opts.token}`;
    const timeout = AbortSignal.timeout(opts.timeoutMs);
    const response = await fetch(url, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
    });
    if (!response.ok) throw new Error(`微信接口 ${endpoint} 返回 HTTP ${response.status}`);
    const parsed: unknown = await response.json();
    const data = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    // The API reports failures in the body even on HTTP 200.
    const ret = typeof data.ret === "number" ? data.ret : 0;
    const errcode = typeof data.errcode === "number" ? data.errcode : 0;
    if (ret !== 0 || errcode !== 0) {
      throw new WeChatApiError(endpoint, ret, errcode, typeof data.errmsg === "string" ? data.errmsg : "");
    }
    return data;
  }
}

function randomUin(): string {
  return Buffer.from(String(randomBytes(4).readUInt32BE(0)), "utf8").toString("base64");
}

function normalizeMessage(raw: unknown): InboundMessage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const m = raw as Record<string, unknown>;
  const fromUserId = typeof m.from_user_id === "string" ? m.from_user_id.trim() : "";
  if (!fromUserId) return undefined;
  const items = Array.isArray(m.item_list) ? (m.item_list.filter((i) => i && typeof i === "object") as InboundItem[]) : [];
  const explicitId = [m.message_id, m.msg_id].find((v) => typeof v === "string" || typeof v === "number");
  return {
    messageId: explicitId !== undefined ? String(explicitId) : fallbackId(fromUserId, m.create_time_ms ?? m.create_time, items),
    fromUserId,
    contextToken: typeof m.context_token === "string" ? m.context_token.trim() : "",
    items,
  };
}

// Redelivered messages without an id must map to the same key so they dedupe.
function fallbackId(from: string, time: unknown, items: InboundItem[]): string {
  const material = JSON.stringify({ from, time: time ?? "", items });
  return `wx_${createHash("sha1").update(material).digest("hex").slice(0, 16)}`;
}
```

- [ ] **Step 4: 运行测试与类型检查**

Run: `npx vitest run tests/wechat-client.test.ts && npm run lint && npm test`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add tests/helpers/ilink.ts src/channels/wechat/client.ts tests/wechat-client.test.ts
git commit -m "feat: ilink wechat client with a local fake server for tests

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 微信消息的纯函数

**Files:**
- Create: `src/channels/wechat/messages.ts`
- Test: `tests/wechat-messages.test.ts`

**Interfaces:**
- Consumes: `InboundItem`（Task 2）、`ApprovalAnswer`、`ApprovalRequest`（`src/policy/approvals.ts`）
- Produces:
  - `MAX_MESSAGE_CHARS = 2000`
  - `type OwnerCommand = { kind: "stop" } | { kind: "approve"; answer: ApprovalAnswer } | { kind: "chat"; text: string }`
  - `extractText(items: InboundItem[]): string`：文本原样，图片 `[图片]`，语音取识别文字否则 `[语音]`，文件 `[文件]`，视频 `[视频]`
  - `parseCommand(text: string): OwnerCommand`：`/stop`、`/y`、`/ya`、`/n`（大小写不敏感，允许全角斜杠），其余为对话
  - `splitMessage(text: string, max?: number): string[]`：优先在换行处切分，不产生空段
  - `formatClock(ms: number, timeZone?: string): string`：24 小时制 `HH:MM`
  - `formatApprovalPrompt(request: ApprovalRequest, pendingCount: number, timeZone?: string): string`：详情超过 1500 字截断

- [ ] **Step 1: 写失败的测试**

`tests/wechat-messages.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import {
  extractText,
  formatApprovalPrompt,
  formatClock,
  parseCommand,
  splitMessage,
} from "../src/channels/wechat/messages.js";
import type { ApprovalRequest } from "../src/policy/approvals.js";

describe("extractText", () => {
  it("joins text and labels media", () => {
    expect(
      extractText([
        { type: 1, text_item: { text: "看这个" } },
        { type: 2 },
        { type: 3, voice_item: { text: "语音转文字" } },
        { type: 3 },
        { type: 4 },
        { type: 5 },
        { type: 99 },
        { type: 1, text_item: { text: "  " } },
      ]),
    ).toBe("看这个\n[图片]\n语音转文字\n[语音]\n[文件]\n[视频]");
  });
});

describe("parseCommand", () => {
  it("recognizes owner commands with either slash", () => {
    expect(parseCommand("/stop")).toEqual({ kind: "stop" });
    expect(parseCommand(" /Y ")).toEqual({ kind: "approve", answer: "allow" });
    expect(parseCommand("／ya")).toEqual({ kind: "approve", answer: "allow_session" });
    expect(parseCommand("/n")).toEqual({ kind: "approve", answer: "deny" });
  });

  it("treats everything else as chat", () => {
    expect(parseCommand("/yes please")).toEqual({ kind: "chat", text: "/yes please" });
    expect(parseCommand("你好")).toEqual({ kind: "chat", text: "你好" });
  });
});

describe("splitMessage", () => {
  it("keeps short text whole and drops blank text", () => {
    expect(splitMessage("  短消息 ")).toEqual(["短消息"]);
    expect(splitMessage("   ")).toEqual([]);
  });

  it("prefers line breaks and never exceeds the limit", () => {
    const text = `${"a".repeat(8)}\n${"b".repeat(8)}\n${"c".repeat(3)}`;
    expect(splitMessage(text, 10)).toEqual(["aaaaaaaa", "bbbbbbbb", "ccc"]);
    expect(splitMessage("x".repeat(25), 10)).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
  });
});

describe("formatApprovalPrompt", () => {
  const request: ApprovalRequest = {
    id: "a1",
    sessionKey: "web:1",
    windowLabel: "网页会话「整理」",
    toolName: "bash",
    summary: "ls",
    detail: "ls -la",
    createdAt: Date.UTC(2026, 9, 3, 6, 0),
    expiresAt: Date.UTC(2026, 9, 3, 6, 10),
  };

  it("names the source, tool, command and deadline", () => {
    expect(formatApprovalPrompt(request, 1, "Asia/Shanghai")).toBe(
      "【需要你批准】网页会话「整理」想执行 bash：\nls -la\n回复 /y 允许，/ya 本会话总是允许，/n 拒绝（14:10 前不回复将自动拒绝）",
    );
  });

  it("mentions the queue and truncates long details", () => {
    const text = formatApprovalPrompt({ ...request, detail: "x".repeat(2000) }, 3, "Asia/Shanghai");
    expect(text).toContain(`${"x".repeat(1500)}\n…（内容过长，完整内容请在网页查看）`);
    expect(text.endsWith("（共有 3 条待批准，按先后顺序处理）")).toBe(true);
    expect(text.length).toBeLessThan(2000);
  });

  it("formats clock times in 24-hour form", () => {
    expect(formatClock(Date.UTC(2026, 9, 3, 16, 5), "Asia/Shanghai")).toBe("00:05");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/wechat-messages.test.ts`
Expected: FAIL，无法解析 `../src/channels/wechat/messages.js`。

- [ ] **Step 3: 实现**

`src/channels/wechat/messages.ts`：

```ts
import type { ApprovalAnswer, ApprovalRequest } from "../../policy/approvals.js";
import type { InboundItem } from "./client.js";

export const MAX_MESSAGE_CHARS = 2000;
const MAX_APPROVAL_DETAIL_CHARS = 1500;

export type OwnerCommand =
  | { kind: "stop" }
  | { kind: "approve"; answer: ApprovalAnswer }
  | { kind: "chat"; text: string };

const COMMANDS: Record<string, OwnerCommand> = {
  "/stop": { kind: "stop" },
  "/y": { kind: "approve", answer: "allow" },
  "/ya": { kind: "approve", answer: "allow_session" },
  "/n": { kind: "approve", answer: "deny" },
};

export function extractText(items: InboundItem[]): string {
  const parts: string[] = [];
  for (const item of items) {
    switch (item.type) {
      case 1: {
        const text = item.text_item?.text ?? "";
        if (text.trim()) parts.push(text);
        break;
      }
      case 2:
        parts.push("[图片]");
        break;
      case 3: {
        const text = item.voice_item?.text ?? "";
        parts.push(text.trim() ? text : "[语音]");
        break;
      }
      case 4:
        parts.push("[文件]");
        break;
      case 5:
        parts.push("[视频]");
        break;
      default:
        break;
    }
  }
  return parts.join("\n").trim();
}

export function parseCommand(text: string): OwnerCommand {
  // Chinese input methods often produce a full-width slash.
  const normalized = text.trim().replace(/^／/, "/").toLowerCase();
  return COMMANDS[normalized] ?? { kind: "chat", text };
}

export function splitMessage(text: string, max = MAX_MESSAGE_CHARS): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const newline = rest.lastIndexOf("\n", max);
    const cut = newline > max / 2 ? newline : max;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export function formatClock(ms: number, timeZone?: string): string {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(ms);
}

export function formatApprovalPrompt(request: ApprovalRequest, pendingCount: number, timeZone?: string): string {
  const detail =
    request.detail.length > MAX_APPROVAL_DETAIL_CHARS
      ? `${request.detail.slice(0, MAX_APPROVAL_DETAIL_CHARS)}\n…（内容过长，完整内容请在网页查看）`
      : request.detail;
  const lines = [
    `【需要你批准】${request.windowLabel}想执行 ${request.toolName}：`,
    detail,
    `回复 /y 允许，/ya 本会话总是允许，/n 拒绝（${formatClock(request.expiresAt, timeZone)} 前不回复将自动拒绝）`,
  ];
  if (pendingCount > 1) lines.push(`（共有 ${pendingCount} 条待批准，按先后顺序处理）`);
  return lines.join("\n");
}
```

- [ ] **Step 4: 运行测试与类型检查**

Run: `npx vitest run tests/wechat-messages.test.ts && npm run lint && npm test`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/channels/wechat/messages.ts tests/wechat-messages.test.ts
git commit -m "feat: wechat text extraction, owner commands, splitting and approval prompts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 扫码登录、`vex wechat login` 与 onboard 绑定

**Files:**
- Modify: `package.json`、`package-lock.json`（通过 npm 安装依赖）
- Create: `src/channels/wechat/login.ts`, `src/cli/wechat.ts`
- Modify: `src/cli/index.ts`, `src/cli/onboard.ts`, `tests/onboard.test.ts`
- Test: `tests/wechat-login.test.ts`

**Interfaces:**
- Consumes: `WeChatClient`（Task 2）、`WeChatStore`（Task 1）、`FakeIlink`（Task 2）
- Produces:
  - `interface LoginResult { token: string; accountId: string; baseUrl?: string; userId?: string }`
  - `interface LoginOptions { pollIntervalMs?: number; maxQrRefreshes?: number; maxConsecutiveErrors?: number; botType?: string }`（默认 1500 毫秒、3 次、5 次、`"3"`）
  - `class WeChatLoginError extends Error`
  - `loginWithQr(client: WeChatClient, print: (text: string) => void, opts?: LoginOptions): Promise<LoginResult>`
  - `runWeChatLogin(print: (text: string) => void, paths: VexPaths, opts?: LoginOptions & { baseUrl?: string; restartHint?: boolean }): Promise<void>`
  - `runOnboard(io, paths, opts: { force: boolean; login?: LoginOptions & { baseUrl?: string } })`

登录流程：取二维码并在终端渲染（`qrcode` 的 `toString(url, { type: "terminal", small: true })`），轮询状态。`confirmed` 返回结果，`expired` 刷新二维码（最多 3 次），`cancelled` 报错，连续 5 次请求失败报错，单次失败等待后重试。登录成功后保存登录态，提示主人是谁；拿不到扫码人 id 且没配 `wechat.ownerId` 时给出警告；从 `vex wechat login` 调用时提示重启 vexd。onboard 最后询问“现在扫码绑定微信吗？（y/N）”。

- [ ] **Step 1: 安装依赖**

Run: `npm install qrcode@^1.5.4 && npm install -D @types/qrcode@^1.5.6`
Expected: `package.json` 的 dependencies 出现 `"qrcode": "^1.5.4"`，devDependencies 出现 `"@types/qrcode": "^1.5.6"`。

- [ ] **Step 2: 写失败的测试**

`tests/wechat-login.test.ts`：

```ts
import { stat, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WeChatClient } from "../src/channels/wechat/client.js";
import { loginWithQr, WeChatLoginError } from "../src/channels/wechat/login.js";
import { WeChatStore } from "../src/channels/wechat/store.js";
import { runWeChatLogin } from "../src/cli/wechat.js";
import { resolvePaths, type VexPaths } from "../src/paths.js";
import { FakeIlink } from "./helpers/ilink.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

let ilink: FakeIlink;
let dir: string;
let paths: VexPaths;
let qrCount: number;

beforeEach(async () => {
  ilink = new FakeIlink();
  await ilink.start();
  dir = await makeTmpDir();
  paths = resolvePaths(dir);
  qrCount = 0;
  ilink.on("/ilink/bot/get_bot_qrcode", () => {
    qrCount++;
    return { qrcode: `q${qrCount}`, qrcode_img_content: `https://login.example/q${qrCount}` };
  });
});
afterEach(async () => {
  await ilink.stop();
  await removeTmpDir(dir);
});

function statuses(...list: unknown[]): void {
  ilink.on("/ilink/bot/get_qrcode_status", () => list.shift() ?? { status: "wait" });
}

const confirmed = { status: "confirmed", bot_token: "tok", ilink_bot_id: "bot1", baseurl: "https://api2.example", ilink_user_id: "owner1" };

describe("loginWithQr", () => {
  it("shows a QR code and waits for confirmation", async () => {
    statuses({ status: "wait" }, { status: "scaned" }, confirmed);
    const output: string[] = [];
    const result = await loginWithQr(new WeChatClient({ baseUrl: ilink.baseUrl }), (t) => output.push(t), { pollIntervalMs: 1 });
    expect(result).toEqual({ token: "tok", accountId: "bot1", baseUrl: "https://api2.example", userId: "owner1" });
    expect(output[0]).toBe("用手机微信扫描下面的二维码登录：");
    expect(output[1]).toContain("▄");
  });

  it("refreshes an expired QR code", async () => {
    statuses({ status: "expired" }, confirmed);
    const output: string[] = [];
    await loginWithQr(new WeChatClient({ baseUrl: ilink.baseUrl }), (t) => output.push(t), { pollIntervalMs: 1 });
    expect(qrCount).toBe(2);
    expect(output).toContain("二维码已过期，正在刷新…");
  });

  it("gives up after repeated expiry, cancellation or persistent errors", async () => {
    const client = new WeChatClient({ baseUrl: ilink.baseUrl });
    statuses({ status: "expired" }, { status: "expired" });
    await expect(loginWithQr(client, () => {}, { pollIntervalMs: 1, maxQrRefreshes: 2 })).rejects.toThrow(WeChatLoginError);
    statuses({ status: "cancel" });
    await expect(loginWithQr(client, () => {}, { pollIntervalMs: 1 })).rejects.toThrow(/取消/);
    ilink.on("/ilink/bot/get_qrcode_status", () => 500);
    await expect(loginWithQr(client, () => {}, { pollIntervalMs: 1, maxConsecutiveErrors: 2 })).rejects.toThrow(/HTTP 500/);
  });

  it("rides out a transient polling error", async () => {
    const responses: unknown[] = [500, confirmed];
    ilink.on("/ilink/bot/get_qrcode_status", () => responses.shift());
    await expect(loginWithQr(new WeChatClient({ baseUrl: ilink.baseUrl }), () => {}, { pollIntervalMs: 1 })).resolves.toMatchObject({ token: "tok" });
  });
});

describe("runWeChatLogin", () => {
  it("saves owner-only credentials and explains the next step", async () => {
    await writeFile(paths.config, `model: { provider: deepseek, id: deepseek-v4-pro }\nwechat: { baseUrl: "${ilink.baseUrl}" }\n`, "utf8");
    statuses(confirmed);
    const output: string[] = [];
    await runWeChatLogin((t) => output.push(t), paths, { pollIntervalMs: 1 });
    const store = new WeChatStore(paths.wechat);
    expect(await store.loadCredentials()).toEqual({ token: "tok", accountId: "bot1", baseUrl: "https://api2.example", userId: "owner1" });
    expect((await stat(store.credentialsFile)).mode & 0o777).toBe(0o600);
    expect(output).toContain("已绑定微信，主人是扫码的这个微信号（owner1）。");
    expect(output.at(-1)).toBe("重启 vexd 后生效：vex stop && vex start -d");
  });

  it("warns when the scanner id is missing and no owner is configured", async () => {
    await writeFile(paths.config, `model: { provider: deepseek, id: deepseek-v4-pro }\nwechat: { baseUrl: "${ilink.baseUrl}" }\n`, "utf8");
    statuses({ status: "confirmed", bot_token: "tok" });
    const output: string[] = [];
    await runWeChatLogin((t) => output.push(t), paths, { pollIntervalMs: 1 });
    expect(output.some((line) => line.includes("wechat.ownerId"))).toBe(true);
    expect((await new WeChatStore(paths.wechat).loadCredentials())?.baseUrl).toBe(ilink.baseUrl);
  });
});
```

把 `tests/onboard.test.ts` 替换为以下完整内容。新增“当场绑定微信”的测试；原有两个用例在答案列表末尾补上对绑定问题的回答（空或 `n`）。

`tests/onboard.test.ts`：

```ts
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WeChatStore } from "../src/channels/wechat/store.js";
import { runOnboard, type OnboardIO } from "../src/cli/onboard.js";
import { loadConfig } from "../src/config/load.js";
import { resolvePaths, type VexPaths } from "../src/paths.js";
import { FakeIlink } from "./helpers/ilink.js";
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
    const io = scripted(["9", "1", "1", "", "sk-test", "", ""]);
    expect(await runOnboard(io, paths, { force: false })).toBe(true);
    const { config } = await loadConfig(paths);
    expect(config.model).toEqual({ provider: "deepseek", id: getBuiltinModels("deepseek")[0]!.id });
    expect(config.providers.deepseek?.apiKey).toBe("sk-test");
    expect(config.web.port).toBe(7860);
    expect((await stat(join(dir, "workspace", "SOUL.md"))).isFile()).toBe(true);
    expect(io.output).toContain("请输入 1 到 8 之间的编号");
    expect(io.output).toContain("API key 不能为空");
  });

  it("links WeChat right away when asked", async () => {
    const ilink = new FakeIlink();
    await ilink.start();
    try {
      ilink.on("/ilink/bot/get_bot_qrcode", () => ({ qrcode: "q1", qrcode_img_content: "https://login.example/q1" }));
      ilink.on("/ilink/bot/get_qrcode_status", () => ({ status: "confirmed", bot_token: "tok", ilink_bot_id: "bot1", ilink_user_id: "owner1" }));
      const io = scripted(["1", "1", "sk-test", "", "y"]);
      expect(await runOnboard(io, paths, { force: false, login: { baseUrl: ilink.baseUrl, pollIntervalMs: 1 } })).toBe(true);
      expect((await new WeChatStore(paths.wechat).loadCredentials())?.userId).toBe("owner1");
      expect(io.output).toContain("已绑定微信，主人是扫码的这个微信号（owner1）。");
      expect(io.output.at(-1)).toBe("运行 vex start 启动");
      expect(io.output.some((line) => line.includes("重启 vexd"))).toBe(false);
    } finally {
      await ilink.stop();
    }
  });

  it("configures a custom provider", async () => {
    const io = scripted(["8", "stepfun", "1", "https://api.stepfun.com/v1", "step-2-16k", "", "abc", "8000", "n"]);
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

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run tests/wechat-login.test.ts tests/onboard.test.ts`
Expected: FAIL：wechat-login 测试无法解析 `../src/channels/wechat/login.js`；onboard 的“当场绑定微信”用例失败（还没有绑定步骤）。

- [ ] **Step 4: 实现**

`src/channels/wechat/login.ts`：

```ts
import { setTimeout as delay } from "node:timers/promises";
import { toString as renderQr } from "qrcode";
import type { WeChatClient } from "./client.js";

export interface LoginResult {
  token: string;
  accountId: string;
  baseUrl?: string;
  userId?: string;
}

export interface LoginOptions {
  pollIntervalMs?: number;
  maxQrRefreshes?: number;
  maxConsecutiveErrors?: number;
  botType?: string;
}

export class WeChatLoginError extends Error {}

export async function loginWithQr(
  client: WeChatClient,
  print: (text: string) => void,
  opts: LoginOptions = {},
): Promise<LoginResult> {
  const pollIntervalMs = opts.pollIntervalMs ?? 1500;
  const maxQrRefreshes = opts.maxQrRefreshes ?? 3;
  const maxConsecutiveErrors = opts.maxConsecutiveErrors ?? 5;

  for (let attempt = 1; attempt <= maxQrRefreshes; attempt++) {
    const qr = await client.getQrCode(opts.botType);
    print("用手机微信扫描下面的二维码登录：");
    print(await renderQr(qr.url, { type: "terminal", small: true }));

    let errors = 0;
    for (;;) {
      let status;
      try {
        status = await client.getQrStatus(qr.qrcode);
        errors = 0;
      } catch (err) {
        errors++;
        if (errors >= maxConsecutiveErrors) throw err;
        await delay(pollIntervalMs);
        continue;
      }
      if (status.status === "confirmed") {
        return { token: status.token, accountId: status.accountId, baseUrl: status.baseUrl, userId: status.userId };
      }
      if (status.status === "cancelled") throw new WeChatLoginError("已在手机上取消登录");
      if (status.status === "expired") {
        if (attempt < maxQrRefreshes) print("二维码已过期，正在刷新…");
        break;
      }
      await delay(pollIntervalMs);
    }
  }
  throw new WeChatLoginError(`二维码连续 ${maxQrRefreshes} 次过期，登录失败`);
}
```

`src/cli/wechat.ts`：

```ts
import { WeChatClient } from "../channels/wechat/client.js";
import { loginWithQr, type LoginOptions } from "../channels/wechat/login.js";
import { WeChatStore } from "../channels/wechat/store.js";
import { loadConfig } from "../config/load.js";
import type { VexPaths } from "../paths.js";

export async function runWeChatLogin(
  print: (text: string) => void,
  paths: VexPaths,
  opts: LoginOptions & { baseUrl?: string; restartHint?: boolean } = {},
): Promise<void> {
  const { config } = await loadConfig(paths);
  const baseUrl = opts.baseUrl ?? config.wechat.baseUrl;
  const client = new WeChatClient({ baseUrl });
  const result = await loginWithQr(client, print, opts);
  await new WeChatStore(paths.wechat).saveCredentials({
    token: result.token,
    accountId: result.accountId,
    baseUrl: result.baseUrl ?? baseUrl,
    userId: result.userId,
  });
  print(result.userId ? `已绑定微信，主人是扫码的这个微信号（${result.userId}）。` : "已绑定微信。");
  if (!result.userId && !config.wechat.ownerId) {
    print("没有拿到扫码人的微信 id：请在 config.yaml 中设置 wechat.ownerId，否则 vexd 不会回复任何微信消息。");
  }
  if (opts.restartHint !== false) print("重启 vexd 后生效：vex stop && vex start -d");
}
```

把 `src/cli/index.ts` 与 `src/cli/onboard.ts` 替换为以下完整内容（index 新增 `wechat login` 子命令与用法行；onboard 结尾新增绑定询问）。

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
import { runWeChatLogin } from "./wechat.js";

const USAGE = [
  "用法：vex <命令>",
  "  start [-d]          启动 vexd（-d 在后台运行）",
  "  stop                停止后台运行的 vexd",
  "  status              查看运行状态",
  "  logs [-f]           查看日志（-f 持续输出）",
  "  onboard [--force]   生成初始配置",
  "  wechat login        扫码绑定微信",
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
    case "wechat":
      if (rest[0] === "login") {
        await runWeChatLogin((text) => console.log(text), paths);
        return 0;
      }
      console.log(USAGE);
      return 1;
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
    let stopping = false;
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      void daemon
        .stop()
        .then(() => removePid(paths.pidFile))
        .catch((err: unknown) => log.error({ err }, "shutdown failed"))
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
  const started = await waitUntil(async () => (await runningPid(paths)) === child.pid, 15_000);
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
  const stopped = await waitUntil(async () => (await runningPid(paths)) !== pid, 10_000);
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

`src/cli/onboard.ts`：

```ts
import { access } from "node:fs/promises";
import { getBuiltinModels, getBuiltinProviders, type BuiltinProvider } from "@earendil-works/pi-ai/providers/all";
import { stringify } from "yaml";
import { loadConfig, saveConfigText } from "../config/load.js";
import type { VexPaths } from "../paths.js";
import type { LoginOptions } from "../channels/wechat/login.js";
import { ensureWorkspace } from "../workspace/workspace.js";
import { runWeChatLogin } from "./wechat.js";

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

export async function runOnboard(
  io: OnboardIO,
  paths: VexPaths,
  opts: { force: boolean; login?: LoginOptions & { baseUrl?: string } },
): Promise<boolean> {
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
  const linkNow = (await io.ask("现在扫码绑定微信吗？（y/N）：")).trim().toLowerCase();
  if (linkNow === "y" || linkNow === "yes") {
    await runWeChatLogin((text) => io.print(text), paths, { ...opts.login, restartHint: false });
  } else {
    io.print("之后可以运行 vex wechat login 扫码绑定微信");
  }
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

- [ ] **Step 5: 运行测试与类型检查**

Run: `npx vitest run tests/wechat-login.test.ts tests/onboard.test.ts && npm run lint && npm test`
Expected: 全部 PASS。

- [ ] **Step 6: 提交**

```bash
git add package.json package-lock.json src/channels/wechat/login.ts src/cli tests/wechat-login.test.ts tests/onboard.test.ts
git commit -m "feat: wechat QR login via vex wechat login and onboard

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: WeChatChannel

**Files:**
- Create: `src/channels/wechat/channel.ts`
- Test: `tests/wechat-channel.test.ts`

**Interfaces:**
- Consumes: `WeChatClient`、`WeChatApiError`、`SESSION_EXPIRED_ERRCODE`（Task 2）、`WeChatStore`（Task 1）、`messages.ts`（Task 3）、`EventBus`、`SessionEvent`、`VexEvent`、`WECHAT_SESSION_KEY`、`ApprovalManager`
- Produces:
  - `interface WeChatSessions { get(key: string): Promise<{ send(text: string): void; stop(): void; readonly busy: boolean }> }`（`SessionManager` 满足此接口）
  - `interface WeChatChannelOptions { client: Pick<WeChatClient, "getUpdates" | "sendText">; store; ownerId: string; sessions: WeChatSessions; approvals; bus; log; idleDelayMs?; initialBackoffMs?; maxBackoffMs?; processingNoticeMs?; timeZone? }`（默认 1000 毫秒、1000 毫秒、60000 毫秒、15000 毫秒）
  - `class WeChatChannel { constructor(opts); readonly expired: boolean; start(): Promise<void>; stop(): Promise<void>; drained(): Promise<void> }`

行为（spec §5、§6.1–6.2、§7.3、§15）：
- **收消息：**
  - 长轮询收到空批时等待 `idleDelayMs` 再拉，有消息时立即再拉。
  - 失败时按 1 秒起、最长 60 秒指数退避。
  - `errcode -14` 时停止轮询，把 `expired` 置为 true，并记录日志。
  - `stop()` 会中断进行中的长轮询。
- **入站处理：**
  - 非主人的消息忽略。同一消息 id 只处理一次（记住最近 500 个）。
  - 主人消息带来新的上下文 token 时保存到 `state.json`。
  - `/stop`：会话运行中就中断，空闲时回“现在没有在运行的任务。”。
  - `/y` `/ya` `/n`：答复最早的一条待审批请求，回“已允许：工具”“已允许，本会话之后不再询问 工具”或“已拒绝：工具”；没有待审批时回“没有待批准的请求。”。
  - 其余文字交给 `wechat` 会话。
- **出站：**
  - `busy: true` 开始一轮，超过 `processingNoticeMs` 仍未结束就发“处理中…”。
  - 一轮内的助手文字与错误按顺序收集，`busy: false` 时用空行连接成一条发出。
  - 被中断的一轮在末尾加“（已中断）”，没有文字时发“已中断。”。
  - 每条新的待审批请求（任何窗口发起的）都推送一次审批提示。
  - 发送按顺序排队，单条失败只记日志。
  - 还没有上下文 token 时（主人从未发过消息）不发送，只记日志。

- [ ] **Step 1: 写失败的测试**

`tests/wechat-channel.test.ts`：

```ts
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WeChatChannel, type WeChatChannelOptions } from "../src/channels/wechat/channel.js";
import { WeChatClient } from "../src/channels/wechat/client.js";
import { WeChatStore } from "../src/channels/wechat/store.js";
import { EventBus, type SessionEvent } from "../src/core/events.js";
import { ApprovalManager } from "../src/policy/approvals.js";
import { FakeIlink, textMessage } from "./helpers/ilink.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

class FakeSession {
  busy = false;
  readonly sent: string[] = [];
  stops = 0;
  send(text: string): void {
    this.sent.push(text);
  }
  stop(): void {
    this.stops++;
  }
}

let ilink: FakeIlink;
let dir: string;
let store: WeChatStore;
let bus: EventBus;
let approvals: ApprovalManager;
let session: FakeSession;
let keys: string[];
let channel: WeChatChannel | undefined;

beforeEach(async () => {
  ilink = new FakeIlink();
  await ilink.start();
  dir = await makeTmpDir();
  store = new WeChatStore(join(dir, "wechat"));
  bus = new EventBus();
  approvals = new ApprovalManager({ onChange: () => bus.emit({ type: "approvals_changed" }) });
  session = new FakeSession();
  keys = [];
});
afterEach(async () => {
  await channel?.stop();
  channel = undefined;
  approvals.dispose();
  await ilink.stop();
  await removeTmpDir(dir);
});

async function startChannel(overrides: Partial<WeChatChannelOptions> = {}): Promise<WeChatChannel> {
  channel = new WeChatChannel({
    client: new WeChatClient({ baseUrl: ilink.baseUrl, token: "tok" }),
    store,
    ownerId: "owner1",
    sessions: {
      get: async (key) => {
        keys.push(key);
        return session;
      },
    },
    approvals,
    bus,
    log: pino({ level: "silent" }),
    idleDelayMs: 5,
    initialBackoffMs: 5,
    processingNoticeMs: 40,
    timeZone: "Asia/Shanghai",
    ...overrides,
  });
  await channel.start();
  return channel;
}

function emit(event: SessionEvent): void {
  bus.emit({ type: "session", sessionKey: "wechat", event });
}

async function sentTexts(): Promise<string[]> {
  await channel?.drained();
  return ilink.sentTexts();
}

describe("WeChatChannel inbound", () => {
  it("passes owner messages to the wechat session and ignores everyone else", async () => {
    ilink.queueUpdates(
      textMessage("owner1", "你好", { message_id: "m1" }),
      textMessage("stranger", "hi", { message_id: "m2" }),
      textMessage("owner1", "你好", { message_id: "m1" }),
    );
    ilink.queueUpdates(textMessage("owner1", "第二句", { message_id: "m3" }));
    await startChannel();
    await vi.waitFor(() => expect(session.sent).toEqual(["你好", "第二句"]));
    expect(keys.every((k) => k === "wechat")).toBe(true);
    expect(await store.loadState()).toEqual({ contextToken: "ctx-owner1" });
  });

  it("stops a running turn on /stop and says so when idle", async () => {
    ilink.queueUpdates(textMessage("owner1", "/stop", { message_id: "s1" }));
    session.busy = true;
    await startChannel();
    await vi.waitFor(() => expect(session.stops).toBe(1));
    session.busy = false;
    ilink.queueUpdates(textMessage("owner1", "／stop", { message_id: "s2" }));
    await vi.waitFor(async () => expect(await sentTexts()).toEqual(["现在没有在运行的任务。"]));
    expect(session.stops).toBe(1);
    expect(session.sent).toEqual([]);
  });
});

describe("WeChatChannel outbound", () => {
  it("sends one reply per turn using the saved context token", async () => {
    await store.saveState({ contextToken: "ctx-saved" });
    await startChannel({ processingNoticeMs: 60_000 });
    emit({ kind: "busy", busy: true });
    emit({ kind: "assistant_message", text: "第一段", stopReason: "toolUse", timestamp: 1 });
    emit({ kind: "assistant_message", text: "第二段", stopReason: "stop", timestamp: 2 });
    emit({ kind: "busy", busy: false });
    expect(await sentTexts()).toEqual(["第一段\n\n第二段"]);
    const body = ilink.requests.find((r) => r.path === "/ilink/bot/sendmessage")?.body as { msg: Record<string, unknown> };
    expect(body.msg).toMatchObject({ to_user_id: "owner1", context_token: "ctx-saved" });
  });

  it("tells the owner a long turn is still running", async () => {
    await store.saveState({ contextToken: "ctx" });
    await startChannel({ processingNoticeMs: 30 });
    emit({ kind: "busy", busy: true });
    await vi.waitFor(async () => expect(await sentTexts()).toEqual(["处理中…"]));
    emit({ kind: "assistant_message", text: "好了", stopReason: "stop", timestamp: 1 });
    emit({ kind: "busy", busy: false });
    expect(await sentTexts()).toEqual(["处理中…", "好了"]);
  });

  it("marks interrupted turns and reports errors", async () => {
    await store.saveState({ contextToken: "ctx" });
    await startChannel({ processingNoticeMs: 60_000 });
    emit({ kind: "busy", busy: true });
    emit({ kind: "assistant_message", text: "写到一半", stopReason: "aborted", timestamp: 1 });
    emit({ kind: "busy", busy: false });
    emit({ kind: "busy", busy: true });
    emit({ kind: "assistant_message", text: "", stopReason: "aborted", timestamp: 2 });
    emit({ kind: "busy", busy: false });
    emit({ kind: "busy", busy: true });
    emit({ kind: "error", message: "模型调用失败：boom" });
    emit({ kind: "busy", busy: false });
    expect(await sentTexts()).toEqual(["写到一半\n（已中断）", "已中断。", "模型调用失败：boom"]);
  });

  it("splits long replies", async () => {
    await store.saveState({ contextToken: "ctx" });
    await startChannel({ processingNoticeMs: 60_000 });
    emit({ kind: "busy", busy: true });
    emit({ kind: "assistant_message", text: "字".repeat(4500), stopReason: "stop", timestamp: 1 });
    emit({ kind: "busy", busy: false });
    expect((await sentTexts()).map((t) => t.length)).toEqual([2000, 2000, 500]);
  });

  it("drops outgoing messages until the owner has written once", async () => {
    await startChannel({ processingNoticeMs: 60_000 });
    emit({ kind: "busy", busy: true });
    emit({ kind: "assistant_message", text: "没人收", stopReason: "stop", timestamp: 1 });
    emit({ kind: "busy", busy: false });
    expect(await sentTexts()).toEqual([]);
  });
});

describe("WeChatChannel approvals", () => {
  it("announces pending approvals and answers the oldest one", async () => {
    await store.saveState({ contextToken: "ctx" });
    await startChannel();
    const first = approvals.request({ sessionKey: "web:1", windowLabel: "网页会话「A」", toolName: "bash", args: { command: "ls" } });
    const second = approvals.request({ sessionKey: "wechat", windowLabel: "微信", toolName: "write", args: { path: "/etc/x" } });
    await vi.waitFor(async () => expect(await sentTexts()).toHaveLength(2));
    const [promptA, promptB] = await sentTexts();
    expect(promptA).toContain("【需要你批准】网页会话「A」想执行 bash：\nls");
    expect(promptB).toContain("（共有 2 条待批准，按先后顺序处理）");

    ilink.queueUpdates(textMessage("owner1", "/y", { message_id: "a1" }));
    await expect(first).resolves.toEqual({ allowed: true });
    ilink.queueUpdates(textMessage("owner1", "/n", { message_id: "a2" }));
    await expect(second).resolves.toMatchObject({ allowed: false });
    ilink.queueUpdates(textMessage("owner1", "/ya", { message_id: "a3" }));
    await vi.waitFor(async () => expect((await sentTexts()).slice(2)).toEqual(["已允许：bash", "已拒绝：write", "没有待批准的请求。"]));
    expect(session.sent).toEqual([]);
  });

  it("remembers allow_session from /ya", async () => {
    await store.saveState({ contextToken: "ctx" });
    await startChannel();
    const pending = approvals.request({ sessionKey: "wechat", windowLabel: "微信", toolName: "bash", args: { command: "pwd" } });
    ilink.queueUpdates(textMessage("owner1", "/ya", { message_id: "b1" }));
    await expect(pending).resolves.toEqual({ allowed: true });
    expect(approvals.isSessionAllowed("wechat", "bash")).toBe(true);
    await vi.waitFor(async () => expect(await sentTexts()).toContain("已允许，本会话之后不再询问 bash"));
  });
});

describe("WeChatChannel polling", () => {
  it("recovers from a transient failure", async () => {
    const responses: unknown[] = [502, { ret: 0, msgs: [textMessage("owner1", "恢复了", { message_id: "r1" })] }];
    ilink.on("/ilink/bot/getupdates", () => responses.shift() ?? { ret: 0, msgs: [] });
    await startChannel();
    await vi.waitFor(() => expect(session.sent).toEqual(["恢复了"]));
    expect(channel?.expired).toBe(false);
  });

  it("stops polling when the login has expired", async () => {
    ilink.on("/ilink/bot/getupdates", () => ({ ret: 0, errcode: -14, errmsg: "session timeout" }));
    await startChannel();
    await vi.waitFor(() => expect(channel?.expired).toBe(true));
    const count = ilink.requests.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(ilink.requests.length).toBe(count);
  });

  it("stops promptly while a long poll is in flight", async () => {
    ilink.on("/ilink/bot/getupdates", () => new Promise(() => {}));
    await startChannel();
    await vi.waitFor(() => expect(ilink.requests.length).toBe(1));
    const started = Date.now();
    await channel?.stop();
    channel = undefined;
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/wechat-channel.test.ts`
Expected: FAIL，无法解析 `../src/channels/wechat/channel.js`。

- [ ] **Step 3: 实现**

`src/channels/wechat/channel.ts`：

```ts
import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "pino";
import type { EventBus, SessionEvent, VexEvent } from "../../core/events.js";
import { WECHAT_SESSION_KEY } from "../../core/sessionManager.js";
import type { ApprovalAnswer, ApprovalManager } from "../../policy/approvals.js";
import { SESSION_EXPIRED_ERRCODE, WeChatApiError, type InboundMessage, type WeChatClient } from "./client.js";
import { extractText, formatApprovalPrompt, parseCommand, splitMessage } from "./messages.js";
import type { WeChatStore } from "./store.js";

export interface WeChatSessions {
  get(key: string): Promise<{ send(text: string): void; stop(): void; readonly busy: boolean }>;
}

export interface WeChatChannelOptions {
  client: Pick<WeChatClient, "getUpdates" | "sendText">;
  store: WeChatStore;
  ownerId: string;
  sessions: WeChatSessions;
  approvals: ApprovalManager;
  bus: EventBus;
  log: Logger;
  idleDelayMs?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  processingNoticeMs?: number;
  timeZone?: string;
}

interface Turn {
  texts: string[];
  aborted: boolean;
  timer: ReturnType<typeof setTimeout>;
}

const SEEN_LIMIT = 500;

const ANSWER_REPLIES: Record<ApprovalAnswer, (tool: string) => string> = {
  allow: (tool) => `已允许：${tool}`,
  allow_session: (tool) => `已允许，本会话之后不再询问 ${tool}`,
  deny: (tool) => `已拒绝：${tool}`,
};

export class WeChatChannel {
  private readonly abort = new AbortController();
  private readonly seen = new Set<string>();
  private readonly announced = new Set<string>();
  private contextToken: string | undefined;
  private turn: Turn | undefined;
  private outbox: Promise<void> = Promise.resolve();
  private loop: Promise<void> | undefined;
  private unsubscribe: (() => void) | undefined;
  private sessionExpired = false;

  constructor(private readonly opts: WeChatChannelOptions) {}

  get expired(): boolean {
    return this.sessionExpired;
  }

  async start(): Promise<void> {
    this.contextToken = (await this.opts.store.loadState()).contextToken;
    this.unsubscribe = this.opts.bus.on((event) => this.onBusEvent(event));
    this.loop = this.pollLoop();
  }

  async stop(): Promise<void> {
    this.abort.abort();
    this.unsubscribe?.();
    if (this.turn) clearTimeout(this.turn.timer);
    this.turn = undefined;
    await this.loop;
    await this.outbox;
  }

  /** Resolves once every queued outgoing message has been attempted. */
  drained(): Promise<void> {
    return this.outbox;
  }

  private async pollLoop(): Promise<void> {
    const initialBackoff = this.opts.initialBackoffMs ?? 1000;
    const maxBackoff = this.opts.maxBackoffMs ?? 60_000;
    let backoff = initialBackoff;
    while (!this.abort.signal.aborted) {
      try {
        const messages = await this.opts.client.getUpdates(this.abort.signal);
        backoff = initialBackoff;
        for (const message of messages) await this.handleInbound(message);
        if (messages.length === 0) await this.sleep(this.opts.idleDelayMs ?? 1000);
      } catch (err) {
        if (this.abort.signal.aborted) return;
        if (err instanceof WeChatApiError && err.errcode === SESSION_EXPIRED_ERRCODE) {
          this.sessionExpired = true;
          this.opts.log.error("微信登录已失效，运行 vex wechat login 重新登录后重启 vexd");
          return;
        }
        this.opts.log.warn({ err }, "wechat poll failed");
        await this.sleep(backoff);
        backoff = Math.min(backoff * 2, maxBackoff);
      }
    }
  }

  private async handleInbound(message: InboundMessage): Promise<void> {
    if (message.fromUserId !== this.opts.ownerId) {
      this.opts.log.debug({ from: message.fromUserId }, "ignored wechat message from non-owner");
      return;
    }
    if (this.seen.has(message.messageId)) return;
    this.seen.add(message.messageId);
    if (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.values().next().value as string);

    if (message.contextToken && message.contextToken !== this.contextToken) {
      this.contextToken = message.contextToken;
      await this.opts.store
        .saveState({ contextToken: message.contextToken })
        .catch((err: unknown) => this.opts.log.warn({ err }, "failed to save wechat state"));
    }

    const text = extractText(message.items);
    if (!text) return;
    const command = parseCommand(text);
    if (command.kind === "approve") {
      this.answerOldest(command.answer);
      return;
    }
    const session = await this.opts.sessions.get(WECHAT_SESSION_KEY);
    if (command.kind === "stop") {
      if (session.busy) session.stop();
      else this.send("现在没有在运行的任务。");
      return;
    }
    session.send(command.text);
  }

  private answerOldest(answer: ApprovalAnswer): void {
    const oldest = this.opts.approvals.pending()[0];
    if (!oldest) {
      this.send("没有待批准的请求。");
      return;
    }
    this.opts.approvals.answer(oldest.id, answer);
    this.send(ANSWER_REPLIES[answer](oldest.toolName));
  }

  private onBusEvent(event: VexEvent): void {
    if (event.type === "approvals_changed") {
      this.announceApprovals();
    } else if (event.type === "session" && event.sessionKey === WECHAT_SESSION_KEY) {
      this.onSessionEvent(event.event);
    }
  }

  private announceApprovals(): void {
    const pending = this.opts.approvals.pending();
    const ids = new Set(pending.map((p) => p.id));
    for (const id of this.announced) if (!ids.has(id)) this.announced.delete(id);
    for (const request of pending) {
      if (this.announced.has(request.id)) continue;
      this.announced.add(request.id);
      this.send(formatApprovalPrompt(request, pending.length, this.opts.timeZone));
    }
  }

  private onSessionEvent(event: SessionEvent): void {
    switch (event.kind) {
      case "busy":
        if (event.busy) this.beginTurn();
        else this.endTurn();
        return;
      case "assistant_message":
        if (!this.turn) {
          if (event.text) this.send(event.text);
          return;
        }
        if (event.text) this.turn.texts.push(event.text);
        if (event.stopReason === "aborted") this.turn.aborted = true;
        return;
      case "error":
        if (this.turn) this.turn.texts.push(event.message);
        else this.send(event.message);
        return;
      default:
        return;
    }
  }

  private beginTurn(): void {
    if (this.turn) clearTimeout(this.turn.timer);
    const timer = setTimeout(() => {
      if (this.turn?.timer === timer) this.send("处理中…");
    }, this.opts.processingNoticeMs ?? 15_000);
    this.turn = { texts: [], aborted: false, timer };
  }

  private endTurn(): void {
    const turn = this.turn;
    if (!turn) return;
    clearTimeout(turn.timer);
    this.turn = undefined;
    const reply = turn.texts.join("\n\n");
    if (turn.aborted) this.send(reply ? `${reply}\n（已中断）` : "已中断。");
    else if (reply) this.send(reply);
  }

  private send(text: string): void {
    const chunks = splitMessage(text);
    this.outbox = this.outbox.then(async () => {
      const contextToken = this.contextToken;
      if (!contextToken) {
        this.opts.log.warn("no wechat context token yet; the owner has to message the bot first");
        return;
      }
      for (const chunk of chunks) {
        try {
          await this.opts.client.sendText(this.opts.ownerId, contextToken, chunk);
        } catch (err) {
          this.opts.log.warn({ err }, "failed to send wechat message");
          return;
        }
      }
    });
  }

  private async sleep(ms: number): Promise<void> {
    await delay(ms, undefined, { signal: this.abort.signal }).catch(() => {});
  }
}
```

- [ ] **Step 4: 运行测试与类型检查**

Run: `npx vitest run tests/wechat-channel.test.ts && npm run lint && npm test`
Expected: 全部 PASS。这组测试依赖真实计时，提交前再单独运行 3 次 `npx vitest run tests/wechat-channel.test.ts` 确认稳定。

- [ ] **Step 5: 提交**

```bash
git add src/channels/wechat/channel.ts tests/wechat-channel.test.ts
git commit -m "feat: wechat channel with owner filter, commands, turn replies and approvals

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: 接入 vexd 与端到端验证

**Files:**
- Create: `src/channels/wechat/setup.ts`
- Modify: `src/daemon.ts`
- Test: `tests/daemon-wechat.test.ts`

**Interfaces:**
- Consumes: Task 1–5 全部
- Produces: `startWeChatChannel(opts: { config: VexConfig; paths: VexPaths; sessions: WeChatSessions; approvals: ApprovalManager; bus: EventBus; log: Logger }): Promise<WeChatChannel | undefined>`

规则：
- `wechat.enabled` 为 false、没有登录态、或者既没配 `wechat.ownerId` 也没有扫码人 id 时，不接入微信，只记日志，vexd 照常运行。
- 接入时使用登录态里的 `baseUrl` 与 token。
- vexd 在 HTTP 服务启动后接入微信；关闭时最先停止微信，再关闭会话、审批与 HTTP 服务。

- [ ] **Step 1: 写失败的测试**

`tests/daemon-wechat.test.ts`：

```ts
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type FauxProviderHandle } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WeChatStore } from "../src/channels/wechat/store.js";
import type { VexConfig } from "../src/config/schema.js";
import { startDaemon, type Daemon } from "../src/daemon.js";
import { createLogger } from "../src/logger.js";
import { resolvePaths, type VexPaths } from "../src/paths.js";
import { createModelRegistry } from "../src/providers/models.js";
import { createFaux, fauxModels } from "./helpers/faux.js";
import { FakeIlink, textMessage } from "./helpers/ilink.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

let dir: string;
let paths: VexPaths;
let faux: FauxProviderHandle;
let ilink: FakeIlink;
let daemon: Daemon | undefined;

beforeEach(async () => {
  dir = await makeTmpDir();
  paths = resolvePaths(dir);
  faux = createFaux();
  ilink = new FakeIlink();
  await ilink.start();
});
afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  await ilink.stop();
  await removeTmpDir(dir);
});

function config(wechat: Partial<VexConfig["wechat"]> = {}): VexConfig {
  return {
    model: { provider: faux.getModel().provider, id: faux.getModel().id },
    backgroundModel: { provider: faux.getModel().provider, id: faux.getModel().id },
    providers: {},
    web: { host: "127.0.0.1", port: 0 },
    workspace: join(dir, "workspace"),
    toolPolicy: {},
    bashEnvPassthrough: [],
    wechat: { enabled: true, baseUrl: ilink.baseUrl, ...wechat },
  };
}

async function start(cfg: VexConfig): Promise<void> {
  daemon = await startDaemon({ paths, config: cfg, log: createLogger(), models: createModelRegistry({}, fauxModels(faux)) });
}

async function link(userId?: string): Promise<void> {
  await new WeChatStore(paths.wechat).saveCredentials({ token: "tok", accountId: "bot1", baseUrl: ilink.baseUrl, userId });
}

describe("vexd with WeChat", () => {
  it("answers the owner on WeChat", async () => {
    await link("owner1");
    faux.setResponses([fauxAssistantMessage("在的")]);
    ilink.queueUpdates(textMessage("stranger", "hi", { message_id: "x1" }), textMessage("owner1", "在吗", { message_id: "m1" }));
    await start(config());
    await vi.waitFor(() => expect(ilink.sentTexts()).toEqual(["在的"]), { timeout: 5000 });
    expect(faux.getPendingResponseCount()).toBe(0);
  });

  it("asks for approval on WeChat and runs the tool after /y", async () => {
    await link("owner1");
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "echo hi" }, { id: "c1" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("跑完了"),
    ]);
    ilink.queueUpdates(textMessage("owner1", "跑一下", { message_id: "m1" }));
    await start(config());
    await vi.waitFor(() => expect(ilink.sentTexts()[0]).toContain("【需要你批准】微信想执行 bash：\necho hi"), { timeout: 5000 });
    ilink.queueUpdates(textMessage("owner1", "/y", { message_id: "m2" }));
    await vi.waitFor(() => expect(ilink.sentTexts().slice(1)).toEqual(["已允许：bash", "跑完了"]), { timeout: 5000 });
  });

  it("uses the configured owner over the scanner", async () => {
    await link("scanner");
    faux.setResponses([fauxAssistantMessage("主人好")]);
    ilink.queueUpdates(textMessage("scanner", "我不是主人", { message_id: "m1" }), textMessage("boss", "我是", { message_id: "m2" }));
    await start(config({ ownerId: "boss" }));
    await vi.waitFor(() => expect(ilink.sentTexts()).toEqual(["主人好"]), { timeout: 5000 });
  });

  it("stays off when disabled, unlinked, or without an owner", async () => {
    await start(config({ enabled: false }));
    await daemon!.stop();
    await start(config());
    await daemon!.stop();
    await link(undefined);
    await start(config());
    await new Promise((r) => setTimeout(r, 50));
    expect(ilink.requests).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/daemon-wechat.test.ts`
Expected: FAIL：前三个用例在超时后仍收不到微信回复（vexd 尚未接入微信）。

- [ ] **Step 3: 实现**

`src/channels/wechat/setup.ts`：

```ts
import type { Logger } from "pino";
import type { VexConfig } from "../../config/schema.js";
import type { EventBus } from "../../core/events.js";
import type { VexPaths } from "../../paths.js";
import type { ApprovalManager } from "../../policy/approvals.js";
import { WeChatChannel, type WeChatSessions } from "./channel.js";
import { WeChatClient } from "./client.js";
import { WeChatStore } from "./store.js";

export async function startWeChatChannel(opts: {
  config: VexConfig;
  paths: VexPaths;
  sessions: WeChatSessions;
  approvals: ApprovalManager;
  bus: EventBus;
  log: Logger;
}): Promise<WeChatChannel | undefined> {
  const { config, log } = opts;
  if (!config.wechat.enabled) return undefined;
  const store = new WeChatStore(opts.paths.wechat);
  const credentials = await store.loadCredentials();
  if (!credentials) {
    log.info("wechat not linked; run `vex wechat login` to link it");
    return undefined;
  }
  const ownerId = config.wechat.ownerId ?? credentials.userId;
  if (!ownerId) {
    log.warn("wechat owner unknown; set wechat.ownerId in config.yaml");
    return undefined;
  }
  const channel = new WeChatChannel({
    client: new WeChatClient({ baseUrl: credentials.baseUrl, token: credentials.token }),
    store,
    ownerId,
    sessions: opts.sessions,
    approvals: opts.approvals,
    bus: opts.bus,
    log,
  });
  await channel.start();
  log.info({ ownerId }, "wechat channel started");
  return channel;
}
```

把 `src/daemon.ts` 替换为以下完整内容（新增 `startWeChatChannel` 的导入、启动与关闭步骤）。

`src/daemon.ts`：

```ts
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { startWeChatChannel } from "./channels/wechat/setup.js";
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
  const approvals = new ApprovalManager({ onChange: () => bus.emit({ type: "approvals_changed" }), workspace: config.workspace });
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
  const wechat = await startWeChatChannel({ config, paths, sessions, approvals, bus, log });
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
      await step("wechat", () => wechat?.stop());
      await step("sessions", () => sessions.shutdown());
      await step("approvals", () => approvals.dispose());
      await step("gateway", () => gateway.stop());
      log.info("vexd stopped");
    },
  };
}
```

- [ ] **Step 4: 全量检查**

Run: `npm run lint && npm test && npm run build`
Expected: 全部通过；`node dist/cli/index.js` 的用法里包含 `wechat login        扫码绑定微信`。

- [ ] **Step 5: 提交**

```bash
git add src/channels/wechat/setup.ts src/daemon.ts tests/daemon-wechat.test.ts
git commit -m "feat: connect wechat to vexd

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: 真机验证（与主人一起完成）**

需要真实的模型 API key 和主人的手机微信。用隔离的数据目录：

```bash
export VEX_HOME=$(mktemp -d)
node dist/cli/index.js onboard        # 配好模型后，对“现在扫码绑定微信吗？”回答 y，用手机微信扫码确认
node dist/cli/index.js start -d
```

逐项确认：
1. 主人在微信发“你好”，收到一条完整回复；用另一个微信号发消息，没有任何回复。
2. 让它“写一篇 800 字的文章”：15 秒后先收到“处理中…”，之后收到完整文章（超过 2000 字会分成多条）。
3. 让它“用 bash 执行 date”：微信收到审批提示，回 `/y` 后收到“已允许：bash”和命令结果；再请求一次，回 `/n` 收到“已拒绝：bash”和模型的说明。
4. 在网页端发起一个需要 bash 的请求：微信同样收到审批提示，在微信里回 `/y` 后网页端的审批卡片消失。
5. 让它写长文，过程中发 `/stop`：收到带“（已中断）”的回复。
6. `node dist/cli/index.js stop` 后再 `start -d`，在网页端触发审批：即使重启后主人还没在微信发过消息，微信也能收到审批提示。
7. 清理：`node dist/cli/index.js stop && rm -rf "$VEX_HOME"`。
