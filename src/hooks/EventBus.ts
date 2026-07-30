/**
 * EventBus — class-based pub/sub for hook events.
 *
 * Architecture doc principle #5 forbids process-global state. The archive
 * used a module-level `Map<HookEventType, HookHandler[]>` (the comment
 * justified it as "process-wide lifecycle events") — preserved here as
 * a default instance `defaultBus` for app-wide use, but the underlying
 * container is a real class field so tests get isolation and future
 * per-Agent buses are possible.
 *
 * Handler errors are caught and logged so one bad subscriber cannot
 * prevent others from running — same defensive behavior as archive.
 */

import { getChildLogger } from "../utils/logger.js";
import type {
  HookEvent,
  HookEventType,
  HookHandler,
  HookMap,
} from "./types.js";

const logger = getChildLogger("hooks");

export class EventBus {
  private readonly handlers = new Map<HookEventType, Array<HookHandler>>();

  /** Subscribe one handler to one event type. Returns an unsubscribe fn. */
  subscribe<T extends HookEventType>(
    type: T,
    handler: HookHandler<Extract<HookEvent, { type: T }>>,
  ): () => void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler as HookHandler);
    this.handlers.set(type, list);
    logger.debug({ eventType: type }, "Hook subscribed");
    return () => this.unsubscribe(type, handler as HookHandler);
  }

  /** Subscribe multiple handlers at once. One unsubscribe fn removes all. */
  subscribeMany(map: HookMap): () => void {
    const unsubscribers: Array<() => void> = [];
    for (const [type, handler] of Object.entries(map) as Array<
      [HookEventType, HookHandler]
    >) {
      unsubscribers.push(this.subscribe(type, handler));
    }
    return () => {
      for (const u of unsubscribers) u();
    };
  }

  /** Remove one handler from one event type (no-op if not present). */
  unsubscribe(type: HookEventType, handler: HookHandler): void {
    const list = this.handlers.get(type);
    if (!list) return;
    const idx = list.indexOf(handler);
    if (idx >= 0) list.splice(idx, 1);
  }

  /** Emit one event. Awaits all handlers; errors are isolated. */
  async emit(event: HookEvent): Promise<void> {
    const handlers = this.handlers.get(event.type);
    if (!handlers || handlers.length === 0) return;

    for (const handler of [...handlers]) {
      try {
        await handler(event);
      } catch (error) {
        logger.error(
          { error, eventType: event.type },
          "Hook handler threw",
        );
      }
    }
  }

  /** Fire-and-forget variant — kicks off emit() and swallows errors. */
  emitSync(event: HookEvent): void {
    void this.emit(event).catch((error) => {
      logger.error({ error, eventType: event.type }, "Hook emitSync failed");
    });
  }

  /** Number of registered handlers (optionally for one type). */
  handlerCount(type?: HookEventType): number {
    if (type) return this.handlers.get(type)?.length ?? 0;
    let n = 0;
    for (const list of this.handlers.values()) n += list.length;
    return n;
  }

  /** Remove every handler. */
  clear(): void {
    this.handlers.clear();
  }
}

/** Default EventBus instance — app-wide cross-cutting hooks subscribe here. */
export const defaultBus = new EventBus();