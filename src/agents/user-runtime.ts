import { join } from "path";
import type { Agent } from "./agent.js";
import { createAgent } from "./agent.js";
import { createMemoryManager, type MemoryManager } from "../memory/index.js";
import { disposeExtensions } from "../extensions/index.js";
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

interface RuntimeEntry {
  // In-flight creation Promise, not the resolved runtime, so concurrent
  // getOrCreate() calls for the same user share one build instead of racing to
  // spin up duplicate Agents/MemoryManagers on the same directory.
  readonly runtime: Promise<UserRuntime>;
  lastAccess: number;
}

// Bound the runtime cache so a long-lived multi-user process does not hold an
// Agent + SQLite handle + MemoryManager open for every user who ever logged in.
const DEFAULT_MAX_RUNTIMES = 128;
const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1000;

export class UserRuntimeManager {
  private readonly config: VexConfig;
  private readonly globalAgent: Agent;
  private readonly globalMemoryManager?: MemoryManager;
  private readonly runtimes = new Map<string, RuntimeEntry>();
  // Teardown-in-progress per userId. A rebuild of the same user must wait for
  // this so the old runtime's dispose (memoryManager.close/saveIndex, session
  // teardown) never overlaps the new one on the identical scoped directory.
  private readonly pendingDisposes = new Map<string, Promise<void>>();
  private readonly maxRuntimes: number;
  private readonly idleTtlMs: number;
  private readonly sweepTimer?: ReturnType<typeof setInterval>;

  constructor(options: {
    readonly config: VexConfig;
    readonly globalAgent: Agent;
    readonly globalMemoryManager?: MemoryManager;
    // <= 0 disables the respective bound (mainly for tests).
    readonly maxRuntimes?: number;
    readonly idleTtlMs?: number;
  }) {
    this.config = options.config;
    this.globalAgent = options.globalAgent;
    this.globalMemoryManager = options.globalMemoryManager;
    this.maxRuntimes = options.maxRuntimes ?? DEFAULT_MAX_RUNTIMES;
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;

    // Reclaim idle runtimes on a timer, not only lazily on the next getOrCreate,
    // so a quiet instance still releases SQLite handles + memory past the TTL.
    // unref() so it never keeps the process alive on its own.
    if (this.idleTtlMs > 0) {
      this.sweepTimer = setInterval(() => this.evictIdle(), this.idleTtlMs);
      this.sweepTimer.unref?.();
    }
  }

  async getAgent(userId?: string): Promise<Agent> {
    if (!isWebAuthEnabled(this.config) || !userId) {
      return this.globalAgent;
    }
    return (await this.getOrCreate(userId)).agent;
  }

  getOrCreate(userId: string): Promise<UserRuntime> {
    this.evictIdle();
    const existing = this.runtimes.get(userId);
    if (existing) {
      existing.lastAccess = Date.now();
      return existing.runtime;
    }

    const runtime = this.buildRuntime(userId);
    const entry: RuntimeEntry = { runtime, lastAccess: Date.now() };
    this.runtimes.set(userId, entry);
    // If construction rejects, evict the cached rejection so a later call
    // retries a fresh build instead of permanently serving the failure.
    runtime.catch(() => {
      if (this.runtimes.get(userId) === entry) {
        this.runtimes.delete(userId);
      }
    });
    this.evictOverflow();
    return runtime;
  }

  /** Drop runtimes that have been idle past the TTL and tear them down. */
  private evictIdle(): void {
    if (this.idleTtlMs <= 0) return;
    const cutoff = Date.now() - this.idleTtlMs;
    for (const [userId, entry] of this.runtimes) {
      if (entry.lastAccess < cutoff) {
        this.runtimes.delete(userId);
        void this.trackDispose(entry.runtime, userId, "idle");
      }
    }
  }

  /** Evict least-recently-accessed runtimes until back under the cap. */
  private evictOverflow(): void {
    if (this.maxRuntimes <= 0) return;
    while (this.runtimes.size > this.maxRuntimes) {
      let oldestKey: string | undefined;
      let oldestAccess = Infinity;
      for (const [userId, entry] of this.runtimes) {
        if (entry.lastAccess < oldestAccess) {
          oldestAccess = entry.lastAccess;
          oldestKey = userId;
        }
      }
      if (oldestKey === undefined) break;
      const entry = this.runtimes.get(oldestKey)!;
      this.runtimes.delete(oldestKey);
      void this.trackDispose(entry.runtime, oldestKey, "overflow");
    }
  }

  private async buildRuntime(userId: string): Promise<UserRuntime> {
    // Wait for any in-flight teardown of this user's previous runtime before
    // touching the same on-disk directory.
    const pending = this.pendingDisposes.get(userId);
    if (pending) await pending.catch(() => {});
    const effectiveConfig = this.buildUserConfig(userId);
    const memoryManager = this.createUserMemoryManager(effectiveConfig, userId);
    const agent = await createAgent(effectiveConfig, { memoryManager, ownerId: userId });
    logger.info({ userId }, "User runtime created");
    return { userId, agent, memoryManager };
  }

  async shutdown(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    const entries = [...this.runtimes.entries()];
    this.runtimes.clear();
    for (const [userId, entry] of entries) {
      await this.trackDispose(entry.runtime, userId, "shutdown");
    }
  }

  async reset(userId: string): Promise<void> {
    const entry = this.runtimes.get(userId);
    if (!entry) return;
    this.runtimes.delete(userId);
    await this.trackDispose(entry.runtime, userId, "reset");
  }

  /**
   * Dispose a runtime while recording the teardown in pendingDisposes, so a
   * concurrent rebuild of the same user waits for it (see buildRuntime).
   */
  private trackDispose(
    runtimePromise: Promise<UserRuntime>,
    userId: string,
    reason: "shutdown" | "reset" | "idle" | "overflow",
  ): Promise<void> {
    const prior = this.pendingDisposes.get(userId);
    const task = (async () => {
      if (prior) await prior.catch(() => {});
      await this.disposeRuntime(runtimePromise, userId, reason);
    })();
    this.pendingDisposes.set(userId, task);
    void task.finally(() => {
      if (this.pendingDisposes.get(userId) === task) this.pendingDisposes.delete(userId);
    });
    return task;
  }

  private async disposeRuntime(
    runtimePromise: Promise<UserRuntime>,
    userId: string,
    reason: "shutdown" | "reset" | "idle" | "overflow",
  ): Promise<void> {
    let runtime: UserRuntime;
    try {
      runtime = await runtimePromise;
    } catch {
      // Build failed; nothing was constructed to tear down.
      return;
    }
    try {
      await runtime.agent.shutdown();
      await runtime.memoryManager?.close();
      await disposeExtensions(userId);
      logger.info({ userId, reason }, "User runtime disposed");
    } catch (error) {
      logger.warn({ userId, reason, error }, "Failed to dispose user runtime");
    }
  }

  private buildUserConfig(userId: string): VexConfig {
    const userConfig = buildUserEffectiveConfig(this.config, getUserConfigSettings(this.config, userId));
    // Any user-supplied sessions/memory `directory` is intentionally overwritten
    // with a per-user scoped path below: a user must not be able to redirect
    // their storage outside their sandbox (or onto another user's directory).
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
