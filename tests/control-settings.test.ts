import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import json5 from "json5";

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

import { getConfigInfo, validateConfig, saveConfig } from "../src/web/config-handlers.js";
import type { VexConfig } from "../src/types/index.js";
import type { ConfigSaveParams } from "../src/web/types.js";

function baseConfig(): VexConfig {
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

describe("control-settings config-handlers", () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "vex-settings-test-"));
    tmpHome = homeDir;
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  describe("getConfigInfo serializes new sections", () => {
    it("returns persona/skillLearner/sharelink/sessions when present", () => {
      const config: VexConfig = {
        ...baseConfig(),
        persona: {
          enabled: true,
          persona_name: "Vex",
          persona_base_prompt: "You are helpful.",
          emotion_decay_per_hour: 10,
          admin_ids: ["u1", "u2"],
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
      expect(info.sessions).toEqual(config.sessions);
    });

    it("returns undefined for new sections when absent", () => {
      const info = getConfigInfo(baseConfig());
      expect(info.persona).toBeUndefined();
      expect(info.skillLearner).toBeUndefined();
      expect(info.sharelink).toBeUndefined();
      expect(info.sessions).toBeUndefined();
    });
  });

  describe("validateConfig rejects invalid new-section values", () => {
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

    it("accepts valid new-section values", () => {
      const result = validateConfig({
        persona: { enabled: true, rest_sleep_hour: 23, rest_wake_hour: 7 },
        skillLearner: { enabled: true, proactiveThreshold: 0.5 },
        sharelink: { responseMode: "simple", descriptionMaxLength: 100 },
        sessions: { type: "memory", ttlMs: 60000 },
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });
  });

  describe("saveConfig round-trips new sections through config.local.json5", () => {
    it("writes and re-reads persona/skillLearner/sharelink/sessions", () => {
      const current = baseConfig();
      const params: ConfigSaveParams = {
        persona: { enabled: true, persona_name: "Vex", persona_base_prompt: "hi" },
        skillLearner: { enabled: true, maxLearningTurns: 3 },
        sharelink: { enabled: true, responseMode: "detailed", descriptionMaxLength: 200 },
        sessions: { type: "file", directory: "/tmp/s", ttlMs: 1000 },
      };

      const result = saveConfig(current, params);
      expect(result.success).toBe(true);

      const written = fs.readFileSync(
        path.join(tmpHome, ".vex", "config.local.json5"),
        "utf-8",
      );
      const parsed = json5.parse(written);
      expect(parsed.persona).toEqual(params.persona);
      expect(parsed.skillLearner).toEqual(params.skillLearner);
      expect(parsed.sharelink).toEqual({
        enabled: true,
        responseMode: "detailed",
        descriptionMaxLength: 200,
      });
      expect(parsed.sessions).toEqual(params.sessions);
    });

    it("merges sharelink.bilibiliCookie only when values are sent", () => {
      // Seed existing config with a cookie
      const vexDir = path.join(tmpHome, ".vex");
      fs.mkdirSync(vexDir, { recursive: true });
      fs.writeFileSync(
        path.join(vexDir, "config.local.json5"),
        JSON.stringify({
          sharelink: {
            enabled: true,
            bilibiliCookie: { sessdata: "old-sess", biliJct: "old-jct" },
          },
        }),
      );

      // Save without cookie — should preserve existing cookie
      saveConfig(baseConfig(), {
        sharelink: { enabled: false, responseMode: "simple" },
      });

      const written = json5.parse(
        fs.readFileSync(path.join(vexDir, "config.local.json5"), "utf-8"),
      );
      expect(written.sharelink.bilibiliCookie).toEqual({
        sessdata: "old-sess",
        biliJct: "old-jct",
      });
      expect(written.sharelink.enabled).toBe(false);
    });

    it("rawJson5 patch overrides form fields and merges arbitrary keys", () => {
      const result = saveConfig(baseConfig(), {
        persona: { persona_name: "FormName" },
        rawJson5: "{ persona: { persona_name: 'GeekName' }, customKey: 'geek' }",
      });
      expect(result.success).toBe(true);

      const written = json5.parse(
        fs.readFileSync(path.join(tmpHome, ".vex", "config.local.json5"), "utf-8"),
      );
      expect(written.persona.persona_name).toBe("GeekName");
      expect(written.customKey).toBe("geek");
    });

    it("rejects malformed rawJson5 with a parse error message", () => {
      const result = saveConfig(baseConfig(), {
        rawJson5: "{ persona: { name: 'oops' }",
      });
      expect(result.success).toBe(false);
      expect(result.message).toContain("Raw JSON5 parse error");
    });

    it("rejects non-object rawJson5 top-level", () => {
      const result = saveConfig(baseConfig(), { rawJson5: "[1, 2, 3]" });
      expect(result.success).toBe(false);
      expect(result.message).toContain("must be an object");
    });

    it("requires restart when sessions.type changes", () => {
      // Seed existing sessions config
      const vexDir = path.join(tmpHome, ".vex");
      fs.mkdirSync(vexDir, { recursive: true });
      fs.writeFileSync(
        path.join(vexDir, "config.local.json5"),
        JSON.stringify({ sessions: { type: "memory" } }),
      );
      const current = baseConfig();
      current.sessions = { type: "memory" };

      const result = saveConfig(current, { sessions: { type: "file" } });
      expect(result.success).toBe(true);
      expect(result.requiresRestart).toBe(true);
    });
  });
});