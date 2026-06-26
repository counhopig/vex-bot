import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboundMessageContext, VexConfig } from "../src/types/index.js";

vi.mock("../src/utils/logger.js", () => ({
  getChildLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("os", async () => {
  const actual = await vi.importActual<typeof import("os")>("os");
  return {
    ...actual,
    homedir: vi.fn(() => testHome),
  };
});

let testHome = "";

function context(content: string): InboundMessageContext {
  return {
    channelId: "webchat",
    chatId: "chat-1",
    chatType: "direct",
    messageId: `msg-${Date.now()}`,
    senderId: "user-1",
    senderName: "Tester",
    content,
    timestamp: Date.now(),
  };
}

function config(): VexConfig {
  return {
    providers: {},
    channels: {},
    agent: {
      defaultModel: "deepseek-chat",
      defaultProvider: "deepseek",
    },
    server: {
      port: 3000,
    },
    logging: {
      level: "info",
    },
    skillLearner: {
      enabled: true,
      autoTriggerKeywords: ["记住这个"],
      maxLearningTurns: 20,
      enableAutoLearn: true,
      enableProactiveSuggest: true,
      proactiveThreshold: 3,
      autoDeployToSkills: true,
    },
    sharelink: {
      enabled: true,
      autoDetect: false,
    },
    persona: {
      enabled: true,
    },
  };
}

beforeEach(async () => {
  testHome = mkdtempSync(join(tmpdir(), "vex-ext-"));
  const { clearPipeline } = await import("../src/pipeline/index.js");
  clearPipeline();
});

afterEach(async () => {
  const { clearPipeline } = await import("../src/pipeline/index.js");
  clearPipeline();
  rmSync(testHome, { recursive: true, force: true });
});

describe("pipeline extensions", () => {
  it("returns first interceptor result when multiple interceptors are registered", async () => {
    const { registerMessageInterceptor, runMessageInterceptors } = await import("../src/pipeline/index.js");
    registerMessageInterceptor("first", async () => "handled");
    registerMessageInterceptor("second", async () => "ignored");

    const result = await runMessageInterceptors(context("hello"));

    expect(result).toBe("handled");
  });

  it("gathers non-empty prompt injections in registration order", async () => {
    const { gatherPromptInjections, registerPromptInjector } = await import("../src/pipeline/index.js");
    registerPromptInjector("empty", async () => "");
    registerPromptInjector("persona", async () => "persona block");
    registerPromptInjector("memory", async () => "memory block");

    const result = await gatherPromptInjections(context("hello"));

    expect(result).toEqual(["persona block", "memory block"]);
  });
});

describe("ShareLink", () => {
  it("matches Bilibili BV ids and YouTube urls", async () => {
    const { BilibiliAdapter } = await import("../src/extensions/sharelink/platforms/bilibili.js");
    const { YouTubeAdapter } = await import("../src/extensions/sharelink/platforms/youtube.js");

    const bilibili = new BilibiliAdapter();
    const youtube = new YouTubeAdapter();

    expect(bilibili.match("BV1xx411c7mD")).toBe(true);
    expect(bilibili.extractId("https://www.bilibili.com/video/BV1xx411c7mD")).toBe("1xx411c7mD");
    expect(youtube.match("https://youtu.be/dQw4w9WgXcQ")).toBe(true);
    expect(youtube.extractId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });
});

describe("Skill Learner", () => {
  it("captures messages and saves a deployed SKILL.md", async () => {
    const { initSkillLearner, cleanupSkillLearner } = await import("../src/extensions/skilllearner/index.js");
    const { runMessageInterceptors } = await import("../src/pipeline/index.js");
    initSkillLearner(config());

    await expect(runMessageInterceptors(context("/skill_learn"))).resolves.toContain("技能学习模式");
    await expect(runMessageInterceptors(context("第一条知识"))).resolves.toContain("已记录 1 条");
    const saved = await runMessageInterceptors(context("/skill_save 测试技能"));

    expect(saved).toContain("技能已保存并部署");
    await expect(runMessageInterceptors(context("/skill_list"))).resolves.toContain("测试技能");
    cleanupSkillLearner();
  });
});

describe("Persona", () => {
  it("injects persona state and records assistant responses", async () => {
    const { initPersona, cleanupPersona } = await import("../src/extensions/persona/index.js");
    const { gatherPromptInjections, runResponseObservers, runMessageInterceptors } = await import("../src/pipeline/index.js");
    initPersona(config());

    const prompt = await gatherPromptInjections(context("你好"));
    await runResponseObservers(context("你好"), "你好呀");
    const summary = await runMessageInterceptors(context("/persona"));

    expect(prompt.join("\n")).toContain("私人 Persona");
    expect(summary).toContain("状态");
    cleanupPersona();
  });
});
