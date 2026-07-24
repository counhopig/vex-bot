/**
 * Pipeline — per-Agent message interceptors, response observers, and
 * prompt injectors.
 *
 * Architecture doc (§8):
 *   "The Pipeline is NOT process-global. Each Agent has its own Pipeline
 *    instance. Pipeline hooks do NOT need ownerId routing — they belong
 *    to their Agent."
 *
 * Three hook types:
 *   - PromptInjector:  returns extra text appended to the system prompt
 *   - MessageInterceptor:  returns null (pass through) or string (short-circuit)
 *   - ResponseObserver:  fire-and-forget after the reply is ready
 *
 * Resilience (ported from archived pipeline/index.ts):
 *   - Interceptors may call an LLM (e.g. the persona interceptor); each is
 *     wrapped in a try/catch + 30s timeout so one hung interceptor can't
 *     wedge the whole message pipeline.
 *   - Prompt injectors similarly have per-injector try/catch.
 */

import type { InboundMessageContext } from "../channels/ChannelAdapter.js";
import { getChildLogger } from "../utils/logger.js";

const logger = getChildLogger("pipeline");

/** Interceptors may call an LLM; bound each so one hung interceptor can't
 *  wedge the whole message pipeline. */
const INTERCEPTOR_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PromptInjector = (ctx: InboundMessageContext) => Promise<string>;
export type MessageInterceptor = (ctx: InboundMessageContext) => Promise<string | null>;
export type ResponseObserver = (ctx: InboundMessageContext, replyText: string) => Promise<void>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export class Pipeline {
  private readonly injectors: PromptInjector[] = [];
  private readonly interceptors: MessageInterceptor[] = [];
  private readonly observers: ResponseObserver[] = [];

  registerPromptInjector(fn: PromptInjector): void {
    this.injectors.push(fn);
  }

  registerInterceptor(fn: MessageInterceptor): void {
    this.interceptors.push(fn);
  }

  registerObserver(fn: ResponseObserver): void {
    this.observers.push(fn);
  }

  // -----------------------------------------------------------------------
  // Prompt injectors
  // -----------------------------------------------------------------------

  /** Run registered prompt injectors. Each is individually try/caught so
   *  one throwing injector does not lose other injectors' results. */
  async gatherPromptInjections(ctx: InboundMessageContext): Promise<string[]> {
    if (this.injectors.length === 0) return [];

    const results: string[] = [];
    for (let i = 0; i < this.injectors.length; i++) {
      try {
        const injected = await this.injectors[i]!(ctx);
        if (injected && injected.trim()) {
          results.push(injected.trim());
        }
      } catch (error) {
        logger.error({ error, injectorIndex: i }, "Prompt injector error");
      }
    }
    return results;
  }

  // -----------------------------------------------------------------------
  // Message interceptors
  // -----------------------------------------------------------------------

  /** Run message interceptors in order. Returns the first non-null response,
   *  or null. Each interceptor is individually try/caught + timed out so a
   *  single hung or throwing interceptor can't wedge the pipeline. */
  async runInterceptors(ctx: InboundMessageContext): Promise<string | null> {
    for (let i = 0; i < this.interceptors.length; i++) {
      try {
        const result = await withTimeout(
          this.interceptors[i]!(ctx),
          INTERCEPTOR_TIMEOUT_MS,
          `interceptor[${i}]`,
        );
        if (result !== null) return result;
      } catch (error) {
        logger.error({ error, interceptorIndex: i }, "Message interceptor error");
        // Continue to the next interceptor; one failure does not skip the rest.
      }
    }
    return null;
  }

  // -----------------------------------------------------------------------
  // Response observers
  // -----------------------------------------------------------------------

  /** Run all response observers. Errors do not propagate. */
  async runObservers(ctx: InboundMessageContext, reply: string): Promise<void> {
    await Promise.allSettled(this.observers.map((fn) => fn(ctx, reply)));
  }
}
