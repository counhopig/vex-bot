/**
 * Skill Learner tests — per-Agent instance-scoped message interceptor.
 *
 * All tests use real temp dirs (no mocking of storage) to verify the
 * instance-scoped contract: two SkillLearner instances never share state.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

vi.mock("../src/utils/logger.js", () => ({
  getChildLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  SkillLearner,
  createSkillLearner,
  sanitizeSkillName,
  type SkillLearnerOptions,
  type LearnerLlmComplete,
} from "../src/skills/learner/index.js";
import type { InboundMessageContext } from "../src/channels/ChannelAdapter.js";
import { SkillStorage } from "../src/skills/learner/storage.js";
import type { LearnedSkill } from "../src/skills/learner/models.js";

const tempDirs: string[] = [];

function getTestDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vex-skill-learner-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function mockCtx(overrides?: Partial<InboundMessageContext>): InboundMessageContext {
  return {
    channelId: "webchat",
    messageId: "m1",
    chatId: "c1",
    chatType: "direct",
    senderId: "u1",
    content: "hello",
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeLearner(overrides?: Partial<SkillLearnerOptions>): SkillLearner {
  return createSkillLearner({
    config: {},
    ownerId: "owner-1",
    stateDir: getTestDir(),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// (a) /skill_learn starts a session and subsequent messages are captured
// ---------------------------------------------------------------------------

describe("SkillLearner — session lifecycle", () => {
  it("(a) /skill_learn starts a session and subsequent messages are captured", async () => {
    const learner = makeLearner();

    const start = await learner.interceptor(mockCtx({ content: "/skill_learn" }));
    expect(start).toContain("已进入技能学习模式");

    const cap1 = await learner.interceptor(mockCtx({ content: "First learning message" }));
    expect(cap1).toContain("已记录 1 条内容");

    const cap2 = await learner.interceptor(mockCtx({ content: "Second learning message" }));
    expect(cap2).toBeNull(); // 2 is not an encouragement milestone

    const cap3 = await learner.interceptor(mockCtx({ content: "Third learning message" }));
    expect(cap3).toContain("已记录 3 条内容");
  });

  it("restores an active learning session after the feature is rebuilt", async () => {
    const stateDir = getTestDir();
    const first = createSkillLearner({ config: {}, ownerId: "owner-1", stateDir });
    await first.interceptor(mockCtx({ content: "/skill_learn" }));
    await first.interceptor(mockCtx({ content: "Persist this" }));

    const restored = createSkillLearner({ config: {}, ownerId: "owner-1", stateDir });
    const status = await restored.interceptor(mockCtx({ content: "/skill_status" }));
    expect(status).toContain("已记录 1 条消息");
  });

  it("(c) /skill_cancel ends the session", async () => {
    const learner = makeLearner();

    await learner.interceptor(mockCtx({ content: "/skill_learn" }));
    const cancel = await learner.interceptor(mockCtx({ content: "/skill_cancel" }));
    expect(cancel).toContain("已取消");

    const status = await learner.interceptor(mockCtx({ content: "/skill_status" }));
    expect(status).toContain("没有进行中的技能学习会话");
  });

  it("(d) /skill_status reports state", async () => {
    const learner = makeLearner();

    const empty = await learner.interceptor(mockCtx({ content: "/skill_status" }));
    expect(empty).toContain("没有进行中的技能学习会话");

    await learner.interceptor(mockCtx({ content: "/skill_learn" }));
    await learner.interceptor(mockCtx({ content: "msg1" }));
    await learner.interceptor(mockCtx({ content: "msg2" }));

    const active = await learner.interceptor(mockCtx({ content: "/skill_status" }));
    expect(active).toContain("已记录 2 条消息");
  });

  it("messages starting with / are skipped during capture", async () => {
    const learner = makeLearner();

    await learner.interceptor(mockCtx({ content: "/skill_learn" }));
    const slashMsg = await learner.interceptor(mockCtx({ content: "/some-other-command" }));
    expect(slashMsg).toBeNull();

    const status = await learner.interceptor(mockCtx({ content: "/skill_status" }));
    expect(status).toContain("已记录 0 条消息");
  });

  it("maxLearningTurns cap stops capture with notice", async () => {
    const learner = makeLearner({ config: { maxLearningTurns: 3 } });

    await learner.interceptor(mockCtx({ content: "/skill_learn" }));
    await learner.interceptor(mockCtx({ content: "msg1" }));
    await learner.interceptor(mockCtx({ content: "msg2" }));

    const cap3 = await learner.interceptor(mockCtx({ content: "msg3" }));
    expect(cap3).toContain("已达到最多 3 条学习内容");

    // After cap, further messages still get the same notice
    const cap4 = await learner.interceptor(mockCtx({ content: "msg4" }));
    expect(cap4).toContain("已达到最多 3 条学习内容");
  });
});

describe("SkillLearner — deployment isolation", () => {
  it("deploys and deletes only inside the assigned user skills directory", () => {
    const root = getTestDir();
    const userA = path.join(root, "users", "a");
    const userB = path.join(root, "users", "b");
    const skill: LearnedSkill = {
      skillId: "s1",
      name: "shared-name",
      displayName: "Shared",
      skillType: "knowledge",
      description: "test",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      createdBy: "a",
      sourceSession: "session",
      tags: [],
      skillMdContent: "# user-a",
      additionalFiles: {},
      usageCount: 0,
    };
    const storageA = new SkillStorage(path.join(root, "state-a"), userA);
    const storageB = new SkillStorage(path.join(root, "state-b"), userB);

    storageA.deployToSkills(skill);
    storageB.deployToSkills({ ...skill, skillMdContent: "# user-b" });
    storageA.undeployFromSkills(skill.name);

    expect(fs.existsSync(path.join(userA, skill.name))).toBe(false);
    expect(fs.readFileSync(path.join(userB, skill.name, "SKILL.md"), "utf-8")).toBe("# user-b");
  });
});

// ---------------------------------------------------------------------------
// (b) /skill_save generates + saves + deploys a SKILL.md
// ---------------------------------------------------------------------------

describe("SkillLearner — save and deploy", () => {
  it("(b) /skill_save generates + saves + deploys a SKILL.md to a temp skillsDir", async () => {
    const skillsDir = getTestDir();
    const learner = makeLearner({ skillsDir, config: { autoDeployToSkills: true } });

    await learner.interceptor(mockCtx({ content: "/skill_learn" }));
    await learner.interceptor(mockCtx({ content: "Knowledge point A" }));
    await learner.interceptor(mockCtx({ content: "Knowledge point B" }));

    const saveReply = await learner.interceptor(mockCtx({ content: "/skill_save my-test-skill" }));
    expect(saveReply).toContain("技能已保存并部署：my-test-skill");
    expect(saveReply).toContain(skillsDir);

    // Verify deployed SKILL.md
    const deployedMdPath = path.join(skillsDir, "my-test-skill", "SKILL.md");
    expect(fs.existsSync(deployedMdPath)).toBe(true);
    const deployedMd = fs.readFileSync(deployedMdPath, "utf-8");
    expect(deployedMd).toContain("name: my-test-skill");
    expect(deployedMd).toContain("Knowledge point A");
    expect(deployedMd).toContain("Knowledge point B");

    // Verify backup in stateDir
    const stateDir = (learner as unknown as Record<string, unknown>).storage
      ? (learner as unknown as Record<string, { stateDir: string }>).storage.stateDir
      : "";
    // Accessing private field for test verification is acceptable; cast avoids TS errors.
    const backupMdPath = path.join(stateDir, "skills", "my-test-skill", "SKILL.md");
    expect(fs.existsSync(backupMdPath)).toBe(true);
  });

  it("(i) deterministic fallback markdown when no complete injected", async () => {
    const skillsDir = getTestDir();
    const learner = makeLearner({ skillsDir, config: { autoDeployToSkills: true } });

    await learner.interceptor(mockCtx({ content: "/skill_learn" }));
    await learner.interceptor(mockCtx({ content: "Fallback content" }));

    await learner.interceptor(mockCtx({ content: "/skill_save fallback-skill" }));

    const deployedMdPath = path.join(skillsDir, "fallback-skill", "SKILL.md");
    const deployedMd = fs.readFileSync(deployedMdPath, "utf-8");
    expect(deployedMd).toContain("name: fallback-skill");
    expect(deployedMd).toContain("## Knowledge");
    expect(deployedMd).toContain("- Fallback content");
  });

  it("uses LLM complete when provided and result looks valid", async () => {
    const skillsDir = getTestDir();
    const complete: LearnerLlmComplete = async () => ({
      text: "---\nname: llm-skill\n---\n# LLM Generated\n\nCustom content.\n",
    });
    const learner = makeLearner({ skillsDir, config: { autoDeployToSkills: true }, complete });

    await learner.interceptor(mockCtx({ content: "/skill_learn" }));
    await learner.interceptor(mockCtx({ content: "Some input" }));

    await learner.interceptor(mockCtx({ content: "/skill_save llm-skill" }));

    const deployedMdPath = path.join(skillsDir, "llm-skill", "SKILL.md");
    const deployedMd = fs.readFileSync(deployedMdPath, "utf-8");
    expect(deployedMd).toContain("# LLM Generated");
    expect(deployedMd).toContain("Custom content.");
  });

  it("falls back to deterministic markdown when LLM complete returns invalid shape", async () => {
    const skillsDir = getTestDir();
    const complete: LearnerLlmComplete = async () => ({ text: "no frontmatter no header" });
    const learner = makeLearner({ skillsDir, config: { autoDeployToSkills: true }, complete });

    await learner.interceptor(mockCtx({ content: "/skill_learn" }));
    await learner.interceptor(mockCtx({ content: "Input data" }));

    await learner.interceptor(mockCtx({ content: "/skill_save invalid-skill" }));

    const deployedMdPath = path.join(skillsDir, "invalid-skill", "SKILL.md");
    const deployedMd = fs.readFileSync(deployedMdPath, "utf-8");
    expect(deployedMd).toContain("## Knowledge");
    expect(deployedMd).toContain("- Input data");
  });

  it("falls back to deterministic markdown when LLM complete throws", async () => {
    const skillsDir = getTestDir();
    const complete: LearnerLlmComplete = async () => {
      throw new Error("LLM failure");
    };
    const learner = makeLearner({ skillsDir, config: { autoDeployToSkills: true }, complete });

    await learner.interceptor(mockCtx({ content: "/skill_learn" }));
    await learner.interceptor(mockCtx({ content: "Throw data" }));

    await learner.interceptor(mockCtx({ content: "/skill_save throw-skill" }));

    const deployedMdPath = path.join(skillsDir, "throw-skill", "SKILL.md");
    const deployedMd = fs.readFileSync(deployedMdPath, "utf-8");
    expect(deployedMd).toContain("- Throw data");
  });

  it("save without deploy when autoDeployToSkills is false", async () => {
    const skillsDir = getTestDir();
    const learner = makeLearner({ skillsDir, config: { autoDeployToSkills: false } });

    await learner.interceptor(mockCtx({ content: "/skill_learn" }));
    await learner.interceptor(mockCtx({ content: "No deploy" }));

    const saveReply = await learner.interceptor(mockCtx({ content: "/skill_save no-deploy-skill" }));
    expect(saveReply).toContain("技能已保存：no-deploy-skill");
    expect(saveReply).not.toContain("部署");

    const deployedMdPath = path.join(skillsDir, "no-deploy-skill", "SKILL.md");
    expect(fs.existsSync(deployedMdPath)).toBe(false);
  });

  it("save without arg uses proposedName fallback", async () => {
    const skillsDir = getTestDir();
    const learner = makeLearner({ skillsDir, config: { autoDeployToSkills: true } });

    await learner.interceptor(mockCtx({ content: "/skill_learn" }));
    await learner.interceptor(mockCtx({ content: "One" }));

    const saveReply = await learner.interceptor(mockCtx({ content: "/skill_save" }));
    expect(saveReply).toContain("learned-skill");
  });

  it("save with empty session returns error", async () => {
    const learner = makeLearner();

    await learner.interceptor(mockCtx({ content: "/skill_learn" }));
    const saveReply = await learner.interceptor(mockCtx({ content: "/skill_save empty-skill" }));
    expect(saveReply).toContain("没有可保存的学习内容");
  });
});

// ---------------------------------------------------------------------------
// (e) auto-trigger keyword
// ---------------------------------------------------------------------------

describe("SkillLearner — auto-trigger", () => {
  it("(e) auto-trigger keyword starts a session and intercepts", async () => {
    const learner = makeLearner({
      config: {
        enableAutoLearn: true,
        autoTriggerKeywords: ["教我", "学习一下"],
      },
    });

    const trigger = await learner.interceptor(mockCtx({ content: "请教我如何写代码" }));
    expect(trigger).toContain("已进入技能学习模式");

    // Subsequent message is captured
    const cap = await learner.interceptor(mockCtx({ content: "First lesson" }));
    expect(cap).toContain("已记录 1 条内容");
  });

  it("does not auto-trigger when enableAutoLearn is false", async () => {
    const learner = makeLearner({
      config: {
        enableAutoLearn: false,
        autoTriggerKeywords: ["教我"],
      },
    });

    const result = await learner.interceptor(mockCtx({ content: "请教我" }));
    expect(result).toBeNull();
  });

  it("does not auto-trigger when no keywords match", async () => {
    const learner = makeLearner({
      config: {
        enableAutoLearn: true,
        autoTriggerKeywords: ["教我"],
      },
    });

    const result = await learner.interceptor(mockCtx({ content: "hello world" }));
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (f) pass-through
// ---------------------------------------------------------------------------

describe("SkillLearner — pass-through", () => {
  it("(f) non-command messages pass through (null) when no session active and no auto-trigger", async () => {
    const learner = makeLearner();

    const result = await learner.interceptor(mockCtx({ content: "Just a normal message" }));
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (g) cross-user isolation
// ---------------------------------------------------------------------------

describe("SkillLearner — cross-user isolation", () => {
  it("(g) TWO SkillLearner instances with different ownerIds do NOT share learning state or deployed skills", async () => {
    const stateDirA = getTestDir();
    const stateDirB = getTestDir();
    const skillsDirA = getTestDir();
    const skillsDirB = getTestDir();

    const learnerA = makeLearner({ ownerId: "owner-a", stateDir: stateDirA, skillsDir: skillsDirA, config: { autoDeployToSkills: true } });
    const learnerB = makeLearner({ ownerId: "owner-b", stateDir: stateDirB, skillsDir: skillsDirB, config: { autoDeployToSkills: true } });

    // Start session in A
    await learnerA.interceptor(mockCtx({ content: "/skill_learn" }));
    await learnerA.interceptor(mockCtx({ content: "A-only content" }));

    // B should not see the session
    const bStatus = await learnerB.interceptor(mockCtx({ content: "/skill_status" }));
    expect(bStatus).toContain("没有进行中的技能学习会话");

    // Save in A
    await learnerA.interceptor(mockCtx({ content: "/skill_save isolated-skill" }));

    // B should not have the deployed skill
    const bView = await learnerB.interceptor(mockCtx({ content: "/skill_view isolated-skill" }));
    expect(bView).toContain("未找到技能");

    // A should have it
    const aView = await learnerA.interceptor(mockCtx({ content: "/skill_view isolated-skill" }));
    expect(aView).toContain("A-only content");
  });
});

// ---------------------------------------------------------------------------
// (h) shutdown
// ---------------------------------------------------------------------------

describe("SkillLearner — shutdown", () => {
  it("(h) shutdown() is idempotent and cleans up", async () => {
    const learner = makeLearner();

    await learner.interceptor(mockCtx({ content: "/skill_learn" }));
    await learner.interceptor(mockCtx({ content: "msg" }));

    learner.shutdown();
    learner.shutdown(); // idempotent

    // After shutdown, interceptor returns null
    const after = await learner.interceptor(mockCtx({ content: "/skill_status" }));
    expect(after).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Command aliases and edge cases
// ---------------------------------------------------------------------------

describe("SkillLearner — command aliases", () => {
  it("supports all Chinese command aliases", async () => {
    const learner = makeLearner();

    const learn = await learner.interceptor(mockCtx({ content: "/学习技能" }));
    expect(learn).toContain("已进入技能学习模式");

    const cancel = await learner.interceptor(mockCtx({ content: "/取消学习" }));
    expect(cancel).toContain("已取消");

    await learner.interceptor(mockCtx({ content: "/学习技能" }));
    const status = await learner.interceptor(mockCtx({ content: "/学习状态" }));
    expect(status).toContain("已记录");

    await learner.interceptor(mockCtx({ content: "some content" }));
    const save = await learner.interceptor(mockCtx({ content: "/保存技能 alias-skill" }));
    expect(save).toContain("技能已保存");

    const list = await learner.interceptor(mockCtx({ content: "/技能列表" }));
    expect(list).toContain("alias-skill");

    const view = await learner.interceptor(mockCtx({ content: "/查看技能 alias-skill" }));
    expect(view).toContain("some content");

    const exportCmd = await learner.interceptor(mockCtx({ content: "/导出技能 alias-skill" }));
    expect(exportCmd).toContain("some content");

    const help = await learner.interceptor(mockCtx({ content: "/技能帮助" }));
    expect(help).toContain("/skill_learn");

    const del = await learner.interceptor(mockCtx({ content: "/删除技能 alias-skill" }));
    expect(del).toContain("已删除");
  });

  it("/skill_help returns command list", async () => {
    const learner = makeLearner();
    const help = await learner.interceptor(mockCtx({ content: "/skill_help" }));
    expect(help).toContain("/skill_learn");
    expect(help).toContain("/skill_save");
    expect(help).toContain("/skill_cancel");
    expect(help).toContain("/skill_status");
    expect(help).toContain("/skill_list");
    expect(help).toContain("/skill_view");
    expect(help).toContain("/skill_delete");
    expect(help).toContain("/skill_export");
  });

  it("/skill_delete removes skill and undeploys", async () => {
    const skillsDir = getTestDir();
    const learner = makeLearner({ skillsDir, config: { autoDeployToSkills: true } });

    await learner.interceptor(mockCtx({ content: "/skill_learn" }));
    await learner.interceptor(mockCtx({ content: "del content" }));
    await learner.interceptor(mockCtx({ content: "/skill_save del-skill" }));

    expect(fs.existsSync(path.join(skillsDir, "del-skill", "SKILL.md"))).toBe(true);

    const del = await learner.interceptor(mockCtx({ content: "/skill_delete del-skill" }));
    expect(del).toContain("已删除");

    expect(fs.existsSync(path.join(skillsDir, "del-skill", "SKILL.md"))).toBe(false);
  });

  it("/skill_delete on missing skill returns not-found", async () => {
    const learner = makeLearner();
    const del = await learner.interceptor(mockCtx({ content: "/skill_delete missing-skill" }));
    expect(del).toContain("未找到技能");
  });

  it("/skill_view on missing skill returns not-found", async () => {
    const learner = makeLearner();
    const view = await learner.interceptor(mockCtx({ content: "/skill_view missing-skill" }));
    expect(view).toContain("未找到技能");
  });

  it("/skill_list returns empty message when no skills", async () => {
    const learner = makeLearner();
    const list = await learner.interceptor(mockCtx({ content: "/skill_list" }));
    expect(list).toContain("还没有保存的技能");
  });
});

// ---------------------------------------------------------------------------
// sanitizeSkillName
// ---------------------------------------------------------------------------

describe("sanitizeSkillName", () => {
  it("removes invalid characters and replaces with hyphen", () => {
    expect(sanitizeSkillName("hello world!!!")).toBe("hello-world");
  });

  it("trims leading and trailing hyphens", () => {
    expect(sanitizeSkillName("---test---")).toBe("test");
  });

  it("falls back to timestamp when empty after sanitization", () => {
    const result = sanitizeSkillName("!!!");
    expect(result.startsWith("skill-")).toBe(true);
  });

  it("preserves unicode letters and numbers", () => {
    expect(sanitizeSkillName("中文技能123")).toBe("中文技能123");
  });
});

// ---------------------------------------------------------------------------
// Group chat keying
// ---------------------------------------------------------------------------

describe("SkillLearner — group chat isolation", () => {
  it("isolates sessions by chatId in group chats", async () => {
    const learner = makeLearner();

    const group1 = mockCtx({ chatType: "group", chatId: "g1", content: "/skill_learn" });
    const group2 = mockCtx({ chatType: "group", chatId: "g2", content: "/skill_learn" });

    await learner.interceptor(group1);
    await learner.interceptor(group2);

    await learner.interceptor(mockCtx({ chatType: "group", chatId: "g1", content: "msg-for-g1" }));
    await learner.interceptor(mockCtx({ chatType: "group", chatId: "g2", content: "msg-for-g2" }));

    const status1 = await learner.interceptor(mockCtx({ chatType: "group", chatId: "g1", content: "/skill_status" }));
    expect(status1).toContain("已记录 1 条消息");

    const status2 = await learner.interceptor(mockCtx({ chatType: "group", chatId: "g2", content: "/skill_status" }));
    expect(status2).toContain("已记录 1 条消息");
  });
});

// ---------------------------------------------------------------------------
// Memory integration
// ---------------------------------------------------------------------------

describe("SkillLearner — memory integration", () => {
  it("calls memoryManager.remember on save when provided", async () => {
    const remember = vi.fn().mockResolvedValue("mem-id");
    const memoryManager = {
      remember,
    } as unknown as import("../src/memory/index.js").MemoryManager;

    const learner = makeLearner({ memoryManager });

    await learner.interceptor(mockCtx({ content: "/skill_learn" }));
    await learner.interceptor(mockCtx({ content: "Memory test content" }));
    await learner.interceptor(mockCtx({ content: "/skill_save mem-skill" }));

    expect(remember).toHaveBeenCalledOnce();
    const call = remember.mock.calls[0]!;
    expect(call[0]).toContain("保存的技能：mem-skill");
    expect(call[0]).toContain("Memory test content");
    expect(call[1]).toMatchObject({
      type: "note",
      source: expect.stringContaining("skilllearner:"),
      tags: expect.arrayContaining(["skill", "skill:mem-skill"]),
    });
  });
});
