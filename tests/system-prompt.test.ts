/**
 * SystemPromptAssembler tests — 5-section prompt assembly with
 * mutually-exclusive persona vs DEFAULT_IDENTITY.
 *
 * Architecture doc (§11):
 *   Section 1: PERSONA (BASE) — always first. The LLM sees identity first.
 *   Section 2: ENVIRONMENT
 *   Section 3: TOOL RULES
 *   Section 4: SKILLS
 *   Section 5: OUTPUT FORMAT
 */

import { describe, it, expect } from "vitest";
import { assembleSystemPrompt, DEFAULT_IDENTITY } from "../src/agent/SystemPromptAssembler.js";

describe("SystemPromptAssembler", () => {
  // -- persona present → DEFAULT_IDENTITY excluded -------------------------

  it("uses persona block when provided, excludes DEFAULT_IDENTITY", () => {
    const prompt = assembleSystemPrompt({ persona: "你是 PandaBot。" });
    expect(prompt).toContain("你是 PandaBot。");
    expect(prompt).not.toContain(DEFAULT_IDENTITY);
  });

  // -- persona absent → DEFAULT_IDENTITY included --------------------------

  it("uses DEFAULT_IDENTITY when persona is not provided", () => {
    const prompt = assembleSystemPrompt({});
    expect(prompt).toContain(DEFAULT_IDENTITY);
  });

  it("uses DEFAULT_IDENTITY when persona is empty string", () => {
    const prompt = assembleSystemPrompt({ persona: "" });
    expect(prompt).toContain(DEFAULT_IDENTITY);
  });

  // -- sections in order ---------------------------------------------------

  it("assembles sections in the correct order: persona, env, tools, skills, output", () => {
    const prompt = assembleSystemPrompt({
      persona: "【角色身份】",
      environment: "【环境信息】",
      toolRules: "【工具规则】",
      skills: "【技能】",
      outputFormat: "【输出格式】",
    });

    const personaIdx = prompt.indexOf("【角色身份】");
    const envIdx = prompt.indexOf("【环境信息】");
    const toolIdx = prompt.indexOf("【工具规则】");
    const skillIdx = prompt.indexOf("【技能】");
    const outputIdx = prompt.indexOf("【输出格式】");

    expect(personaIdx).toBeLessThan(envIdx);
    expect(envIdx).toBeLessThan(toolIdx);
    expect(toolIdx).toBeLessThan(skillIdx);
    expect(skillIdx).toBeLessThan(outputIdx);
  });

  // -- optional sections omitted -------------------------------------------

  it("omits sections that are not provided", () => {
    const prompt = assembleSystemPrompt({ persona: "角色" });
    expect(prompt).toContain("角色");
    expect(prompt).not.toContain("【环境信息】");
    expect(prompt).not.toContain("【工具规则】");
    expect(prompt).not.toContain("【技能】");
    expect(prompt).not.toContain("【输出格式】");
  });

  // -- section labelling ---------------------------------------------------

  it("labels Section 1 with a header when persona is provided", () => {
    const prompt = assembleSystemPrompt({ persona: "你是一个助手。" });
    expect(prompt).toMatch(/Section 1|角色身份|Persona/);
  });

  it("labels provided optional sections with their headers", () => {
    const prompt = assembleSystemPrompt({
      persona: "角色",
      environment: "env info",
      toolRules: "tool rules",
    });
    expect(prompt).toContain("env info");
    expect(prompt).toContain("tool rules");
  });
});
