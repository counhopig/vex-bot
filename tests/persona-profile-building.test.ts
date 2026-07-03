/**
 * Tests for persona auto-profile-building background task.
 *
 * Drives the response observer pipeline `triggerTurns` times to trigger the
 * fire-and-forget extraction, and asserts the resulting state of the
 * structured profile store + long-term memory. Injects a fake `llmComplete`
 * via `vi.mock` so the suite stays offline.
 *
 * Test plan (per docs/superpowers/specs/2026-07-03-persona-auto-profile-design.md):
 *  1. Successful extraction writes both structured facts and long-term memory.
 *  2. Duplicate facts are not re-written (profile dedup).
 *  3. confidence < 0.6 facts are filtered out.
 *  4. Malformed JSON does not write anything.
 *  5. Concurrent trigger (same uid before previous resolves) is skipped.
 *  6. Counter only triggers on multiples of triggerTurns.
 *  7. Disabled profileBuildingEnabled skips both increment and extraction.
 */

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboundMessageContext, VexConfig } from "../src/types/index.js";
import { llmComplete } from "../src/providers/llm.js";

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

vi.mock("../src/providers/llm.js", async () => {
  const actual = await vi.importActual<typeof import("../src/providers/llm.js")>("../src/providers/llm.js");
  return {
    ...actual,
    llmComplete: vi.fn(),
  };
});

const mockedLlmComplete = vi.mocked(llmComplete);

function context(senderId = "user-1", messageIdSeed = "msg"): InboundMessageContext {
  return {
    channelId: "webchat",
    chatId: "chat-1",
    chatType: "direct",
    messageId: `${messageIdSeed}-${Math.random().toString(36).slice(2, 8)}`,
    senderId,
    senderName: "Tester",
    content: "我住在深圳，在香港上班",
    timestamp: Date.now(),
  };
}

function baseConfig(overrides: Partial<{ triggerTurns: number; enabled: boolean }> = {}): VexConfig {
  return {
    providers: {},
    channels: {},
    agent: {
      defaultModel: "deepseek-chat",
      defaultProvider: "deepseek",
    },
    server: { port: 3000 },
    logging: { level: "error" },
    persona: {
      enabled: true,
      profile_building_enabled: overrides.enabled ?? true,
      profile_building_trigger_turns: overrides.triggerTurns ?? 2,
    },
  };
}

async function initPersonaOnce(config: VexConfig): Promise<{ memoryManager: import("../src/memory/index.js").MemoryManager }> {
  const { initPersona, cleanupPersona } = await import("../src/extensions/persona/index.js");
  const { MemoryManager } = await import("../src/memory/index.js");
  const memoryManager = new MemoryManager({ directory: join(testHome, "memory"), enabled: true });
  initPersona(config, { memoryManager });
  return {
    memoryManager,
    async cleanup() {
      cleanupPersona();
      await memoryManager.close();
    },
  };
}

async function fireResponse(ctx: InboundMessageContext, reply = "好的，了解了"): Promise<void> {
  const { runResponseObservers } = await import("../src/pipeline/index.js");
  // runResponseObservers awaits observer; the observer awaits extractProfileFacts.
  // Detached when disabled / not at trigger — synchronous path stays fast.
  await runResponseObservers(ctx, reply);
}

async function waitForLlmCalls(expected: number): Promise<void> {
  // Poll until llmComplete has been called `expected` times, or fail after a short window.
  const deadline = Date.now() + 1000;
  while (mockedLlmComplete.mock.calls.length < expected && Date.now() < deadline) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(mockedLlmComplete.mock.calls.length).toBeGreaterThanOrEqual(expected);
}

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "vex-persona-pb-"));
});

afterEach(async () => {
  const { clearPipeline } = await import("../src/pipeline/index.js");
  clearPipeline();
  rmSync(testHome, { recursive: true, force: true });
  mockedLlmComplete.mockReset();
});

