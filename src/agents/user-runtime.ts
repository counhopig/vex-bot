import { join } from "path";
import type { Agent } from "./agent.js";
import { createAgent } from "./agent.js";
import { createMemoryManager, type MemoryManager } from "../memory/index.js";
import type { VexConfig } from "../types/index.js";
import { getUserConfigSettings, isWebAuthEnabled } from "../web/auth.js";
import { buildUserEffectiveConfig } from "../web/config-handlers.js";
import { getChildLogger } from "../utils/logger.js";

const logger = getChildLogger("user-runtime");

export interface UserRuntime {
  readonly userId: string;
  readonly agent: Agent;
  readonly memoryManager?: MemoryManager;
}

export class UserRuntimeManager {
  private readonly config: VexConfig;
  private readonly globalAgent: Agent;
  private readonly globalMemoryManager?: MemoryManager;
  private readonly runtimes = new Map<string, UserRuntime>();

  constructor(options: {
    readonly config: VexConfig;
    readonly globalAgent: Agent;
    readonly globalMemoryManager?: MemoryManager;
  }) {
    this.config = options.config;
    this.globalAgent = options.globalAgent;
    this.globalMemoryManager = options.globalMemoryManager;
  }

  async getAgent(userId?: string): Promise<Agent> {
    if (!isWebAuthEnabled(this.config) || !userId) {
      return this.globalAgent;
    }
    return (await this.getOrCreate(userId)).agent;
  }

  async getOrCreate(userId: string): Promise<UserRuntime> {
    const existing = this.runtimes.get(userId);
    if (existing) return existing;

    const effectiveConfig = this.buildUserConfig(userId);
    const memoryManager = this.createUserMemoryManager(effectiveConfig, userId);
    const agent = await createAgent(effectiveConfig, { memoryManager });
    const runtime: UserRuntime = { userId, agent, memoryManager };
    this.runtimes.set(userId, runtime);
    logger.info({ userId }, "User runtime created");
    return runtime;
  }

  async shutdown(): Promise<void> {
    for (const runtime of this.runtimes.values()) {
      await runtime.agent.shutdown();
      await runtime.memoryManager?.close();
    }
    this.runtimes.clear();
  }

  async reset(userId: string): Promise<void> {
    const runtime = this.runtimes.get(userId);
    if (!runtime) return;
    await runtime.agent.shutdown();
    await runtime.memoryManager?.close();
    this.runtimes.delete(userId);
  }

  private buildUserConfig(userId: string): VexConfig {
    const userConfig = buildUserEffectiveConfig(this.config, getUserConfigSettings(this.config, userId));
    return {
      ...userConfig,
      sessions: userConfig.sessions
        ? {
            ...userConfig.sessions,
            directory: scopedDirectory(this.config.sessions?.directory, "sessions", userId),
          }
        : {
            type: "file",
            directory: scopedDirectory(undefined, "sessions", userId),
          },
      memory: userConfig.memory
        ? {
            ...userConfig.memory,
            directory: scopedDirectory(this.config.memory?.directory, "memory", userId),
          }
        : userConfig.memory,
    };
  }

  private createUserMemoryManager(config: VexConfig, userId: string): MemoryManager | undefined {
    if (!config.memory || config.memory.enabled === false) return undefined;
    logger.info({ userId, directory: config.memory.directory }, "User memory system initialized");
    return createMemoryManager({
      enabled: config.memory.enabled ?? true,
      directory: config.memory.directory,
    });
  }

  getLegacyMemoryManager(): MemoryManager | undefined {
    return this.globalMemoryManager;
  }
}

function scopedDirectory(directory: string | undefined, feature: "memory" | "sessions", userId: string): string {
  return join(directory ?? join("~", ".vex", feature), "users", sanitizeUserId(userId));
}

function sanitizeUserId(userId: string): string {
  return userId.replace(/[^a-zA-Z0-9_-]/g, "_");
}
