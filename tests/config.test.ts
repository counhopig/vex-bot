import { readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  it("validates scheduler, persona, search and MCP configuration", () => {
    const config = parseConfig(`${minimal}heartbeat: { every: 30m, activeHours: ["08:00", "22:00"] }\npersona: { sleep: ["23:00", "07:00"], outreach: { dailyLimit: 3 } }\nmemory: { consolidateAt: "03:00" }\nwebSearch: { provider: brave }\nmcpServers: { local: { command: node, args: [server.js] }, remote: { url: "https://example.com/mcp" } }\n`, paths);
    expect(config.persona?.sleep).toEqual(["23:00", "07:00"]);
    expect(config.mcpServers?.local).toMatchObject({ command: "node" });
    for (const block of ["heartbeat: { every: 0m }", "persona: { sleep: ['25:00', '07:00'] }", "persona: { outreach: { dailyLimit: -1 } }", "memory: { consolidateAt: '99:00' }", "webSearch: { provider: unknown }", "mcpServers: { broken: {} }"]) {
      expect(() => parseConfig(`${minimal}${block}\n`, paths)).toThrow(ConfigError);
    }
  });
  it("validates the notes vault: a folder or a git url, never both", () => {
    expect(parseConfig(minimal, paths).vault).toBeUndefined();
    expect(parseConfig(`${minimal}vault: { path: /vault }\n`, paths).vault).toEqual({ path: "/vault" });
    expect(parseConfig(`${minimal}vault: { path: notes }\n`, paths).vault).toEqual({ path: join(dir, "notes") });
    expect(parseConfig(`${minimal}vault: { path: "~/notes" }\n`, paths).vault).toEqual({ path: join(homedir(), "notes") });
    expect(parseConfig(`${minimal}vault: { url: "https://git.example/me/notes.git", branch: main, username: me, token: t }\n`, paths).vault)
      .toEqual({ url: "https://git.example/me/notes.git", branch: "main", username: "me", token: "t" });
    expect(parseConfig(`${minimal}vault: { url: "http://gitea:3000/me/notes.git" }\n`, paths).vault).toEqual({ url: "http://gitea:3000/me/notes.git" });
    const bad: [string, RegExp][] = [
      ['vault: { path: /v, url: "https://g/x.git" }', /either path or url/],
      ["vault: {}", /set path/],
      ["vault: { path: /v, token: t }", /only to a git url/],
      ['vault: { url: "https://me:pw@g/x.git" }', /must not contain a username or password/],
      ['vault: { url: "ssh://git@g/x.git" }', /vault\/url/],
      ['vault: { url: "git@g:me/notes.git" }', /vault\/url/],
    ];
    for (const [block, message] of bad) expect(() => parseConfig(`${minimal}${block}\n`, paths)).toThrow(message);
  });

  it("defaults the wiki block when enabled with a vault url", () => {
    const config = parseConfig("model: { provider: p, id: m }\nvault: { url: https://example.com/v.git }\nwiki: { enabled: true }\n", paths);
    expect(config.wiki).toEqual({ enabled: true, every: "6h", notify: true, maxNotesPerRun: 20 });
  });

  it("rejects wiki.enabled without vault.url", () => {
    expect(() => parseConfig("model: { provider: p, id: m }\nwiki: { enabled: true }\n", paths)).toThrow(/wiki.*vault\.url/);
  });

  it("omits wiki when disabled or absent", () => {
    expect(parseConfig("model: { provider: p, id: m }\n", paths).wiki).toBeUndefined();
  });

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
      compaction: { threshold: 0.7 },
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

  it("rejects millisecond intervals for heartbeat and outreach", () => {
    expect(() => parseConfig(`${minimal}heartbeat: { every: 500ms }\n`, paths)).toThrow(/\/heartbeat\/every/);
    expect(() => parseConfig(`${minimal}persona: { outreach: { checkEvery: 500ms } }\n`, paths)).toThrow(/\/persona\/outreach\/checkEvery/);
    expect(() => parseConfig(`${minimal}heartbeat: { every: 30m }\n`, paths)).not.toThrow();
  });

  it("accepts the three web search providers and rejects others", () => {
    for (const body of ['{ provider: tavily, apiKey: k }', '{ provider: searxng, baseUrl: "http://searxng:8080" }', '{ provider: brave }']) {
      expect(() => parseConfig(`${minimal}webSearch: ${body}\n`, paths)).not.toThrow();
    }
    expect(() => parseConfig(`${minimal}webSearch: { provider: bing }\n`, paths)).toThrow(/webSearch/);
  });

  it("keeps the link reader credentials", () => {
    expect(parseConfig(`${minimal}links: { bilibili: { sessdata: abc } }\n`, paths).links).toEqual({ bilibili: { sessdata: "abc" } });
    expect(parseConfig(minimal, paths).links).toBeUndefined();
  });

  it("validates the speech-to-text settings", () => {
    const config = parseConfig(`${minimal}stt: { baseUrl: "https://stt.example/v1", model: whisper-1, language: zh, chunkMinutes: 5 }\n`, paths);
    expect(config.stt).toEqual({ baseUrl: "https://stt.example/v1", model: "whisper-1", language: "zh", chunkMinutes: 5 });
    expect(() => parseConfig(`${minimal}stt: { baseUrl: "https://stt.example/v1" }\n`, paths)).toThrow(/\/stt/);
    expect(parseConfig(`${minimal}stt: { provider: mimo, baseUrl: "https://api.xiaomimimo.com/v1", model: mimo-v2.5-asr }\n`, paths).stt?.provider).toBe("mimo");
    expect(() => parseConfig(`${minimal}stt: { provider: other, baseUrl: "https://x", model: m }\n`, paths)).toThrow(/provider/);
    expect(() => parseConfig(`${minimal}stt: { baseUrl: "https://x", model: m, chunkMinutes: 0 }\n`, paths)).toThrow(/chunkMinutes/);
  });

  it("restricts MCP server names to letters, digits and hyphens", () => {
    expect(() => parseConfig(`${minimal}mcpServers: { "a__b": { url: "http://x" } }\n`, paths)).toThrow(ConfigError);
    expect(() => parseConfig(`${minimal}mcpServers: { "${"a".repeat(33)}": { url: "http://x" } }\n`, paths)).toThrow(ConfigError);
    expect(() => parseConfig(`${minimal}mcpServers: { "my-server1": { url: "http://x" } }\n`, paths)).not.toThrow();
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

  it("lets VEX_WEB_HOST and VEX_WEB_TOKEN override the web settings", async () => {
    await writeFile(paths.config, `${minimal}web: { host: 127.0.0.1, port: 7000, token: file-token }\n`, "utf8");
    vi.stubEnv("VEX_WEB_HOST", "0.0.0.0");
    vi.stubEnv("VEX_WEB_TOKEN", "env-token");
    try {
      const { config } = await loadConfig(paths);
      expect(config.web).toEqual({ host: "0.0.0.0", port: 7000, token: "env-token" });
    } finally { vi.unstubAllEnvs(); }
    expect((await loadConfig(paths)).config.web).toEqual({ host: "127.0.0.1", port: 7000, token: "file-token" });
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
