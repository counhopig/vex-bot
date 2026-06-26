/**
 * Pipeline extension seams — foundation for built-in extensions (Persona, ShareLink, Skill Learner)
 *
 * Mirrors the existing hooks style: module-level Maps + register/emit functions.
 */

import type { InboundMessageContext } from "../types/index.js";
import { getChildLogger } from "../utils/logger.js";

const logger = getChildLogger("pipeline");

function contextDebugFields(ctx: InboundMessageContext): Record<string, unknown> {
  return {
    channelId: ctx.channelId,
    chatId: ctx.chatId,
    chatType: ctx.chatType,
    senderId: ctx.senderId,
    messageId: ctx.messageId,
    contentLength: ctx.content.length,
  };
}

// ============== Prompt Injectors ==============

/** Prompt injector: given message context, returns text to inject into system prompt */
export type PromptInjector = (ctx: InboundMessageContext) => Promise<string>;

const promptInjectors = new Map<string, PromptInjector>();

/** Register a prompt injector */
export function registerPromptInjector(name: string, injector: PromptInjector): () => void {
  promptInjectors.set(name, injector);
  logger.debug({ name }, "Prompt injector registered");
  return () => {
    promptInjectors.delete(name);
    logger.debug({ name }, "Prompt injector unregistered");
  };
}

/** Gather all prompt injector output for a given context */
export async function gatherPromptInjections(ctx: InboundMessageContext): Promise<string[]> {
  const results: string[] = [];
  logger.debug({ ...contextDebugFields(ctx), injectorCount: promptInjectors.size }, "Gathering prompt injections");
  for (const [name, injector] of promptInjectors) {
    const startedAt = Date.now();
    try {
      const injected = await injector(ctx);
      const durationMs = Date.now() - startedAt;
      if (injected && injected.trim()) {
        results.push(injected.trim());
        logger.debug({ ...contextDebugFields(ctx), name, length: injected.length, durationMs }, "Prompt injector produced content");
      } else {
        logger.debug({ ...contextDebugFields(ctx), name, durationMs }, "Prompt injector skipped");
      }
    } catch (error) {
      logger.error({ error, ...contextDebugFields(ctx), name, durationMs: Date.now() - startedAt }, "Prompt injector error");
    }
  }
  logger.debug({ ...contextDebugFields(ctx), injectionCount: results.length }, "Prompt injections gathered");
  return results;
}

// ============== Message Interceptors ==============

/** Message interceptor result: string means short-circuit reply, null means continue */
export type MessageInterceptorResult = string | null;

/** Message interceptor: inspect or short-circuit incoming messages */
export type MessageInterceptor = (ctx: InboundMessageContext) => Promise<MessageInterceptorResult>;

const messageInterceptors = new Map<string, MessageInterceptor>();

/** Register a message interceptor */
export function registerMessageInterceptor(name: string, interceptor: MessageInterceptor): () => void {
  messageInterceptors.set(name, interceptor);
  logger.debug({ name }, "Message interceptor registered");
  return () => {
    messageInterceptors.delete(name);
    logger.debug({ name }, "Message interceptor unregistered");
  };
}

/** Run all message interceptors; first non-null return short-circuits */
export async function runMessageInterceptors(ctx: InboundMessageContext): Promise<MessageInterceptorResult> {
  logger.debug({ ...contextDebugFields(ctx), interceptorCount: messageInterceptors.size }, "Running message interceptors");
  for (const [name, interceptor] of messageInterceptors) {
    const startedAt = Date.now();
    try {
      const result = await interceptor(ctx);
      const durationMs = Date.now() - startedAt;
      if (result !== null) {
        logger.debug({ ...contextDebugFields(ctx), name, resultLength: result.length, durationMs }, "Message intercepted");
        return result;
      }
      logger.debug({ ...contextDebugFields(ctx), name, durationMs }, "Message interceptor passed");
    } catch (error) {
      logger.error({ error, ...contextDebugFields(ctx), name, durationMs: Date.now() - startedAt }, "Message interceptor error");
    }
  }
  logger.debug({ ...contextDebugFields(ctx) }, "No message interceptor handled message");
  return null;
}

// ============== Response Observers ==============

/** Response observer: called after a reply is produced */
export type ResponseObserver = (ctx: InboundMessageContext, replyText: string) => Promise<void>;

const responseObservers = new Map<string, ResponseObserver>();

/** Register a response observer */
export function registerResponseObserver(name: string, observer: ResponseObserver): () => void {
  responseObservers.set(name, observer);
  logger.debug({ name }, "Response observer registered");
  return () => {
    responseObservers.delete(name);
    logger.debug({ name }, "Response observer unregistered");
  };
}

/** Run all response observers */
export async function runResponseObservers(ctx: InboundMessageContext, replyText: string): Promise<void> {
  logger.debug(
    { ...contextDebugFields(ctx), observerCount: responseObservers.size, replyLength: replyText.length },
    "Running response observers"
  );
  for (const [name, observer] of responseObservers) {
    const startedAt = Date.now();
    try {
      await observer(ctx, replyText);
      logger.debug({ ...contextDebugFields(ctx), name, durationMs: Date.now() - startedAt }, "Response observed");
    } catch (error) {
      logger.error({ error, ...contextDebugFields(ctx), name, durationMs: Date.now() - startedAt }, "Response observer error");
    }
  }
}

// ============== Cleanup ==============

/** Clear all pipeline registrations (useful for testing) */
export function clearPipeline(): void {
  promptInjectors.clear();
  messageInterceptors.clear();
  responseObservers.clear();
  logger.debug("Pipeline cleared");
}

/** Get counts for diagnostics */
export function getPipelineCounts(): { injectors: number; interceptors: number; observers: number } {
  return {
    injectors: promptInjectors.size,
    interceptors: messageInterceptors.size,
    observers: responseObservers.size,
  };
}
