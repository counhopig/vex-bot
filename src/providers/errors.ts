import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { zeroUsage } from "./usage.js";

/** Phrase in an owner-facing failure that marks an overloaded provider; retries wait longer for it. */
export const PROVIDER_OVERLOADED = "the model service is overloaded";

/**
 * A short, secret-free cause for a provider failure, from the raw error text that stays in the log.
 * Unrecognised failures have no cause.
 */
export function providerErrorCause(message: string | undefined): string | undefined {
  if (!message) return undefined;
  if (/\b529\b|overload/i.test(message)) return `${PROVIDER_OVERLOADED} (529)`;
  if (/\b429\b|rate.?limit|too many requests/i.test(message)) return "the model service is rate limiting requests (429)";
  if (/\b40[13]\b|unauthori[sz]ed|forbidden|invalid.{0,20}(?:api.?key|key|token)/i.test(message)) return "the model service rejected the API key";
  const status = /\b(5\d\d)\b/.exec(message)?.[1];
  if (status) return `the model service returned an error (${status})`;
  if (/timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up/i.test(message)) return "the model service could not be reached";
  return undefined;
}

/** What the owner is told when generation fails, with the cause when it is recognised. */
export function providerFailureMessage(raw: string | undefined): string {
  const cause = providerErrorCause(raw);
  return `Provider generation failed${cause ? `: ${cause}` : ""}.`;
}

/**
 * Replaces a failed generation's raw provider error with the owner-facing message, after handing
 * the raw text to `log`. `keep` names error messages that are already safe to show.
 */
export function withProviderFailures(stream: StreamFn, log: (raw: string) => void, keep: (errorMessage: string) => boolean = () => false): StreamFn {
  return async (model, context, options) => {
    const upstream = await stream(model, context, options);
    const output = createAssistantMessageEventStream();
    let logged = false;
    const clean = (message: AssistantMessage): AssistantMessage => {
      if (message.stopReason !== "error" || keep(message.errorMessage ?? "")) return message;
      if (!logged) { logged = true; log(message.errorMessage ?? "no error message"); }
      return { ...message, errorMessage: providerFailureMessage(message.errorMessage) };
    };
    void (async () => {
      try {
        for await (const event of upstream) output.push(event.type === "error" ? { ...event, error: clean(event.error) } : event);
        output.end(clean(await upstream.result()));
      } catch (error) {
        const failed = clean({ role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: zeroUsage(), stopReason: "error",
          errorMessage: error instanceof Error ? error.message : String(error), timestamp: Date.now() });
        output.push({ type: "error", reason: "error", error: failed });
        output.end(failed);
      }
    })();
    return output;
  };
}
