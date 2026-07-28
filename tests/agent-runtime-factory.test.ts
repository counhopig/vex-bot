/**
 * createDefaultPiSession tests — the real implementation of
 * CreatePiSessionFn that wires @mariozechner/pi-coding-agent's
 * createAgentSession with the authStorage setup ModelResolver provides.
 *
 * The pi-coding-agent surface is mocked at the module boundary; the
 * tests assert the args the factory passes (authStorage has the right
 * keys, the right cwd/sessionFile, the right model). The actual LLM
 * call is integration territory and not covered here.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the pi-coding-agent module so the factory never hits the network.
type MockFn = ReturnType<typeof vi.fn>;
type AuthStorageMock = { set: MockFn; setFallbackResolver: MockFn };

const createAgentSessionMock = vi.fn();
const authStorageInstances: AuthStorageMock[] = [];
const modelRegistryInstances: unknown[] = [];
const sessionManagerInstances: unknown[] = [];

vi.mock("@mariozechner/pi-coding-agent", () => {
  return {
    createAgentSession: (options: unknown) => {
      createAgentSessionMock(options);
      return Promise.resolve({ session: { agent: {}, __options: options } });
    },
    AuthStorage: {
      inMemory: () => {
        const set = vi.fn();
        const setFallbackResolver = vi.fn();
        const instance: AuthStorageMock = { set, setFallbackResolver };
        authStorageInstances.push(instance);
        return instance;
      },
    },
    ModelRegistry: class {
      constructor(..._args: unknown[]) {
        modelRegistryInstances.push(this);
      }
    },
    SessionManager: {
      create: (..._args: unknown[]) => {
        const sm = { __created: true };
        sessionManagerInstances.push(sm);
        return sm;
      },
    },
  };
});

import { createDefaultPiSession, type RealPiSessionDeps } from "../src/agent/createDefaultPiSession.js";
import type { Model } from "@mariozechner/pi-ai";

function makeModel(provider: string, id = "test-model"): Model<"openai-completions"> {
  return {
    id,
    name: "Test Model",
    api: "openai-completions",
    provider: provider as Model["provider"],
    baseUrl: "https://example.com/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  };
}

function makeDeps(overrides: Partial<RealPiSessionDeps> = {}): RealPiSessionDeps {
  return {
    model: makeModel("deepseek"),
    workingDirectory: "/tmp/work",
    sessionFile: "/tmp/work/.vex/sessions/webchat_u-1.jsonl",
    apiKey: "sk-test",
    providerForKey: "deepseek",
    modelProviderForKey: "deepseek",
    ...overrides,
  };
}

beforeEach(() => {
  createAgentSessionMock.mockClear();
  authStorageInstances.length = 0;
  modelRegistryInstances.length = 0;
  sessionManagerInstances.length = 0;
});

describe("createDefaultPiSession", () => {
  it("sets the API key on authStorage for the config provider", async () => {
    await createDefaultPiSession(makeDeps());

    const auth = authStorageInstances[0];
    expect(auth).toBeDefined();
    expect(auth?.set).toHaveBeenCalledWith("deepseek", { type: "api_key", key: "sk-test" });
  });

  it("sets the API key for the model provider too when it differs from config provider", async () => {
    await createDefaultPiSession(makeDeps({
      providerForKey: "deepseek",
      modelProviderForKey: "minimax",
    }));

    const auth = authStorageInstances[0];
    expect(auth?.set).toHaveBeenCalledWith("deepseek", { type: "api_key", key: "sk-test" });
    expect(auth?.set).toHaveBeenCalledWith("minimax", { type: "api_key", key: "sk-test" });
  });

  it("does not set a second authStorage key when model.provider equals config.provider", async () => {
    await createDefaultPiSession(makeDeps({
      providerForKey: "deepseek",
      modelProviderForKey: "deepseek",
    }));

    const auth = authStorageInstances[0];
    expect(auth?.set).toHaveBeenCalledTimes(1);
  });

  it("registers a fallback resolver on authStorage that looks up keys by provider", async () => {
    await createDefaultPiSession(makeDeps());

    const auth = authStorageInstances[0];
    expect(auth?.setFallbackResolver).toHaveBeenCalledTimes(1);
    const resolver = auth?.setFallbackResolver.mock.calls[0]?.[0] as (p: string) => string | undefined;
    expect(typeof resolver).toBe("function");
  });

  it("falls back to the config provider's key when the requested provider matches model.provider", async () => {
    await createDefaultPiSession(makeDeps({
      providerForKey: "deepseek",
      modelProviderForKey: "minimax",
    }));

    const auth = authStorageInstances[0];
    const resolver = auth?.setFallbackResolver.mock.calls[0]?.[0] as (p: string) => string | undefined;
    expect(resolver("minimax")).toBe("sk-test");
    expect(resolver("openai")).toBeUndefined();
  });

  it("calls createAgentSession with the model, cwd, and authStorage", async () => {
    await createDefaultPiSession(makeDeps());

    expect(createAgentSessionMock).toHaveBeenCalledTimes(1);
    const opts = createAgentSessionMock.mock.calls[0]?.[0] as { model: unknown; cwd: string; authStorage: unknown };
    expect(opts.cwd).toBe("/tmp/work");
    expect(opts.model).toBeDefined();
    expect(opts.authStorage).toBe(authStorageInstances[0]);
  });
});
