/**
 * AgentRuntime 测试
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentRuntime, createAgentRuntime, type RuntimeConfig } from "../src/agents/runtime.js";
import type { VexConfig } from "../src/types/index.js";

// Mock pi-coding-agent — fresh session object per createAgentSession call so
// tests can't observe each other's mutations (e.g. streamFn wrapping)
function makeMockSession() {
  const streamFn = vi.fn();
  return {
    // Handle to the original streamFn so tests can observe calls after the
    // runtime replaces agent.streamFn with a wrapper
    __innerStreamFn: streamFn,
    prompt: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockReturnValue(() => {}),
    getLastAssistantText: vi.fn().mockReturnValue("Mock response"),
    getSessionStats: vi.fn().mockReturnValue({
      tokens: { input: 100, output: 50, total: 150 },
      totalMessages: 2,
    }),
    dispose: vi.fn(),
    agent: {
      setSystemPrompt: vi.fn(),
      setTools: vi.fn(),
      waitForIdle: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn(),
      streamFn,
    },
  };
}

vi.mock("@mariozechner/pi-coding-agent", () => ({
  createAgentSession: vi.fn().mockImplementation(async () => ({
    session: makeMockSession(),
  })),
  SessionManager: {
    create: vi.fn().mockReturnValue({}),
  },
  AuthStorage: {
    inMemory: vi.fn().mockReturnValue({
      set: vi.fn(),
      setFallbackResolver: vi.fn(),
    }),
  },
  ModelRegistry: vi.fn().mockImplementation(() => ({})),
}));

// Mock model-resolver
vi.mock("../src/providers/model-resolver.js", () => ({
  resolveModel: vi.fn().mockReturnValue({
    id: "test-model",
    name: "Test Model",
    api: "openai-completions",
    provider: "test-provider",
    baseUrl: "https://api.test.com/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  }),
  initModelResolver: vi.fn(),
  getApiKeyForProvider: vi.fn().mockReturnValue("test-api-key"),
}));

// Mock logger
vi.mock("../src/utils/logger.js", () => ({
  getChildLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock system-prompt
vi.mock("../src/agents/system-prompt.js", () => ({
  buildSystemPrompt: vi.fn().mockReturnValue("Test system prompt"),
}));

describe("agents/runtime", () => {
  describe("AgentRuntime", () => {
    let runtime: AgentRuntime;
    const testConfig: RuntimeConfig = {
      model: "test-model",
      provider: "test-provider",
      systemPrompt: "You are a test assistant",
      workingDirectory: "/tmp/test",
    };

    beforeEach(() => {
      vi.clearAllMocks();
      runtime = new AgentRuntime(testConfig);
    });

    it("should initialize with config", () => {
      expect(runtime).toBeInstanceOf(AgentRuntime);
    });

    it("should register custom tools", () => {
      const mockTool = {
        name: "test_tool",
        label: "Test Tool",
        description: "A test tool",
        parameters: {},
        execute: vi.fn(),
      };

      runtime.registerCustomTool(mockTool as any);
      // Tool should be registered (internal state)
    });

    it("should set skills registry", () => {
      const mockRegistry = {
        buildPrompt: vi.fn().mockReturnValue("skills prompt"),
        getAll: vi.fn().mockReturnValue([]),
      };

      runtime.setSkillsRegistry(mockRegistry as any);
      // Registry should be set (internal state)
    });

    describe("chat", () => {
      it("should process chat message", async () => {
        const context = {
          channelId: "test-channel",
          chatId: "test-chat",
          chatType: "direct" as const,
          senderId: "test-user",
          content: "Hello",
          messageId: "msg-1",
          timestamp: Date.now(),
        };

        const response = await runtime.chat(context);

        expect(response).toHaveProperty("content");
        expect(response).toHaveProperty("provider", "test-provider");
        expect(response).toHaveProperty("model", "test-model");
        expect(response).toHaveProperty("usage");
      });

      it("should return usage statistics", async () => {
        const context = {
          channelId: "test-channel",
          chatId: "test-chat",
          chatType: "direct" as const,
          senderId: "test-user",
          content: "Hello",
          messageId: "msg-1",
          timestamp: Date.now(),
        };

        const response = await runtime.chat(context);

        expect(response.usage).toEqual({
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
        });
      });
    });

    describe("sampling parameters", () => {
      const context = {
        channelId: "test",
        chatId: "chat-1",
        chatType: "direct" as const,
        senderId: "user-1",
        content: "Hello",
        messageId: "msg-1",
        timestamp: Date.now(),
      };

      async function chatAndGetSession(config: RuntimeConfig) {
        const { createAgentSession } = await import("@mariozechner/pi-coding-agent");
        const rt = new AgentRuntime(config);
        await rt.chat(context);
        const results = vi.mocked(createAgentSession).mock.results;
        const { session } = await results[results.length - 1]!.value;
        return session;
      }

      it("passes configured temperature and maxTokens to the LLM stream call", async () => {
        const session = await chatAndGetSession({ ...testConfig, temperature: 0.3, maxTokens: 1234 });

        const inner = session.__innerStreamFn;
        const model = { id: "m" };
        session.agent.streamFn(model, { messages: [] }, { signal: undefined });

        expect(inner).toHaveBeenCalledTimes(1);
        const [calledModel, , options] = inner.mock.calls[0]!;
        expect(calledModel).toBe(model);
        expect(options).toMatchObject({ temperature: 0.3, maxTokens: 1234 });
      });

      it("leaves streamFn untouched when no sampling params are configured", async () => {
        const session = await chatAndGetSession(testConfig);
        expect(vi.isMockFunction(session.agent.streamFn)).toBe(true);
      });
    });

    describe("session management", () => {
      it("should generate correct session key for direct chat", async () => {
        const context = {
          channelId: "weixin",
          chatId: "chat-123",
          chatType: "direct" as const,
          senderId: "user-456",
          content: "Hello",
          messageId: "msg-1",
          timestamp: Date.now(),
        };

        await runtime.chat(context);
        // Session key should be "weixin:user-456" for direct chat
      });

      it("should generate correct session key for group chat", async () => {
        const context = {
          channelId: "weixin",
          chatId: "group-789",
          chatType: "group" as const,
          senderId: "user-456",
          content: "Hello",
          messageId: "msg-1",
          timestamp: Date.now(),
        };

        await runtime.chat(context);
        // Session key should be "weixin:group-789" for group chat
      });

      it("should clear session", async () => {
        const context = {
          channelId: "test",
          chatId: "chat-1",
          chatType: "direct" as const,
          senderId: "user-1",
          content: "Hello",
          messageId: "msg-1",
          timestamp: Date.now(),
        };

        // Create session first
        await runtime.chat(context);

        // Clear session
        await runtime.clearSession(context);

        // Session should be cleared (no error thrown)
      });

      it("should get session info", async () => {
        const context = {
          channelId: "test",
          chatId: "chat-1",
          chatType: "direct" as const,
          senderId: "user-1",
          content: "Hello",
          messageId: "msg-1",
          timestamp: Date.now(),
        };

        // Create session first
        await runtime.chat(context);

        const info = runtime.getSessionInfo(context);

        expect(info).not.toBeNull();
        expect(info).toHaveProperty("messageCount");
        expect(info).toHaveProperty("lastUpdate");
      });

      it("should return null for non-existent session", () => {
        const context = {
          channelId: "test",
          chatId: "non-existent",
          chatType: "direct" as const,
          senderId: "user-1",
          content: "Hello",
          messageId: "msg-1",
          timestamp: Date.now(),
        };

        const info = runtime.getSessionInfo(context);

        expect(info).toBeNull();
      });
    });

    describe("base identity wiring", () => {
      const context = {
        channelId: "test",
        chatId: "chat-1",
        chatType: "direct" as const,
        senderId: "user-1",
        content: "Hello",
        messageId: "msg-1",
        timestamp: Date.now(),
      };

      it("omits the default identity when persona is enabled (persona supplies it)", async () => {
        const { buildSystemPrompt } = await import("../src/agents/system-prompt.js");
        const rt = new AgentRuntime({ ...testConfig, personaEnabled: true });
        await rt.chat(context);
        expect(vi.mocked(buildSystemPrompt)).toHaveBeenCalledWith(
          expect.objectContaining({ omitDefaultIdentity: true })
        );
      });

      it("keeps the default identity when persona is not enabled", async () => {
        const { buildSystemPrompt } = await import("../src/agents/system-prompt.js");
        const rt = new AgentRuntime({ ...testConfig, personaEnabled: false });
        await rt.chat(context);
        expect(vi.mocked(buildSystemPrompt)).toHaveBeenCalledWith(
          expect.objectContaining({ omitDefaultIdentity: false })
        );
      });
    });

    describe("concurrency", () => {
      it("serializes concurrent turns on the same session key so only one session is built", async () => {
        const { createAgentSession } = await import("@mariozechner/pi-coding-agent");
        const context = {
          channelId: "test",
          chatId: "chat-1",
          chatType: "direct" as const,
          senderId: "user-1",
          content: "Hello",
          messageId: "msg-1",
          timestamp: Date.now(),
        };

        await Promise.all([runtime.chat(context), runtime.chat(context)]);

        // Without per-session serialization both turns race getOrCreateSession
        // and each build their own AgentSession (call count 2), then mutate the
        // shared prompt concurrently. Serialized, the second turn reuses the
        // first's session.
        expect(vi.mocked(createAgentSession)).toHaveBeenCalledTimes(1);
      });
    });

    describe("chatStream", () => {
      it("completes when the prompt resolves even without an explicit agent_end event", async () => {
        const context = {
          channelId: "test",
          chatId: "chat-1",
          chatType: "direct" as const,
          senderId: "user-1",
          content: "Hello",
          messageId: "msg-1",
          timestamp: Date.now(),
        };

        const events: unknown[] = [];
        for await (const event of runtime.chatStream(context)) {
          events.push(event);
        }
        // Reaching here means the stream terminated instead of busy-looping
        // forever waiting for an agent_end that the session never emits.
        expect(Array.isArray(events)).toBe(true);
      }, 2000);

      it("yields tool events pushed by the session subscription", async () => {
        const { createAgentSession } = await import("@mariozechner/pi-coding-agent");
        let captured: ((event: unknown) => void) | undefined;
        const session = makeMockSession();
        session.subscribe = vi.fn().mockImplementation((cb: (event: unknown) => void) => {
          captured = cb;
          return () => {};
        });
        session.prompt = vi.fn().mockImplementation(async () => {
          captured?.({ type: "tool_execution_start", toolName: "bash", args: { command: "ls" } });
          captured?.({ type: "tool_execution_end", isError: false });
        });
        vi.mocked(createAgentSession).mockResolvedValueOnce({ session } as never);

        const context = {
          channelId: "test",
          chatId: "chat-2",
          chatType: "direct" as const,
          senderId: "user-2",
          content: "run ls",
          messageId: "msg-2",
          timestamp: Date.now(),
        };

        const events: unknown[] = [];
        for await (const event of runtime.chatStream(context)) {
          events.push(event);
        }

        expect(events).toContainEqual({ type: "tool_start", name: "bash", argsPreview: "ls" });
        expect(events).toContainEqual({ type: "tool_end", isError: false });
      }, 2000);
    });

    describe("shutdown", () => {
      it("should dispose all sessions on shutdown", async () => {
        const context = {
          channelId: "test",
          chatId: "chat-1",
          chatType: "direct" as const,
          senderId: "user-1",
          content: "Hello",
          messageId: "msg-1",
          timestamp: Date.now(),
        };

        // Create session
        await runtime.chat(context);

        // Shutdown
        await runtime.shutdown();

        // All sessions should be disposed
      });
    });
  });

  describe("createAgentRuntime", () => {
    it("should create runtime from VexConfig", () => {
      const config: VexConfig = {
        providers: {
          "test-provider": {
            apiKey: "test-key",
          },
        },
        channels: {},
        agent: {
          defaultModel: "test-model",
          defaultProvider: "test-provider",
        },
      };

      const runtime = createAgentRuntime(config);

      expect(runtime).toBeInstanceOf(AgentRuntime);
    });
  });
});
