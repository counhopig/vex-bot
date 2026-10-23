/**
 * The absolute transcript index of the first message a session still holds in memory. The session
 * advances it when it releases a prefix; compaction records stay in absolute JSONL indices.
 */
export class TranscriptCursor {
  private position = 0;

  get offset(): number { return this.position; }
  advance(count: number): void { this.position += count; }
  /** The absolute transcript index of an in-memory history position. */
  absolute(index: number): number { return this.position + index; }
  /** The in-memory history position of an absolute transcript index; negative when already released. */
  relative(index: number): number { return index - this.position; }
}