describe("persona auto-profile-building", () => {
  it("writes both profile facts and long-term memory after a successful extraction", async () => {
    mockedLlmComplete.mockResolvedValueOnce({
      text: JSON.stringify([
        {
          category: "location",
          content: "住在深圳，在香港上班",
          evidence: "用户主动陈述",
          confidence: 0.9,
        },
      ]),
    });

    const { memoryManager, cleanup } = await initPersonaOnce(baseConfig({ triggerTurns: 2 }));
    try {
      const { PersonaStorage } = await import("../src/extensions/persona/storage.js");
      // First response: counter=1, not at trigger.
      await fireResponse(context("user-a", "m1"));
      // Second response: counter=2, hits trigger; fire-and-forget kicks off.
      const promise = fireResponse(context("user-a", "m2"));
      await waitForLlmCalls(1);
      await promise;

      // After await runResponseObservers, the detached extraction's first LLM call is in flight;
      // resolve it by waiting for writes.
      const store = new PersonaStorage();
      const facts = store.getProfileFacts("webchat:user-a");
      expect(facts).toHaveLength(1);
      expect(facts[0]?.category).toBe("location");
      expect(facts[0]?.content).toBe("住在深圳，在香港上班");

      const memories = await memoryManager.list({ tags: ["persona", "user:webchat:user-a"] });
      const personaFacts = memories.filter((m) => m.content.includes("[location]"));
      expect(personaFacts).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  it("does not duplicate facts when the LLM returns the same content as already recorded", async () => {
    mockedLlmComplete.mockResolvedValueOnce({
      text: JSON.stringify([
        {
          category: "location",
          content: "住在深圳",
          evidence: "再次提及",
          confidence: 0.85,
        },
      ]),
    });

    const { memoryManager, cleanup } = await initPersonaOnce(baseConfig({ triggerTurns: 1 }));
    try {
      const { PersonaStorage } = await import("../src/extensions/persona/storage.js");
      const store = new PersonaStorage();
      // Pre-seed an existing fact so addProfileFact dedupes.
      store.addProfileFact("webchat:user-b", "location", "住在深圳", "之前说过", 0.95);

      // The existing fact is also passed to the LLM via prompt context,
      // but the model's "test response" returns it anyway — dedup guard in
      // extractProfileFacts must catch it.
      const promise = fireResponse(context("user-b", "m1"));
      await waitForLlmCalls(1);
      await promise;

      const facts = store.getProfileFacts("webchat:user-b");
      expect(facts).toHaveLength(1);

      const memories = await memoryManager.list({ tags: ["persona", "user:webchat:user-b"] });
      expect(memories).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it("drops facts whose confidence is below the 0.6 threshold", async () => {
    mockedLlmComplete.mockResolvedValueOnce({
      text: JSON.stringify([
        { category: "mood", content: "今天有点累", evidence: "推测", confidence: 0.4 },
        { category: "job", content: "做产品经理", evidence: "明确提及", confidence: 0.7 },
      ]),
    });

    const { cleanup } = await initPersonaOnce(baseConfig({ triggerTurns: 1 }));
    try {
      const { PersonaStorage } = await import("../src/extensions/persona/storage.js");
      const promise = fireResponse(context("user-c", "m1"));
      await waitForLlmCalls(1);
      await promise;

      const store = new PersonaStorage();
      const facts = store.getProfileFacts("webchat:user-c");
      expect(facts).toHaveLength(1);
      expect(facts[0]?.category).toBe("job");
      expect(facts[0]?.content).toBe("做产品经理");
    } finally {
      await cleanup();
    }
  });

  it("does not write anything when the LLM returns malformed JSON", async () => {
    mockedLlmComplete.mockResolvedValueOnce({
      text: "这是一些解释，但并不是 JSON 数组。",
    });

    const { cleanup } = await initPersonaOnce(baseConfig({ triggerTurns: 1 }));
    try {
      const { PersonaStorage } = await import("../src/extensions/persona/storage.js");
      const promise = fireResponse(context("user-d", "m1"));
      await waitForLlmCalls(1);
      await promise;

      const store = new PersonaStorage();
      expect(store.getProfileFacts("webchat:user-d")).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("does not write anything when the LLM throws", async () => {
    mockedLlmComplete.mockRejectedValueOnce(new Error("provider down"));

    const { cleanup } = await initPersonaOnce(baseConfig({ triggerTurns: 1 }));
    try {
      const { PersonaStorage } = await import("../src/extensions/persona/storage.js");
      const promise = fireResponse(context("user-e", "m1"));
      // Wait for the rejection to have been delivered + caught.
      await promise;
      await new Promise((resolve) => setImmediate(resolve));

      const store = new PersonaStorage();
      expect(store.getProfileFacts("webchat:user-e")).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("skips a second concurrent extraction while one is in flight for the same uid", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockedLlmComplete.mockImplementationOnce(async () => {
      await blocked;
      return {
        text: JSON.stringify([
          { category: "hobby", content: "喜欢看书", evidence: "提过", confidence: 0.8 },
        ]),
      };
    });

    const { cleanup } = await initPersonaOnce(baseConfig({ triggerTurns: 1 }));
    try {
      const { PersonaStorage } = await import("../src/extensions/persona/storage.js");

      // Fire two responses for the same user back-to-back. The first one
      // triggers extraction; the llm call is held by `blocked`.
      const first = fireResponse(context("user-f", "m1"));
      await waitForLlmCalls(1);

      const second = fireResponse(context("user-f", "m2"));
      // Yield so the second observer has fully run; the in-flight guard should have skipped.
      await new Promise((resolve) => setImmediate(resolve));
      expect(mockedLlmComplete.mock.calls.length).toBe(1);

      // Release the held call; first extraction writes one fact.
      release();
      await first;
      await second;

      const store = new PersonaStorage();
      const facts = store.getProfileFacts("webchat:user-f");
      expect(facts).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  it("does not trigger extraction when profileBuildingEnabled is false", async () => {
    const { cleanup } = await initPersonaOnce(baseConfig({ triggerTurns: 1, enabled: false }));
    try {
      await fireResponse(context("user-g", "m1"));
      await fireResponse(context("user-g", "m2"));
      expect(mockedLlmComplete).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it("triggers on the Nth turn and not on the N+1th turn", async () => {
    mockedLlmComplete.mockResolvedValue({
      text: JSON.stringify([
        { category: "habit", content: `事实-${mockedLlmComplete.mock.calls.length}`, evidence: "测试", confidence: 0.9 },
      ]),
    });

    const { cleanup } = await initPersonaOnce(baseConfig({ triggerTurns: 3 }));
    try {
      // Turn 1: counter=1, not multiple of 3.
      await fireResponse(context("user-h", "m1"));
      expect(mockedLlmComplete).not.toHaveBeenCalled();
      // Turn 2: counter=2, not multiple of 3.
      await fireResponse(context("user-h", "m2"));
      expect(mockedLlmComplete).not.toHaveBeenCalled();
      // Turn 3: counter=3, trigger.
      const third = fireResponse(context("user-h", "m3"));
      await waitForLlmCalls(1);
      await third;
      // Turn 4: counter=4, not multiple of 3.
      await fireResponse(context("user-h", "m4"));
      // Still only one llm call so far.
      expect(mockedLlmComplete.mock.calls.length).toBe(1);
    } finally {
      await cleanup();
    }
  });
});
