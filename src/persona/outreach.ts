import { formatNow } from "../context/prompt.js";
import type { Logger } from "../logger.js";
import { PROACTIVE_CHAT_SOURCE, type Persona } from "./index.js";

export interface OutreachDeps {
  persona: Persona;
  /** The WeChat channel when it is linked: whether it can send, and whether the last reply arrived. */
  wechat: () => { readonly available: boolean; replyDelivered(): Promise<boolean> } | undefined;
  /** The permanent WeChat conversation. */
  session: () => Promise<{ readonly busy: boolean; readonly successfulReply: string | undefined; runToIdle(text: string, source: string, signal: AbortSignal): Promise<void> }>;
  /** Owner WeChat messages received so far, to tell whether the owner answered during the chat. */
  inbound: () => number;
  log: Logger;
}

/**
 * The scheduler's outreach check: when the persona wants to talk and WeChat is idle, runs one quiet
 * proactive-chat turn and records it as sent only when its reply reached the owner.
 */
export function createOutreachCheck(deps: OutreachDeps): (signal: AbortSignal) => Promise<void> {
  const { persona } = deps;
  return async (signal) => {
    const wechat = deps.wechat();
    if (!wechat?.available) return;
    const session = await deps.session();
    if (!wechat.available || !persona.shouldOutreach(!session.busy)) { await persona.save(); return; }
    const inboundBefore = deps.inbound();
    deps.log.info("proactive chat started");
    await session.runToIdle(persona.outreachPrompt(formatNow(new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone)), PROACTIVE_CHAT_SOURCE, signal);
    if (session.successfulReply && await wechat.replyDelivered()) { persona.outreachSent(deps.inbound() !== inboundBefore); await persona.save(); }
  };
}
