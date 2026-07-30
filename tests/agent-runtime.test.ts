/**
 * AgentRuntime tests — wraps @mariozechner/pi-coding-agent to provide
 * per-sessionKey, lock-serialized, single-LLM-call access.
 *
 * The runtime never imports the real pi-coding-agent at test time; the
 * createPiSession factory is injected so each test can supply a fake
 * session object exposing the same surface (`prompt`, `agent.waitForIdle`,
 * `getLastAssistantText`, `getSessionStats`, `agent.setSystemPrompt`,
 * `agent.setBaseSystemPrompt`, `agent.setTools`, `agent.streamFn`, `dispose`).
 *
 * The fake session models pi-coding-agent's reset behavior: when
 * custom tools are present, `session.prompt()`'s before_agent_start
 * extension hook overwrites the agent's system prompt with the
 * private `_baseSystemPrompt` field. Tests that exercise this
 * path use `__promptsAsSeenByModel` to assert what the LLM actually
 * saw, not just what AgentRuntime set.
 *
 * ModelResolver is also injected. Tests that need a specific provider
 * shape construct one inline; the canonical ModelResolver has its own
 * 57-test suite (tests/model-resolver.test.ts) and is not retested here.
 */

import { describe, it, expect } from "vitest";
import {
  AgentRuntime,
  type AgentRuntimeConfig,
  type CreatePiSessionFn,
  type PiSession,
  type PiAgent,
  type PiSessionStats,
} from "../src/agent/AgentRuntime.js";
import type { InboundMessageContext } from "../src/channels/ChannelAdapter.js";
import type { Model } from "@mariozechner/pi-ai";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

type PromptAsSeenByModel = { userContent: string; systemPromptAsSeen: string };

type TrackingSession = PiSession & {
  __promptCalls: string[];
  __setSystemPromptCalls: string[];
  __setBaseSystemPromptCalls: string[];
  __setToolsCalls: unknown[];
  __disposed: boolean[];
  /** What the LLM actually saw on each prompt() call after the
   *  pi-coding-agent reset. The fake models this by snapshotting
   *  the most recent setBaseSystemPrompt value at prompt() time. */
  __promptsAsSeenByModel: PromptAsSeenByModel[];
};

