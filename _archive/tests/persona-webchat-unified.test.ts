/**
 * All of a web user's WebChat sessions must share ONE persona, while other
 * channels (weixin) keep a persona per sender.
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

function webchatCtx(ownerId: string, senderId: string): InboundMessageContext {
  return {
    channelId: "webchat",
    chatId: `webchat:${ownerId}:${senderId}`,
    chatType: "direct",
    messageId: `m-${Math.random().toString(36).slice(2, 8)}`,
    senderId,
    senderName: "Tester",
    content: "hi",
    timestamp: Date.now(),
    raw: { __webUserId: ownerId },
  };
}

function weixinCtx(ownerId: string, senderId: string): InboundMessageContext {
  return {
    channelId: "weixin",
    chatId: "chat",
    chatType: "direct",
    messageId: `m-${Math.random().toString(36).slice(2, 8)}`,
    senderId,
    senderName: "Tester",
    content: "hi",
    timestamp: Date.now(),
    raw: { __webUserId: ownerId },
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
  testHome = mkdtempSync(join(tmpdir(), "vex-persona-unified-"));
});

afterEach(async () => {
  const { cleanupPersona } = await import("../src/extensions/persona/index.js");
  cleanupPersona();
  const { clearPipeline } = await import("../src/pipeline/index.js");
  clearPipeline();
  rmSync(testHome, { recursive: true, force: true });
});

async function inject(ctx: InboundMessageContext): Promise<string> {
  const { gatherPromptInjections } = await import("../src/pipeline/index.js");
  return (await gatherPromptInjections(ctx)).join("\n\n");
}

describe("persona WebChat unification", () => {
  it("shares one persona across all of a web user's WebChat sessions", async () => {
    const { initPersona } = await import("../src/extensions/persona/index.js");
    const { PersonaStorage } = await import("../src/extensions/persona/storage.js");

    // Seed a fact under the unified per-user WebChat key.
    new PersonaStorage().addProfileFact("webchat:owner-1", "居住地", "深圳", "seed", 0.9);

    initPersona(baseConfig(), { ownerId: "owner-1" });

    // Two different WebChat sessions of the same web user both see the fact.
    expect(await inject(webchatCtx("owner-1", "session-A"))).toContain("深圳");
    expect(await inject(webchatCtx("owner-1", "session-B"))).toContain("深圳");
  });

  it("keeps weixin personas separate per sender", async () => {
    const { initPersona } = await import("../src/extensions/persona/index.js");
    const { PersonaStorage } = await import("../src/extensions/persona/storage.js");

    new PersonaStorage().addProfileFact("weixin:owner-1:openid-A", "居住地", "北京", "seed", 0.9);

    initPersona(baseConfig(), { ownerId: "owner-1" });

    expect(await inject(weixinCtx("owner-1", "openid-A"))).toContain("北京");
    // A different weixin contact must NOT inherit contact A's persona.
    expect(await inject(weixinCtx("owner-1", "openid-B"))).not.toContain("北京");
  });
});
