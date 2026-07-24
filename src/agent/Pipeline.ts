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
 */

import type { InboundMessageContext } from "../channels/ChannelAdapter.js";

export type PromptInjector = (ctx: InboundMessageContext) => Promise<string>;
export type MessageInterceptor = (ctx: InboundMessageContext) => Promise<string | null>;
export type ResponseObserver = (ctx: InboundMessageContext, replyText: string) => Promise<void>;

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

  /** Run registered prompt injectors and return their concatenated output. */
  async gatherPromptInjections(ctx: InboundMessageContext): Promise<string[]> {
    if (this.injectors.length === 0) return [];
    const results = await Promise.all(this.injectors.map((fn) => fn(ctx)));
    return results.filter(Boolean);
  }

  /** Run message interceptors. Returns the first non-null response, or null. */
  async runInterceptors(ctx: InboundMessageContext): Promise<string | null> {
    for (const interceptor of this.interceptors) {
      const result = await interceptor(ctx);
      if (result !== null) return result;
    }
    return null;
  }

  /** Run all response observers. Errors do not propagate. */
  async runObservers(ctx: InboundMessageContext, reply: string): Promise<void> {
    await Promise.allSettled(this.observers.map((fn) => fn(ctx, reply)));
  }
}
