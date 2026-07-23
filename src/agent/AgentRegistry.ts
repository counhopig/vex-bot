/**
 * AgentRegistry — generic cache for per-(userId, channelId) entries.
 *
 * Ported from the old UserRuntimeManager (archive). Key changes:
 *   - Composite key (userId, channelId) instead of plain userId.
 *   - No globalAgent / legacy fallback path — the Dispatcher always
 *     resolves an agent through the registry.
 *   - Generic over the entry type T (must have shutdown()).
 *   - Factory injected via constructor (not hardcoded to createAgent).
 *
 * Preserved behavioral guarantees from the original:
 *   1. Concurrent getOrCreate calls for the same key share one build Promise.
 *   2. Failed builds are evicted so a later call retries.
 *   3. Idle entries past TTL are swept on a background timer.
 *   4. LRU overflow eviction when over maxEntries.
 *   5. Dispose-before-rebuild: teardown of the old entry completes before
 *      a new build starts for the same key.
 *   6. reset() drops and disposes an entry; shutdown() drains everything.
 */

import { getChildLogger } from "../utils/logger.js";

const logger = getChildLogger("agent-registry");

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface Entry<T> {
  /** In-flight creation Promise so concurrent callers share one build. */
  readonly runtime: Promise<T>;
  lastAccess: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_ENTRIES = 128;
const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1_000;

// ---------------------------------------------------------------------------
// AgentRegistry
// ---------------------------------------------------------------------------

export class AgentRegistry<T extends { shutdown(): Promise<void> }> {
  private readonly entries = new Map<string, Entry<T>>();

  /**
   * Teardown-in-progress per key. A rebuild of the same key must wait for
   * this so the old entry's dispose never overlaps the new one's build on
   * shared resources (e.g. the same on-disk directory).
   */
  private readonly pendingDisposes = new Map<string, Promise<void>>();

  private readonly factory: (userId: string, channelId: string, config: unknown) => Promise<T>;
  private readonly maxEntries: number;
  private readonly idleTtlMs: number;
  private readonly sweepTimer?: ReturnType<typeof setInterval>;

  constructor(options: {
    factory: (userId: string, channelId: string, config: unknown) => Promise<T>;
    maxEntries?: number;
    idleTtlMs?: number;
  }) {
    this.factory = options.factory;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;

    // Periodic idle sweep — unref() so it never keeps the process alive.
    if (this.idleTtlMs > 0) {
      this.sweepTimer = setInterval(() => this.evictIdle(), this.idleTtlMs);
      this.sweepTimer.unref?.();
    }
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  getOrCreate(userId: string, channelId: string, config: unknown): Promise<T> {
    this.evictIdle();

    const k = this.key(userId, channelId);
    const existing = this.entries.get(k);
    if (existing) {
      existing.lastAccess = Date.now();
      return existing.runtime;
    }

    const runtime = this.build(userId, channelId, config, k);
    const entry: Entry<T> = { runtime, lastAccess: Date.now() };
    this.entries.set(k, entry);

    // On build failure, evict the cached rejection so a later call retries
    // a fresh build instead of permanently serving the failure.
    runtime.catch(() => {
      if (this.entries.get(k) === entry) {
        this.entries.delete(k);
        logger.warn({ userId, channelId }, "Agent build failed, entry evicted");
      }
    });

    this.evictOverflow();
    return runtime;
  }

  /** Number of currently cached entries. */
  get size(): number {
    return this.entries.size;
  }

  /** Drop and dispose the entry for a specific (userId, channelId). */
  async reset(userId: string, channelId: string): Promise<void> {
    const k = this.key(userId, channelId);
    const entry = this.entries.get(k);
    if (!entry) return;
    this.entries.delete(k);
    await this.trackDispose(entry.runtime, k, "reset");
  }

  /** Drop and dispose every cached entry, then stop the sweep timer. */
  async shutdown(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    const snapshot = [...this.entries.entries()];
    this.entries.clear();
    await Promise.all(
      snapshot.map(([k, entry]) => this.trackDispose(entry.runtime, k, "shutdown")),
    );
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private key(userId: string, channelId: string): string {
    return `${channelId}:${userId}`;
  }

  private async build(
    userId: string,
    channelId: string,
    config: unknown,
    key: string,
  ): Promise<T> {
    // Wait for any in-flight teardown of this key's previous entry before
    // building a new one that touches the same scoped resources.
    const pending = this.pendingDisposes.get(key);
    if (pending) await pending.catch(() => {});

    const entry = await this.factory(userId, channelId, config);
    logger.debug({ userId, channelId }, "AgentRegistry entry built");
    return entry;
  }

  /** Dispose an entry while recording the teardown so concurrent rebuilds wait. */
  private trackDispose(
    runtimePromise: Promise<T>,
    key: string,
    reason: "shutdown" | "reset" | "idle" | "overflow",
  ): Promise<void> {
    const prior = this.pendingDisposes.get(key);
    const task = (async () => {
      if (prior) await prior.catch(() => {});
      await this.disposeEntry(runtimePromise, key, reason);
    })();
    this.pendingDisposes.set(key, task);
    void task.finally(() => {
      if (this.pendingDisposes.get(key) === task) this.pendingDisposes.delete(key);
    });
    return task;
  }

  private async disposeEntry(
    runtimePromise: Promise<T>,
    key: string,
    reason: "shutdown" | "reset" | "idle" | "overflow",
  ): Promise<void> {
    let entry: T;
    try {
      entry = await runtimePromise;
    } catch {
      // Build failed — nothing was constructed to tear down.
      return;
    }
    try {
      await entry.shutdown();
      logger.debug({ key, reason }, "AgentRegistry entry disposed");
    } catch (error) {
      logger.warn({ key, reason, error }, "Failed to dispose AgentRegistry entry");
    }
  }

  /** Evict entries that have been idle past the TTL. */
  private evictIdle(): void {
    if (this.idleTtlMs <= 0) return;
    const cutoff = Date.now() - this.idleTtlMs;
    for (const [k, entry] of this.entries) {
      if (entry.lastAccess < cutoff) {
        this.entries.delete(k);
        void this.trackDispose(entry.runtime, k, "idle");
      }
    }
  }

  /** Evict LRU entries until back under maxEntries. */
  private evictOverflow(): void {
    if (this.maxEntries <= 0) return;
    while (this.entries.size > this.maxEntries) {
      let oldestKey: string | undefined;
      let oldestAccess = Infinity;
      for (const [k, entry] of this.entries) {
        if (entry.lastAccess < oldestAccess) {
          oldestAccess = entry.lastAccess;
          oldestKey = k;
        }
      }
      if (oldestKey === undefined) break;
      const entry = this.entries.get(oldestKey)!;
      this.entries.delete(oldestKey);
      void this.trackDispose(entry.runtime, oldestKey, "overflow");
    }
  }
}
