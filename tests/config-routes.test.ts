/**
 * Config routes tests — getConfigInfo / validateConfig / saveConfig /
 * extractUserConfigSettings / extractSystemConfigParams.
 *
 * Ported from _archive/tests/control-settings.test.ts to the new API:
 *  - `saveConfig` now takes an explicit `configPath` (the archive's
 *    `__configPath` non-enumerable hack is gone — the rewrite plan folds it
 *    into an explicit field at the call site).
 *  - The config object is `SystemConfig`-shaped (EffectiveConfig + the
 *    channel/weather/sharelink/skillLearner/sessions sections the control
 *    panel serializes).
 *  - `buildUserEffectiveConfig` is superseded by ConfigStore.resolve, so
 *    it is not ported here.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import yaml from "yaml";

vi.mock("../src/utils/logger.js", () => ({
  getChildLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

let tmpHome = os.tmpdir();
vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return {
    ...actual,
    homedir: () => tmpHome,
  };
});

import {
  getConfigInfo,
  getUserConfigInfo,
  validateConfig,
  saveConfig,
  extractUserConfigSettings,
  extractSystemConfigParams,
  type SystemConfig,
} from "../src/web/routes/config.js";
import type { ConfigSaveParams } from "../src/web/types.js";

function baseConfig(): SystemConfig {
  return {
    providers: {
      deepseek: { apiKey: "sk-test" },
    },
    channels: {},
    agent: {
      defaultModel: "deepseek-chat",
      defaultProvider: "deepseek",
    },
    server: { port: 3000, host: "0.0.0.0" },
    logging: { level: "info" },
  };
}

describe("web/routes/config getConfigInfo", () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "vex-settings-test-"));
    tmpHome = homeDir;
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("serializes persona/skillLearner/sharelink/weather/sessions when present", () => {
    const config: SystemConfig = {
      ...baseConfig(),
      persona: {
        enabled: true,
        persona_name: "Vex",
        persona_base_prompt: "You are helpful.",
        emotion_decay_per_hour: 10,
      },
      skillLearner: {
        enabled: true,
        maxLearningTurns: 5,
        autoDeployToSkills: true,
      },
      sharelink: {
        enabled: true,
        responseMode: "detailed",
        bilibiliCookie: { sessdata: "secret-sess", biliJct: "secret-jct" },
        descriptionMaxLength: 500,
      },
      weather: {
        weather_provider: "caiyun",
        caiyun_api_key: "secret-weather-key",
        caiyun_api_version: "v2.6",
        default_location: "深圳",
        request_timeout_ms: 10000,
        cache_ttl_ms: 600000,
      },
      sessions: { type: "file", directory: "/tmp/vex-sessions", ttlMs: 3600000 },
    };

    const info = getConfigInfo(config);

    expect(info.persona).toEqual(config.persona);
    expect(info.skillLearner).toEqual(config.skillLearner);
    expect(info.sharelink).toMatchObject({
      enabled: true,
      responseMode: "detailed",
      descriptionMaxLength: 500,
      hasBilibiliCookie: true,
    });
    // Cookie values must NOT be serialized into ConfigInfo
    expect((info.sharelink as unknown as Record<string, unknown>)?.bilibiliCookie).toBeUndefined();
    expect(info.weather).toMatchObject({
      weather_provider: "caiyun",
      caiyun_api_version: "v2.6",
      default_location: "深圳",
      request_timeout_ms: 10000,
      cache_ttl_ms: 600000,
      hasCaiyunApiKey: true,
    });
    expect((info.weather as unknown as Record<string, unknown>)?.caiyun_api_key).toBeUndefined();
    expect(info.sessions).toEqual(config.sessions);
  });

  it("returns undefined for new sections when absent", () => {
    const info = getConfigInfo(baseConfig());
    expect(info.persona).toBeUndefined();
    expect(info.skillLearner).toBeUndefined();
    expect(info.sharelink).toBeUndefined();
    expect(info.weather).toBeUndefined();
    expect(info.sessions).toBeUndefined();
  });

  it("falls back to the real default bind (127.0.0.1) when host is unset", () => {
    const config = baseConfig();
    config.server = { port: 3000 } as SystemConfig["server"];
    expect(getConfigInfo(config).server.host).toBe("127.0.0.1");
  });

  it("overlays user settings on global config for config info", () => {
    const config: SystemConfig = {
      ...baseConfig(),
      agent: {
        defaultModel: "global-model",
        defaultProvider: "deepseek",
        temperature: 0.1,
      },
      persona: { persona_name: "Global" },
      weather: { weather_provider: "caiyun", caiyun_api_key: "global-weather-key" },
    };

    const info = getUserConfigInfo(config, {
      agent: {
        defaultProvider: "deepseek",
        defaultModel: "user-model",
        temperature: 0.7,
      },
      persona: { persona_name: "User" },
      weather: { default_location: "广州" },
    });

    expect(info.agent).toMatchObject({
      defaultModel: "user-model",
      temperature: 0.7,
    });
    expect(info.persona).toMatchObject({ persona_name: "User" });
    expect(info.weather).toMatchObject({
      weather_provider: "caiyun",
      default_location: "广州",
      hasCaiyunApiKey: true,
    });
    expect((info.weather as unknown as Record<string, unknown>)?.caiyun_api_key).toBeUndefined();
  });

  it("reports authenticated user Weixin login state", () => {
    const info = getUserConfigInfo(
      {
        ...baseConfig(),
        channels: {
          weixin: {
            enabled: false,
            baseUrl: "https://ilinkai.weixin.qq.com",
            botType: "3",
          },
        },
      },
      {},
      {
        id: "user-1",
        username: "alice",
        role: "user",
        createdAt: 1,
        hasWeixin: true,
        weixinAccountId: "wx-account",
      },
    );

    expect(info.channels.weixin).toMatchObject({
      hasConfig: true,
      enabled: true,
      hasToken: true,
      accountId: "wx-account",
    });
  });
});

describe("web/routes/config validateConfig", () => {
  it("rejects out-of-range persona.emotion_decay_per_hour", () => {
    const result = validateConfig({
      persona: { emotion_decay_per_hour: 200 },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("emotion_decay_per_hour"))).toBe(true);
  });

  it("rejects invalid persona.rest_sleep_hour", () => {
    const result = validateConfig({
      persona: { rest_sleep_hour: 24 },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("rest_sleep_hour"))).toBe(true);
  });

  it("rejects invalid sharelink.responseMode", () => {
    const result = validateConfig({
      sharelink: { responseMode: "verbose" as unknown as "simple" | "detailed" },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("responseMode"))).toBe(true);
  });

  it("rejects invalid skillLearner.proactiveThreshold", () => {
    const result = validateConfig({
      skillLearner: { proactiveThreshold: 1.5 },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("proactiveThreshold"))).toBe(true);
  });

  it("rejects invalid sessions.type", () => {
    const result = validateConfig({
      sessions: { type: "redis" as unknown as "memory" | "file" },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("sessions.type"))).toBe(true);
  });

  it("rejects invalid weather provider values", () => {
    const result = validateConfig({
      weather: { weather_provider: "accuweather" as unknown as "wttr" | "caiyun" },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("weather_provider"))).toBe(true);
  });

  it("rejects invalid weather timeouts", () => {
    const result = validateConfig({
      weather: { request_timeout_ms: 0, cache_ttl_ms: -1 },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("request_timeout_ms"))).toBe(true);
    expect(result.errors.some((e) => e.includes("cache_ttl_ms"))).toBe(true);
  });

  it("accepts valid new-section values", () => {
    const result = validateConfig({
      persona: { enabled: true, rest_sleep_hour: 23, rest_wake_hour: 7 },
      skillLearner: { enabled: true, proactiveThreshold: 0.5 },
      sharelink: { responseMode: "simple", descriptionMaxLength: 100 },
      weather: { weather_provider: "caiyun", caiyun_api_version: "v2.6", request_timeout_ms: 10000 },
      sessions: { type: "memory", ttlMs: 60000 },
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("accepts partial channel save payloads from the control form", () => {
    const result = validateConfig({
      channels: {
        weixin: {
          hasConfig: true,
          enabled: true,
          botType: "3",
        },
      },
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects invalid provider id for defaultProvider", () => {
    const result = validateConfig({
      agent: { defaultProvider: "not-a-provider" },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("provider"))).toBe(true);
  });

  it("rejects out-of-range temperature and maxTokens", () => {
    const result = validateConfig({
      agent: { temperature: 3, maxTokens: 0 },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("temperature"))).toBe(true);
    expect(result.errors.some((e) => e.includes("maxTokens"))).toBe(true);
  });

  it("rejects out-of-range server port", () => {
    const result = validateConfig({ server: { port: 0, host: "127.0.0.1" } });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Port"))).toBe(true);
  });
});

describe("web/routes/config saveConfig", () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "vex-settings-test-"));
    tmpHome = homeDir;
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  const configPath = () => path.join(tmpHome, ".vex", "config.local.yaml");

  it("writes and re-reads persona/skillLearner/sharelink/weather/sessions", () => {
    const current = baseConfig();
    const params: ConfigSaveParams = {
      persona: { enabled: true, persona_name: "Vex", persona_base_prompt: "hi" },
      skillLearner: { enabled: true, maxLearningTurns: 3 },
      sharelink: { enabled: true, responseMode: "detailed", descriptionMaxLength: 200 },
      weather: {
        weather_provider: "caiyun",
        caiyun_api_key: "weather-key",
        caiyun_api_version: "v2.6",
        default_location: "深圳",
        request_timeout_ms: 5000,
        cache_ttl_ms: 300000,
      },
      sessions: { type: "file", directory: "/tmp/s", ttlMs: 1000 },
    };

    const result = saveConfig(configPath(), current, params);
    expect(result.success).toBe(true);

    const written = fs.readFileSync(configPath(), "utf-8");
    const parsed = yaml.parse(written);
    expect(parsed.persona).toEqual(params.persona);
    expect(parsed.skillLearner).toEqual(params.skillLearner);
    expect(parsed.sharelink).toEqual({
      enabled: true,
      responseMode: "detailed",
      descriptionMaxLength: 200,
    });
    expect(parsed.weather).toEqual(params.weather);
    expect(parsed.sessions).toEqual(params.sessions);
  });

  it("merges sharelink.bilibiliCookie only when values are sent", () => {
    const vexDir = path.join(tmpHome, ".vex");
    fs.mkdirSync(vexDir, { recursive: true });
    fs.writeFileSync(
      path.join(vexDir, "config.local.yaml"),
      yaml.stringify({
        sharelink: {
          enabled: true,
          bilibiliCookie: { sessdata: "old-sess", biliJct: "old-jct" },
        },
      }),
    );

    // Save without cookie — should preserve existing cookie
    saveConfig(configPath(), baseConfig(), {
      sharelink: { enabled: false, responseMode: "simple" },
    });

    const written = yaml.parse(fs.readFileSync(path.join(vexDir, "config.local.yaml"), "utf-8"));
    expect(written.sharelink.bilibiliCookie).toEqual({
      sessdata: "old-sess",
      biliJct: "old-jct",
    });
    expect(written.sharelink.enabled).toBe(false);
  });

  it("merges weather.caiyun_api_key only when a value is sent", () => {
    const vexDir = path.join(tmpHome, ".vex");
    fs.mkdirSync(vexDir, { recursive: true });
    fs.writeFileSync(
      path.join(vexDir, "config.local.yaml"),
      yaml.stringify({
        weather: {
          weather_provider: "caiyun",
          caiyun_api_key: "old-weather-key",
          caiyun_api_version: "v2.6",
        },
      }),
    );

    saveConfig(configPath(), baseConfig(), {
      weather: { weather_provider: "wttr", caiyun_api_key: "" },
    });

    const written = yaml.parse(fs.readFileSync(path.join(vexDir, "config.local.yaml"), "utf-8"));
    expect(written.weather.caiyun_api_key).toBe("old-weather-key");
    expect(written.weather.weather_provider).toBe("wttr");
  });

  it("rawYaml patch overrides form fields and merges arbitrary keys", () => {
    const result = saveConfig(configPath(), baseConfig(), {
      persona: { persona_name: "FormName" },
      rawYaml: "persona:\n  persona_name: GeekName\ncustomKey: geek\n",
    });
    expect(result.success).toBe(true);

    const written = yaml.parse(fs.readFileSync(configPath(), "utf-8"));
    expect(written.persona.persona_name).toBe("GeekName");
    expect(written.customKey).toBe("geek");
  });

  it("rejects malformed rawYaml with a parse error message", () => {
    const result = saveConfig(configPath(), baseConfig(), {
      rawYaml: "persona: [unterminated",
    });
    expect(result.success).toBe(false);
    expect(result.message).toContain("Raw YAML parse error");
  });

  it("rejects non-object rawYaml top-level", () => {
    const result = saveConfig(configPath(), baseConfig(), { rawYaml: "- 1\n- 2\n- 3\n" });
    expect(result.success).toBe(false);
    expect(result.message).toContain("must be an object");
  });

  it("requires restart when the server port changes", () => {
    const current = baseConfig();
    current.server = { port: 3000, host: "127.0.0.1" };

    const result = saveConfig(configPath(), current, { server: { port: 4000, host: "127.0.0.1" } });
    expect(result.success).toBe(true);
    expect(result.requiresRestart).toBe(true);
  });

  it("does not require restart when the server port is unchanged", () => {
    const current = baseConfig();
    current.server = { port: 3000, host: "127.0.0.1" };

    const result = saveConfig(configPath(), current, { server: { port: 3000, host: "0.0.0.0" } });
    expect(result.success).toBe(true);
    expect(result.requiresRestart).toBe(false);
  });

  it("rejects rawYaml that makes a known field the wrong type instead of bricking the live config", () => {
    const current = baseConfig();
    const result = saveConfig(configPath(), current, {
      rawYaml: "agent: not-an-object\n",
    });
    expect(result.success).toBe(false);
    expect(result.message).toContain("validation failed");
    // Live config untouched, nothing written
    expect(current.agent.defaultProvider).toBe("deepseek");
    expect(fs.existsSync(configPath())).toBe(false);
  });

  it("requires restart when sessions.type changes", () => {
    const vexDir = path.join(tmpHome, ".vex");
    fs.mkdirSync(vexDir, { recursive: true });
    fs.writeFileSync(
      path.join(vexDir, "config.local.yaml"),
      yaml.stringify({ sessions: { type: "memory" } }),
    );
    const current = baseConfig();
    current.sessions = { type: "memory" };

    const result = saveConfig(configPath(), current, { sessions: { type: "file" } });
    expect(result.success).toBe(true);
    expect(result.requiresRestart).toBe(true);
  });

  it("updates the live config object after saving", () => {
    const current = baseConfig();

    const result = saveConfig(configPath(), current, {
      persona: { persona_name: "LiveName" },
      weather: { weather_provider: "caiyun", caiyun_api_version: "v2.6" },
    });

    expect(result.success).toBe(true);
    expect(current.persona?.persona_name).toBe("LiveName");
    expect(current.weather?.weather_provider).toBe("caiyun");
  });

  it("writes to the given configPath (replaces the __configPath hack)", () => {
    const configDir = path.join(homeDir, "custom-config");
    fs.mkdirSync(configDir, { recursive: true });
    const customPath = path.join(configDir, "vex.yaml");
    const current = baseConfig();

    const result = saveConfig(customPath, current, { server: { port: 3456, host: "127.0.0.1" } });

    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, ".vex", "config.local.yaml"))).toBe(false);
    const written = yaml.parse(fs.readFileSync(customPath, "utf-8"));
    expect(written.server).toEqual({ port: 3456, host: "127.0.0.1" });
  });
});

describe("web/routes/config extract*", () => {
  it("extracts user-owned sections from a save payload", () => {
    const params: ConfigSaveParams = {
      agent: { defaultModel: "m" },
      memory: { enabled: true },
      persona: { persona_name: "U" },
      skillLearner: { enabled: true },
      sharelink: { enabled: true },
      weather: { weather_provider: "wttr" },
      sessions: { type: "file" },
      providers: { deepseek: { id: "deepseek", hasApiKey: true } },
      channels: { weixin: { id: "weixin", hasConfig: true } },
      server: { port: 4000, host: "127.0.0.1" },
      logging: { level: "debug" },
    };
    const user = extractUserConfigSettings(params);
    expect(user.agent).toBeDefined();
    expect(user.memory).toBeDefined();
    expect(user.persona).toBeDefined();
    expect(user.skillLearner).toBeDefined();
    expect(user.sharelink).toBeDefined();
    expect(user.weather).toBeDefined();
    expect(user.sessions).toBeUndefined();
    expect(user.providers).toBeUndefined();
    expect(user.channels).toBeUndefined();
    expect(user.server).toBeUndefined();
    expect(user.logging).toBeUndefined();
  });

  it("drops crafted system-owned fields from personal settings", () => {
    const user = extractUserConfigSettings({
      agent: {
        defaultModel: "safe-model",
        workingDirectory: "/etc",
        bashEnvPassthrough: ["SECRET"],
      },
      memory: { enabled: true, directory: "/tmp/other-user" },
      sessions: { type: "file", directory: "/tmp/other-user" },
    } as unknown as ConfigSaveParams);

    expect(user.agent).toEqual({ defaultModel: "safe-model" });
    expect(user.memory).toEqual({ enabled: true });
    expect(user.sessions).toBeUndefined();
  });

  it("extracts system-owned sections from a save payload", () => {
    const params: ConfigSaveParams = {
      agent: { defaultModel: "m" },
      providers: { deepseek: { id: "deepseek", hasApiKey: true } },
      channels: { weixin: { id: "weixin", hasConfig: true } },
      server: { port: 4000, host: "127.0.0.1" },
      logging: { level: "debug" },
      skills: { enabled: true },
      rawYaml: "customKey: 1\n",
    };
    const system = extractSystemConfigParams(params);
    expect(system.providers).toBeDefined();
    expect(system.channels).toBeDefined();
    expect(system.server).toBeDefined();
    expect(system.logging).toBeDefined();
    expect(system.skills).toBeDefined();
    expect(system.rawYaml).toBeDefined();
    expect(system.agent).toBeUndefined();
  });
});
