import type { Session } from "./session.js";

/** Delivery to the WeChat owner conversation, through the session's own named semantics. */
export interface OwnerDelivery {
  /**
   * Queue a runtime notice for the owner; it is drained after the current turn settles, so a
   * running conversation is never interrupted.
   */
  notify(text: string): Promise<void>;
  /**
   * Wait for the owner conversation to be idle, then inject the text into its transcript as a
   * notice the model must not echo; aborting `signal` cancels the wait.
   */
  inject(text: string, signal?: AbortSignal): Promise<void>;
}

/** The WeChat owner conversation, resolved lazily so the session can be reopened behind it. */
export function createOwnerDelivery(deps: { wechatSession: () => Promise<Session> }): OwnerDelivery {
  return {
    notify: async (text) => { await (await deps.wechatSession()).enqueueAssistant(text); },
    inject: async (text, signal) => { await (await deps.wechatSession()).injectAssistant(text, signal); },
  };
}
