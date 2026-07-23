/**
 * Tests for the persona memory directive.
 *
 * The persona injector already puts the user's stored profile facts and recent
 * history into the system prompt, but as inert data. Weak models (e.g. the one
 * in the field report) ignored it and answered "I have no memory of you". The
 * fix frames the injected persona/profile/history as the assistant's own memory
 * and explicitly forbids disclaiming memory.
 */

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboundMessageContext, VexConfig } from "../src/types/index.js";

vi.mock("../src/utils/logger.js", () => ({
  getChildLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

let testHome = "";
vi.mock("os", async () => {
  const actual = await vi.importActual<typeof import("os")>("os");
  return { ...actual, homedir: vi.fn(() => testHome) };
});

function context(senderId = "user-1"): InboundMessageContext {
  return {
    channelId: "webchat",
    chatId: "chat-1",
    chatType: "direct",
    messageId: `m-${Math.random().toString(36).slice(2, 8)}`,
    senderId,
    senderName: "Tester",
    content: "我是谁",
    timestamp: Date.now(),
  };
}

function baseConfig(): VexConfig {
  return {
    providers: {},
    channels: {},
    agent: { defaultModel: "deepseek-chat", defaultProvider: "deepseek" },
    server: { port: 3000 },
    logging: { level: "error" },
    persona: { enabled: true },
  };
}

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "vex-persona-mem-"));
});

afterEach(async () => {
  const { cleanupPersona } = await import("../src/extensions/persona/index.js");
  cleanupPersona();
  const { clearPipeline } = await import("../src/pipeline/index.js");
  clearPipeline();
  rmSync(testHome, { recursive: true, force: true });
});

describe("persona memory directive", () => {
  it("frames stored profile facts as the assistant's own memory and forbids claiming amnesia", async () => {
    const { initPersona } = await import("../src/extensions/persona/index.js");
    const { PersonaStorage } = await import("../src/extensions/persona/storage.js");
    const { gatherPromptInjections } = await import("../src/pipeline/index.js");

    // Single-user WebChat unifies onto one persona key ("webchat").
    const store = new PersonaStorage();
    store.addProfileFact("webchat", "居住地", "深圳", "用户说过", 0.9);

    initPersona(baseConfig());
    const injections = await gatherPromptInjections(context("user-1"));
    const persona = injections.join("\n\n");

    // Sanity: the fact still reaches the prompt.
    expect(persona).toContain("深圳");
    // The fix: a directive framing it as memory, placed before the persona body,
    // that forbids the model from disclaiming memory.
    expect(persona).toContain("【记忆】");
    expect(persona).toContain("没有记忆");
    expect(persona.indexOf("【记忆】")).toBeLessThan(persona.indexOf("【私人 Persona】"));
  });

  it("still forbids disclaiming memory for a brand-new user with no stored facts", async () => {
    const { initPersona } = await import("../src/extensions/persona/index.js");
    const { gatherPromptInjections } = await import("../src/pipeline/index.js");

    initPersona(baseConfig());
    const injections = await gatherPromptInjections(context("fresh-user"));
    const persona = injections.join("\n\n");

    expect(persona).toContain("【记忆】");
    expect(persona).toContain("没有记忆");
  });
});
