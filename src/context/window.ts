import type { AgentMessage } from "@earendil-works/pi-agent-core";

export const MAX_CONTEXT_MESSAGES = 512;
export const MAX_CONTEXT_BYTES = 8 * 1024 * 1024;

export function startsContextSegment(message: AgentMessage, previous?: AgentMessage): boolean {
  return message.role === "user" || (message.role !== "toolResult" && previous?.role === "assistant" && !previous.content.some((part) => part.type === "toolCall"));
}

/** A bounded suffix cut at user turns or completed replies, keeping tool calls and results together. */
export class MessageWindow {
  readonly messages: AgentMessage[] = [];
  offset = 0;
  private sizes: number[] = [];
  private bytes = 0;

  push(message: AgentMessage): void {
    this.messages.push(message);
    const size = Buffer.byteLength(JSON.stringify(message), "utf8");
    this.sizes.push(size);
    this.bytes += size;
    while (this.messages.length > MAX_CONTEXT_MESSAGES || this.bytes > MAX_CONTEXT_BYTES) {
      const nextTurn = this.messages.findIndex((item, index) => index > 0 && startsContextSegment(item, this.messages[index - 1]));
      // The newest turn is indivisible; the request budget handles an oversized current turn.
      if (nextTurn < 0) break;
      this.discardThrough(this.offset + nextTurn);
    }
  }

  discardThrough(through: number): void {
    const count = Math.min(this.messages.length, Math.max(0, through - this.offset));
    this.messages.splice(0, count);
    for (const size of this.sizes.splice(0, count)) this.bytes -= size;
    this.offset += count;
  }
}

