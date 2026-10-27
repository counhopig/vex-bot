import type { SessionEvent } from "../core/events.js";

/** How a turn ended for a channel that delivers one reply per turn. */
export type TurnStatus = "ok" | "interrupted" | "error";

/**
 * The reply that ends one turn, as WeChat and the device deliver it: the turn's final texts and
 * errors, without the narration the model writes alongside tool calls.
 */
export class TurnReply {
  readonly texts: string[] = [];
  status: TurnStatus = "ok";

  /** Takes what an assistant message or error of the running turn adds to its reply. */
  add(event: Extract<SessionEvent, { kind: "assistant_message" | "error" }>): void {
    if (event.kind === "error") {
      this.texts.push(event.message);
      // An interruption is the owner's own act and stays the turn's outcome.
      if (this.status === "ok") this.status = "error";
      return;
    }
    if (event.text && event.stopReason !== "toolUse") this.texts.push(event.text);
    if (event.stopReason === "aborted") this.status = "interrupted";
  }

  get text(): string {
    return this.texts.join("\n\n");
  }
}
