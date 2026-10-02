export type SessionEvent =
  | { kind: "user_message"; text: string; timestamp: number }
  | { kind: "text_delta"; delta: string }
  | { kind: "assistant_message"; text: string; stopReason: string; timestamp: number }
  | { kind: "tool_start"; toolCallId: string; toolName: string; summary: string }
  | { kind: "tool_end"; toolCallId: string; toolName: string; isError: boolean }
  | { kind: "busy"; busy: boolean }
  | { kind: "error"; message: string };

export type HistoryItem =
  | { kind: "user"; text: string; timestamp: number }
  | { kind: "assistant"; text: string; stopReason: string; timestamp: number }
  | { kind: "tool"; toolCallId: string; toolName: string; summary: string; isError?: boolean };

export type VexEvent =
  | { type: "session"; sessionKey: string; event: SessionEvent }
  | { type: "sessions_changed" }
  | { type: "approvals_changed" };

export class EventBus {
  private readonly listeners = new Set<(event: VexEvent) => void>();

  constructor(private readonly onListenerError?: (err: unknown) => void) {}

  on(listener: (event: VexEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: VexEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (err) {
        this.onListenerError?.(err);
      }
    }
  }
}