function makeFakeModel(provider: string, id = "fake-model"): Model<"openai-completions"> {
  return {
    id,
    name: "Fake Model",
    api: "openai-completions",
    provider: provider as Model["provider"],
    baseUrl: "https://fake.example.com/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  };
}

function makeFakeSession(opts: {
  lastText?: string;
  tokens?: { input: number; output: number; total: number };
  promptGate?: { promise: Promise<void>; resolve: () => void };
} = {}): TrackingSession {
  const promptCalls: string[] = [];
  const setSystemPromptCalls: string[] = [];
  const setBaseSystemPromptCalls: string[] = [];
  const setToolsCalls: unknown[] = [];
  const disposed: boolean[] = [];
  const promptsAsSeenByModel: PromptAsSeenByModel[] = [];

  // pi-coding-agent's _baseSystemPrompt is the field session.prompt() reads
  // during the reset (see node_modules/.../core/agent-session.js line 738-739).
  // The fake models this: setBaseSystemPrompt updates the value, and prompt()
  // snapshots whatever was last set there as what the LLM sees — regardless
  // of any setSystemPrompt() call in between.
  let lastBasePrompt = "";

  const agent: PiAgent = {
    setSystemPrompt(text) {
      setSystemPromptCalls.push(text);
    },
    setBaseSystemPrompt(text) {
      lastBasePrompt = text;
      setBaseSystemPromptCalls.push(text);
    },
    setTools(tools) {
      setToolsCalls.push(tools);
    },
    async waitForIdle() {
      if (opts.promptGate) await opts.promptGate.promise;
    },
  };

  const session: TrackingSession = Object.assign({
    agent,
    async prompt(text: string) {
      promptCalls.push(text);
      promptsAsSeenByModel.push({ userContent: text, systemPromptAsSeen: lastBasePrompt });
      if (opts.promptGate) await opts.promptGate.promise;
    },
    getLastAssistantText() {
      return "lastText" in opts ? opts.lastText : "fake reply";
    },
    getSessionStats(): PiSessionStats {
      const t = opts.tokens ?? { input: 10, output: 5, total: 15 };
      return {
        sessionFile: undefined,
        sessionId: "test-session",
        userMessages: 1,
        assistantMessages: 1,
        toolCalls: 0,
        toolResults: 0,
        totalMessages: 2,
        tokens: { ...t, cacheRead: 0, cacheWrite: 0 },
        cost: 0,
      };
    },
    dispose() {
      disposed.push(true);
    },
    subscribe() {
      return () => {};
    },
  }, {
    __promptCalls: promptCalls,
    __setSystemPromptCalls: setSystemPromptCalls,
    __setBaseSystemPromptCalls: setBaseSystemPromptCalls,
    __setToolsCalls: setToolsCalls,
    __disposed: disposed,
    __promptsAsSeenByModel: promptsAsSeenByModel,
  });

  return session;
}

function makeContext(overrides: Partial<InboundMessageContext> = {}): InboundMessageContext {
  return {
    channelId: "webchat",
    messageId: "m-1",
    chatId: "chat-1",
    chatType: "direct",
    senderId: "user-1",
    content: "hello",
    timestamp: 1700000000000,
    ...overrides,
  };
}

function makeModelResolver(model: Model<"openai-completions"> | undefined) {
  return {
    resolveModel: (provider: string, modelId: string) => {
      if (!model) return undefined;
      return { ...model, id: modelId, provider: provider as Model["provider"] };
    },
    getApiKeyForProvider: () => "sk-fake-key",
  };
}

function makeConfig(overrides: Partial<AgentRuntimeConfig> = {}): AgentRuntimeConfig {
  return {
    model: "fake-model",
    provider: "fake",
    systemPrompt: "You are a helpful assistant.",
    workingDirectory: "/tmp",
    sessionDir: "/tmp/vex-test-sessions",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("AgentRuntime", () => {
  describe("model resolution", () => {
    it("resolves the configured provider/model through the injected ModelResolver", async () => {
      const fakeSession = makeFakeSession();
      const createPiSession: CreatePiSessionFn = async () => fakeSession;
      const modelResolver = makeModelResolver(makeFakeModel("fake"));
      const runtime = new AgentRuntime(makeConfig(), {
        modelResolver,
        createPiSession,
      });

      const reply = await runtime.chat("SYSTEM", makeContext({ content: "hi" }));

      expect(reply.content).toBe("fake reply");
      expect(reply.provider).toBe("fake");
      expect(reply.model).toBe("fake-model");
    });

    it("throws when the ModelResolver returns no Model for (provider, model)", async () => {
      const createPiSession: CreatePiSessionFn = async () => makeFakeSession();
      const modelResolver = makeModelResolver(undefined);
      const runtime = new AgentRuntime(makeConfig(), {
        modelResolver,
        createPiSession,
      });

      await expect(runtime.chat("SYSTEM", makeContext())).rejects.toThrow(/Cannot resolve model/);
    });
  });

  describe("chat reply", () => {
    it("returns content, provider, model, and usage drawn from the session stats", async () => {
      const fakeSession = makeFakeSession({
        lastText: "specific reply text",
        tokens: { input: 42, output: 17, total: 59 },
      });
      const createPiSession: CreatePiSessionFn = async () => fakeSession;
      const runtime = new AgentRuntime(makeConfig({ provider: "deepseek", model: "deepseek-chat" }), {
        modelResolver: makeModelResolver(makeFakeModel("deepseek", "deepseek-chat")),
        createPiSession,
      });

      const reply = await runtime.chat("SYSTEM", makeContext());

      expect(reply).toEqual({
        content: "specific reply text",
        provider: "deepseek",
        model: "deepseek-chat",
        usage: { promptTokens: 42, completionTokens: 17, totalTokens: 59 },
      });
    });

    it("returns an empty string when the session reports no assistant text", async () => {
      const fakeSession = makeFakeSession({ lastText: undefined });
      const createPiSession: CreatePiSessionFn = async () => fakeSession;
      const runtime = new AgentRuntime(makeConfig(), {
        modelResolver: makeModelResolver(makeFakeModel("fake")),
        createPiSession,
      });

      const reply = await runtime.chat("SYSTEM", makeContext());

      expect(reply.content).toBe("");
    });
  });

  describe("session key derivation", () => {
    it("derives the session key from (channelId, senderId) for direct chats", async () => {
      const sessions: { sessionFile: string }[] = [];
      const createPiSession: CreatePiSessionFn = async (args) => {
        sessions.push({ sessionFile: args.sessionFile });
        return makeFakeSession();
      };
      const runtime = new AgentRuntime(makeConfig(), {
        modelResolver: makeModelResolver(makeFakeModel("fake")),
        createPiSession,
      });

      await runtime.chat("SYSTEM", makeContext({ channelId: "webchat", chatType: "direct", senderId: "u-42", chatId: "ignored" }));

      expect(sessions[0]?.sessionFile).toContain("webchat_u-42");
    });

    it("derives the session key from (channelId, chatId) for group chats", async () => {
      const sessions: { sessionFile: string }[] = [];
      const createPiSession: CreatePiSessionFn = async (args) => {
        sessions.push({ sessionFile: args.sessionFile });
        return makeFakeSession();
      };
      const runtime = new AgentRuntime(makeConfig(), {
        modelResolver: makeModelResolver(makeFakeModel("fake")),
        createPiSession,
      });

      await runtime.chat("SYSTEM", makeContext({ channelId: "webchat", chatType: "group", senderId: "u-1", chatId: "room-7" }));

      expect(sessions[0]?.sessionFile).toContain("webchat_room-7");
    });

    it("reuses an existing session for the same key, creates a new one for a different key", async () => {
      const sessions: TrackingSession[] = [];
      const createPiSession: CreatePiSessionFn = async () => {
        const s = makeFakeSession();
        sessions.push(s);
        return s;
      };
      const runtime = new AgentRuntime(makeConfig(), {
        modelResolver: makeModelResolver(makeFakeModel("fake")),
        createPiSession,
      });

      await runtime.chat("SYSTEM", makeContext({ senderId: "u-1" }));
      await runtime.chat("SYSTEM", makeContext({ senderId: "u-1" }));
      await runtime.chat("SYSTEM", makeContext({ senderId: "u-2" }));

      expect(sessions).toHaveLength(2);
    });
  });

  describe("api key wiring", () => {
    it("passes the apiKey, providerForKey, and modelProviderForKey to createPiSession", async () => {
      const calls: Array<{ apiKey?: string; providerForKey: string; modelProviderForKey: string }> = [];
      const createPiSession: CreatePiSessionFn = async (args) => {
        calls.push({ apiKey: args.apiKey, providerForKey: args.providerForKey, modelProviderForKey: args.modelProviderForKey });
        return makeFakeSession();
      };
      const runtime = new AgentRuntime(makeConfig({ provider: "deepseek" }), {
        modelResolver: {
          resolveModel: (provider, modelId) => makeFakeModel(provider, modelId),
          getApiKeyForProvider: (p) => p === "deepseek" ? "sk-deepseek" : undefined,
        },
        createPiSession,
      });

      await runtime.chat("SYSTEM", makeContext());

      expect(calls).toEqual([{ apiKey: "sk-deepseek", providerForKey: "deepseek", modelProviderForKey: "deepseek" }]);
    });

    it("passes undefined apiKey when the ModelResolver has no key for the provider", async () => {
      const calls: Array<{ apiKey?: string }> = [];
      const createPiSession: CreatePiSessionFn = async (args) => {
        calls.push({ apiKey: args.apiKey });
        return makeFakeSession();
      };
      const runtime = new AgentRuntime(makeConfig({ provider: "deepseek" }), {
        modelResolver: {
          resolveModel: (provider, modelId) => makeFakeModel(provider, modelId),
          getApiKeyForProvider: () => undefined,
        },
        createPiSession,
      });

      await runtime.chat("SYSTEM", makeContext());

      expect(calls[0]?.apiKey).toBeUndefined();
    });
  });

  describe("session lock", () => {
    it("serializes concurrent chat() calls on the same session key", async () => {
      const gate = Promise.withResolvers<void>();
      const order: string[] = [];
      const createPiSession: CreatePiSessionFn = async () => makeFakeSession({ promptGate: gate });
      const runtime = new AgentRuntime(makeConfig(), {
        modelResolver: makeModelResolver(makeFakeModel("fake")),
        createPiSession,
      });

      const first = runtime.chat("S1", makeContext({ messageId: "first" })).then(() => order.push("first"));
      const second = runtime.chat("S2", makeContext({ messageId: "second" })).then(() => order.push("second"));
      const third = runtime.chat("S3", makeContext({ messageId: "third" })).then(() => order.push("third"));

      // Yield once so the first prompt enters the lock and starts awaiting the gate.
      await new Promise((r) => setImmediate(r));
      // First call is now inside the lock and blocked. Second and third are queued.
      expect(order).toEqual([]);

      gate.resolve();
      await Promise.all([first, second, third]);

      // First-in, first-out: lock acquired in submission order, never interleaved.
      expect(order).toEqual(["first", "second", "third"]);
    });

    it("does NOT serialize chat() calls on different session keys", async () => {
      const gate = Promise.withResolvers<void>();
      const createPiSession: CreatePiSessionFn = async () => makeFakeSession({ promptGate: gate });
      const runtime = new AgentRuntime(makeConfig(), {
        modelResolver: makeModelResolver(makeFakeModel("fake")),
        createPiSession,
      });

      const first = runtime.chat("S", makeContext({ senderId: "u-1" }));
      const second = runtime.chat("S", makeContext({ senderId: "u-2" }));

      // Both calls are inside independent locks and blocked on the gate.
      // Releasing the gate must unblock both at once.
      gate.resolve();
      const [r1, r2] = await Promise.all([first, second]);

      expect(r1.content).toBe("fake reply");
      expect(r2.content).toBe("fake reply");
    });
  });

  describe("system prompt lifecycle", () => {
    it("syncs _baseSystemPrompt before each turn (regression for pi-coding-agent's prompt() reset)", async () => {
      // The fake models pi-coding-agent's behavior: prompt()'s
      // before_agent_start hook overwrites the agent's system prompt with
      // _baseSystemPrompt when custom tools are present. If AgentRuntime
      // only calls setSystemPrompt, the LLM sees the value at
      // construction time, not the per-turn assembled value. setBaseSystemPrompt
      // is the documented sync path (matches the archive's
      // `(session as any)._baseSystemPrompt = prompt` workaround).
      const fakeSession = makeFakeSession();
      const createPiSession: CreatePiSessionFn = async () => fakeSession;
      const runtime = new AgentRuntime(makeConfig(), {
        modelResolver: makeModelResolver(makeFakeModel("fake")),
        createPiSession,
      });

      await runtime.chat("TURN-1-PROMPT", makeContext({ content: "u1" }));
      await runtime.chat("TURN-2-PROMPT", makeContext({ content: "u2" }));
      await runtime.chat("TURN-3-PROMPT", makeContext({ content: "u3" }));

      // What the LLM actually saw on each prompt() call. The fake
      // models the reset behavior, so the right value is whatever
      // AgentRuntime set via setBaseSystemPrompt most recently.
      expect(fakeSession.__promptsAsSeenByModel.map((p) => p.systemPromptAsSeen))
        .toEqual(["TURN-1-PROMPT", "TURN-2-PROMPT", "TURN-3-PROMPT"]);
    });

    it("passes the user content from ctx.content into session.prompt", async () => {
      const fakeSession = makeFakeSession();
      const createPiSession: CreatePiSessionFn = async () => fakeSession;
      const runtime = new AgentRuntime(makeConfig(), {
        modelResolver: makeModelResolver(makeFakeModel("fake")),
        createPiSession,
      });

      await runtime.chat("SYSTEM", makeContext({ content: "first user turn" }));
      await runtime.chat("SYSTEM", makeContext({ content: "second user turn" }));

      expect(fakeSession.__promptCalls).toEqual(["first user turn", "second user turn"]);
    });
  });

  describe("lifecycle", () => {
    it("shutdown disposes every active session", async () => {
      const sessions: TrackingSession[] = [];
      const createPiSession: CreatePiSessionFn = async () => {
        const s = makeFakeSession();
        sessions.push(s);
        return s;
      };
      const runtime = new AgentRuntime(makeConfig(), {
        modelResolver: makeModelResolver(makeFakeModel("fake")),
        createPiSession,
      });

      await runtime.chat("S", makeContext({ senderId: "u-1" }));
      await runtime.chat("S", makeContext({ senderId: "u-2" }));

      expect(sessions).toHaveLength(2);
      expect(sessions.every((s) => s.__disposed.length === 0)).toBe(true);

      await runtime.shutdown();

      expect(sessions.every((s) => s.__disposed.length === 1)).toBe(true);
    });

    it("clearSession disposes only the targeted session, not the others", async () => {
      const sessions: TrackingSession[] = [];
      const createPiSession: CreatePiSessionFn = async () => {
        const s = makeFakeSession();
        sessions.push(s);
        return s;
      };
      const runtime = new AgentRuntime(makeConfig(), {
        modelResolver: makeModelResolver(makeFakeModel("fake")),
        createPiSession,
      });

      await runtime.chat("S", makeContext({ senderId: "u-1" }));
      await runtime.chat("S", makeContext({ senderId: "u-2" }));

      runtime.clearSession(makeContext({ senderId: "u-1" }));

      expect(sessions[0]?.__disposed).toEqual([true]);
      expect(sessions[1]?.__disposed).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// wrapErrorAwareTool — converts isError:true tool results into thrown Errors
// (ported from _archive/src/agents/runtime.ts: wrapErrorAwareTool)
// ---------------------------------------------------------------------------

describe("wrapErrorAwareTool", () => {
  let wrapErrorAwareTool: (t: any) => any;
  let wrapErrorAwareTools: (tools: any[]) => any[];

  beforeAll(async () => {
    const mod = await import("../src/agent/AgentRuntime.js");
    wrapErrorAwareTool = mod.wrapErrorAwareTool;
    wrapErrorAwareTools = mod.wrapErrorAwareTools;
  });

  it("throws when tool result has isError: true", async () => {
    const failing = {
      name: "failing",
      label: "Failing",
      description: "A failing tool",
      parameters: {},
      execute: async () => ({
        content: [{ type: "text" as const, text: "something broke" }],
        details: { status: "error", error: "fail" },
        isError: true,
      }),
    };

    const wrapped = wrapErrorAwareTool(failing);
    await expect(wrapped.execute("id", {}, undefined, undefined, {}))
      .rejects.toThrow("something broke");
  });

  it("passes through successful results unchanged", async () => {
    const ok = {
      name: "ok",
      label: "OK",
      description: "A working tool",
      parameters: {},
      execute: async () => ({
        content: [{ type: "text" as const, text: "done" }],
        details: { status: "success" },
      }),
    };

    const wrapped = wrapErrorAwareTool(ok);
    const result = await wrapped.execute("id", {}, undefined, undefined, {});
    expect(result.content[0].text).toBe("done");
  });

  it("uses JSON-formatted error text when no plain text content", async () => {
    const badTool = {
      name: "bad",
      label: "Bad",
      description: "Bad",
      parameters: {},
      execute: async () => ({
        content: [],
        details: { error: "silent" },
        isError: true,
      }),
    };

    const wrapped = wrapErrorAwareTool(badTool);
    await expect(wrapped.execute("id", {}, undefined, undefined, {}))
      .rejects.toThrow("Tool execution failed");
  });

  it("wrapErrorAwareTools wraps an entire array", async () => {
    const badTool = {
      name: "bad",
      label: "Bad",
      description: "Bad",
      parameters: {},
      execute: async () => ({
        content: [{ type: "text" as const, text: "fail" }],
        details: {},
        isError: true,
      }),
    };

    const goodTool = {
      name: "good",
      label: "Good",
      description: "Good",
      parameters: {},
      execute: async () => ({
        content: [{ type: "text" as const, text: "ok" }],
        details: {},
      }),
    };

    const wrapped = wrapErrorAwareTools([badTool, goodTool]);
    expect(wrapped).toHaveLength(2);

    // bad tool throws
    await expect(wrapped[0]!.execute("id", {}, undefined, undefined, {}))
      .rejects.toThrow();

    // good tool passes through
    const r = await wrapped[1]!.execute("id", {}, undefined, undefined, {});
    expect(r.content[0].text).toBe("ok");
  });
});
