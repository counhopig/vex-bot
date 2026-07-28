/**
 * createDefaultPiSession — real implementation of CreatePiSessionFn
 * for production use. Wires @mariozechner/pi-coding-agent's
 * createAgentSession with the authStorage setup that ModelResolver
 * provides, and adapts the result to the AgentRuntime's PiSession
 * shape.
 *
 * Tests assert the args we pass (mocked at the module boundary); the
 * real LLM call happens only in production.
 *
 * The factory sets the API key on authStorage for both `config.provider`
 * and `model.provider` when they differ. createAgentSession looks up
 * the key by `model.provider` internally; setting both is the
 * archive's documented fix for the case where the resolved Model's
 * provider id doesn't match the user's configured provider id (e.g.
 * a custom-anthropic config that resolves to a Model with
 * provider: "anthropic").
 */

import * as os from "os";
import { join } from "path";
import {
  createAgentSession,
  AuthStorage,
  ModelRegistry,
  SessionManager,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import type { Model, Api } from "@mariozechner/pi-ai";
import type { PiSession, PiAgent, PiSessionStats } from "./AgentRuntime.js";

const logger = {
  debug(msg: string, meta?: unknown) {
    if (process.env.VEX_DEBUG) {
      console.log(JSON.stringify({ level: "debug", module: "create-pi-session", msg, ...((meta as object) ?? {}) }));
    }
  },
};

export interface RealPiSessionDeps {
  model: Model<Api>;
  workingDirectory: string;
  sessionFile: string;
  apiKey?: string;
  providerForKey: string;
  modelProviderForKey: string;
}

/** Wrap a pi-coding-agent Agent into the AgentRuntime's PiAgent shape. */
function adaptAgent(agent: unknown): PiAgent {
  const a = agent as {
    setSystemPrompt: (v: string) => void;
    setTools: (t: unknown[]) => void;
    waitForIdle: () => Promise<void>;
  };
  return {
    setSystemPrompt: (v) => a.setSystemPrompt(v),
    setTools: (t) => a.setTools(t),
    waitForIdle: () => a.waitForIdle(),
  };
}

/** Wrap a pi-coding-agent AgentSession into the AgentRuntime's PiSession shape. */
function adaptSession(rawSession: unknown): PiSession {
  const s = rawSession as {
    agent: unknown;
    prompt: (text: string) => Promise<void>;
    getLastAssistantText: () => string | undefined;
    getSessionStats: () => unknown;
    dispose: () => void;
    subscribe: (listener: (event: unknown) => void) => () => void;
  };
  return {
    agent: adaptAgent(s.agent),
    prompt: (text) => s.prompt(text),
    getLastAssistantText: () => s.getLastAssistantText(),
    getSessionStats: () => s.getSessionStats() as PiSessionStats,
    dispose: () => s.dispose(),
    subscribe: (listener) => s.subscribe(listener),
  };
}

/** Build a default AgentRuntime session directory under the user's home. */
export function defaultSessionDir(): string {
  return join(os.homedir(), ".vex", "sessions");
}

/** Create a real AgentSession via the pi-coding-agent SDK and adapt it. */
export async function createDefaultPiSession(deps: RealPiSessionDeps): Promise<PiSession> {
  const {
    model,
    workingDirectory,
    sessionFile,
    apiKey,
    providerForKey,
    modelProviderForKey,
  } = deps;

  // Independent SessionManager per session — the archive's per-session
  // file scoping matters because two sessions for the same key would
  // otherwise share history. The caller picks sessionFile; we just
  // route it through.
  const sessionManager = SessionManager.create(workingDirectory, sessionFile);

  // AuthStorage: in-memory is fine because every key is set explicitly
  // from ModelResolver (no OAuth flows, no on-disk credentials).
  const authStorage = AuthStorage.inMemory();

  // Set the API key for the config provider (always).
  // Set it for the model.provider too when it differs — that's the
  // archive's documented fix for the case where the resolved Model
  // has a different provider id than the configured one (custom
  // proxies, anthropic-via-OpenAI, etc.).
  if (apiKey) {
    authStorage.set(providerForKey, { type: "api_key", key: apiKey });
    if (modelProviderForKey !== providerForKey) {
      authStorage.set(modelProviderForKey, { type: "api_key", key: apiKey });
    }
  }

  // Fallback resolver: a last-ditch attempt if pi-coding-agent asks
  // for a key we didn't explicitly set. Maps the model.provider to
  // the config.provider's key (same key, different id) so custom
  // proxies work transparently.
  authStorage.setFallbackResolver((provider: string) => {
    if (provider === modelProviderForKey && apiKey && providerForKey !== modelProviderForKey) {
      return apiKey;
    }
    return undefined;
  });

  const modelRegistry = new ModelRegistry(authStorage);

  // No custom tools yet — the ToolRegistry module will hand these in
  // once it lands. For now an empty list is fine; the Agent will
  // surface "no tools available" if the LLM tries to call one.
  const customToolDefinitions: ToolDefinition[] = [];

  const { session: rawSession } = await createAgentSession({
    cwd: workingDirectory,
    authStorage,
    modelRegistry,
    model,
    sessionManager,
    customTools: customToolDefinitions,
    tools: [],
  });

  logger.debug("Default pi session created", { sessionFile, modelProviderForKey });

  return adaptSession(rawSession);
}
