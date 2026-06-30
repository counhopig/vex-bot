/**
 * 配置加载测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Mock logger
vi.mock("../src/utils/logger.js", () => ({
  getChildLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { getConfigWritePath, loadConfig, validateRequiredConfig, VexConfigSchema } from "../src/config/index.js";

describe("config", () => {
  let testDir: string;
  let originalCwd: string;
  const originalEnv = process.env;

  beforeEach(() => {
    originalCwd = process.cwd();
    // 创建临时测试目录
    testDir = path.join(os.tmpdir(), `vex-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(testDir, { recursive: true });

    // 重置环境变量
    process.env = { ...originalEnv };
    // 清除所有 vex 相关的环境变量
    Object.keys(process.env).forEach((key) => {
      if (
        key.includes("DEEPSEEK") ||
        key.includes("MINIMAX") ||
        key.includes("KIMI") ||
        key.includes("STEPFUN") ||
        key.includes("MODELSCOPE") ||
        key.includes("DASHSCOPE") ||
        key.includes("ZHIPU") ||
        key.includes("LONGCAT") ||
        key.includes("OPENAI") ||
        key.includes("OLLAMA") ||
        key.includes("OPENROUTER") ||
        key.includes("TOGETHER") ||
        key.includes("GROQ") ||
        key.includes("WEIXIN_OC") ||
        key === "PORT" ||
        key === "LOG_LEVEL"
      ) {
        delete process.env[key];
      }
    });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    // 恢复环境变量
    process.env = originalEnv;

    // 清理测试目录
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("VexConfigSchema", () => {
    it("should validate minimal config", () => {
      const result = VexConfigSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it("should provide default values", () => {
      const result = VexConfigSchema.parse({});

      expect(result.providers).toEqual({});
      expect(result.channels).toEqual({});
      expect(result.agent).toBeDefined();
      expect(result.agent?.defaultModel).toBe("deepseek-chat");
      expect(result.agent?.defaultProvider).toBe("deepseek");
      expect(result.agent?.temperature).toBe(0.7);
      expect(result.agent?.maxTokens).toBe(4096);
      expect(result.server?.port).toBe(3000);
      expect(result.server?.host).toBe("0.0.0.0");
      expect(result.logging?.level).toBe("info");
    });

    it("should validate provider config", () => {
      const result = VexConfigSchema.safeParse({
        providers: {
          deepseek: {
            apiKey: "test-key",
            baseUrl: "https://api.deepseek.com",
          },
        },
      });

      expect(result.success).toBe(true);
    });

    it("should validate weixin channel config", () => {
      const result = VexConfigSchema.safeParse({
        channels: {
          weixin: {
            enabled: true,
            baseUrl: "https://ilinkai.weixin.qq.com",
            botType: "3",
          },
        },
      });

      expect(result.success).toBe(true);
    });

    it("should validate agent config with valid provider", () => {
      const result = VexConfigSchema.safeParse({
        agent: {
          defaultModel: "gpt-4",
          defaultProvider: "openai",
          temperature: 0.5,
          maxTokens: 8192,
        },
      });

      expect(result.success).toBe(true);
    });

    it("should reject invalid temperature", () => {
      const result = VexConfigSchema.safeParse({
        agent: {
          temperature: 3.0, // Max is 2
        },
      });

      expect(result.success).toBe(false);
    });

    it("should validate memory config", () => {
      const result = VexConfigSchema.safeParse({
        memory: {
          enabled: true,
          directory: "/custom/memory",
          embeddingModel: "text-embedding-3-small",
          embeddingProvider: "openai",
        },
      });

      expect(result.success).toBe(true);
    });

    it("should validate skills config", () => {
      const result = VexConfigSchema.safeParse({
        skills: {
          enabled: true,
          userDir: "/user/skills",
          workspaceDir: "/workspace/skills",
          disabled: ["skill-a"],
          only: ["skill-b", "skill-c"],
        },
      });

      expect(result.success).toBe(true);
    });

    it("should validate session store config", () => {
      const result = VexConfigSchema.safeParse({
        sessions: {
          type: "file",
          directory: "/sessions",
          ttlMs: 3600000,
        },
      });

      expect(result.success).toBe(true);
    });
  });

  describe("loadConfig", () => {
    it("should load config from YAML file", () => {
      const configPath = path.join(testDir, "config.local.yaml");
      const configContent = `
providers:
  deepseek:
    apiKey: file-key
`;

      fs.writeFileSync(configPath, configContent);

      const config = loadConfig({ configPath });
      expect(config.providers.deepseek?.apiKey).toBe("file-key");
    });

    it("should reject JSON config files", () => {
      const configPath = path.join(testDir, "config.json");
      fs.writeFileSync(configPath, JSON.stringify({ providers: { deepseek: { apiKey: "json-key" } } }));

      expect(() => loadConfig({ configPath })).toThrow(".yaml");
    });

    it("should reject JSON5 config files", () => {
      const configPath = path.join(testDir, "config.local.json5");
      fs.writeFileSync(configPath, `{ providers: { deepseek: { apiKey: "json5-key" } } }`);

      expect(() => loadConfig({ configPath })).toThrow(".yaml");
    });

    it("should ignore environment variables and use only YAML config files", () => {
      const configPath = path.join(testDir, "config.local.yaml");
      fs.writeFileSync(
        configPath,
        `
providers:
  deepseek:
    apiKey: file-key
`
      );

      process.env.DEEPSEEK_API_KEY = "env-key";
      process.env.KIMI_API_KEY = "kimi-key";
      process.env.ZHIPU_API_KEY = "zhipu-key";
      process.env.LONGCAT_API_KEY = "longcat-key";
      process.env.WEIXIN_OC_TOKEN = "wx-token";
      process.env.WEIXIN_OC_ACCOUNT_ID = "wx-account";
      process.env.PORT = "8080";
      process.env.LOG_LEVEL = "debug";

      const config = loadConfig({ configPath });
      expect(config.providers.deepseek?.apiKey).toBe("file-key");
      expect(config.providers.kimi).toBeUndefined();
      expect(config.providers.zhipu).toBeUndefined();
      expect(config.providers.longcat).toBeUndefined();
      expect(config.channels.weixin).toBeUndefined();
      expect(config.server.port).toBe(3000);
      expect(config.logging.level).toBe("info");
    });

    it("should return empty config when no file and no env", () => {
      const config = loadConfig({ configPath: path.join(testDir, "nonexistent.yaml") });

      expect(config.providers).toEqual({});
      expect(config.channels).toEqual({});
    });

    it("should merge only config.local.yaml files by documented priority", () => {
      const homeDir = path.join(testDir, "home");
      const workDir = path.join(testDir, "work");
      const vexDir = path.join(homeDir, ".vex");
      fs.mkdirSync(vexDir, { recursive: true });
      fs.mkdirSync(workDir, { recursive: true });
      fs.writeFileSync(path.join(workDir, "config.local.json5"), `providers: { deepseek: { apiKey: ignored-cwd-key } }`);
      fs.writeFileSync(path.join(workDir, "config.local.yaml"), `
providers:
  deepseek:
    apiKey: cwd-key
agent:
  defaultModel: cwd-model
server:
  port: 3001
`);
      fs.writeFileSync(path.join(vexDir, "config.local.json5"), `providers: { kimi: { apiKey: ignored-home-key } }`);
      fs.writeFileSync(path.join(vexDir, "config.local.yaml"), `
providers:
  kimi:
    apiKey: home-key
agent:
  defaultModel: home-model
  temperature: 0.2
logging:
  level: debug
`);

      const config = loadConfig({ configDir: vexDir, cwd: workDir });

      expect(config.providers.deepseek?.apiKey).toBe("cwd-key");
      expect(config.providers.kimi?.apiKey).toBe("home-key");
      expect(config.agent.defaultModel).toBe("home-model");
      expect(config.agent.temperature).toBe(0.2);
      expect(config.server.port).toBe(3001);
      expect(config.logging.level).toBe("debug");
      expect(getConfigWritePath(config)).toBe(path.join(vexDir, "config.local.yaml"));
      expect(Object.keys(config)).not.toContain("__configPath");
    });

    it("should use explicit config path as the write target", () => {
      const configPath = path.join(testDir, "custom.yaml");
      fs.writeFileSync(configPath, `
providers:
  deepseek:
    apiKey: file-key
`);

      const config = loadConfig({ configPath });

      expect(getConfigWritePath(config)).toBe(configPath);
      expect(Object.keys(config)).not.toContain("__configPath");
    });
  });

  describe("validateRequiredConfig", () => {
    it("should return error when no provider configured", () => {
      const config = VexConfigSchema.parse({});
      const errors = validateRequiredConfig(config);

      expect(errors.some((e) => e.includes("provider"))).toBe(true);
    });

    it("should return error when no channel configured (not webOnly)", () => {
      const config = VexConfigSchema.parse({
        providers: {
          deepseek: { apiKey: "key" },
        },
      });
      const errors = validateRequiredConfig(config);

      expect(errors.some((e) => e.includes("channel"))).toBe(true);
    });

    it("should not require channel when webOnly", () => {
      const config = VexConfigSchema.parse({
        providers: {
          deepseek: { apiKey: "key" },
        },
      });
      const errors = validateRequiredConfig(config, { webOnly: true });

      expect(errors.some((e) => e.includes("channel"))).toBe(false);
    });

    it("should pass with valid config", () => {
      const config = VexConfigSchema.parse({
        providers: {
          deepseek: { apiKey: "key" },
        },
        channels: {
          weixin: {
            enabled: true,
          },
        },
      });
      const errors = validateRequiredConfig(config);

      expect(errors).toHaveLength(0);
    });
  });
});
