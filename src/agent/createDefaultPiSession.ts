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
 *
 * The PiAgent adapter exposes a `setBaseSystemPrompt` method that
 * pokes the SDK's private `_baseSystemPrompt` field. That field is
 * the value `session.prompt()`'s before_agent_start extension hook
 * uses to overwrite the agent's system prompt on every turn when
 * custom tools are present (see
 * node_modules/@mariozechner/pi-coding-agent/dist/core/agent-session.js
 * around the "in case previous turn had modifications" comment). The
 * SDK does not expose a setter for it; this is the same workaround
 * the archive's _archive/src/agents/runtime.ts used.
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
import { getChildLogger } from "../utils/logger.js";

const logger = getChildLogger("create-pi-session");

export interface RealPiSessionDeps {
  model: Model<Api>;
  workingDirectory: string;
  sessionFile: string;
  apiKey?: string;
  providerForKey: string;
  modelProviderForKey: string;
}

/** Pi-coding-agent's AgentSession shape we need to read for the
 *  _baseSystemPrompt sync. _baseSystemPrompt is a private field with
 *  no public setter; we declare the minimum surface we read here. */
interface RawAgentSession {
  agent: {
    setSystemPrompt(v: string): void;
    setTools(t: unknown[]): void;
    waitForIdle(): Promise<void>;
  };
  prompt: (text: string) => Promise<void>;
  getLastAssistantText: () => string | undefined;
  getSessionStats: () => unknown;
  dispose: () => void;
  subscribe: (listener: (event: unknown) => void) => () => void;
}

/** Wrap a pi-coding-agent Agent into the AgentRuntime's PiAgent shape. */
function adaptAgent(rawSession: RawAgentSession): PiAgent {
  return {
    setSystemPrompt: (v) => rawSession.agent.setSystemPrompt(v),
    setTools: (t) => rawSession.agent.setTools(t),
    waitForIdle: () => rawSession.agent.waitForIdle(),
    // _baseSystemPrompt has no public setter. The cast is the documented
    // boundary crossing — pi-coding-agent's class field is private; we
    // sync it via the runtime contract, not the public API.
    setBaseSystemPrompt: (v) => {
      (rawSession as unknown as { _baseSystemPrompt: string })._baseSystemPrompt = v;
    },
  };
}

/** Wrap a pi-coding-agent AgentSession into the AgentRuntime's PiSession shape. */
function adaptSession(rawSession: RawAgentSession): PiSession {
  return {
    agent: adaptAgent(rawSession),
    prompt: (text) => rawSession.prompt(text),
    getLastAssistantText: () => rawSession.getLastAssistantText(),
    getSessionStats: () => rawSession.getSessionStats() as PiSessionStats,
    dispose: () => rawSession.dispose(),
    subscribe: (listener) => rawSession.subscribe(listener),
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

  logger.debug({ sessionFile, modelProviderForKey }, "Default pi session created");

  return adaptSession(rawSession as unknown as RawAgentSession);
}
