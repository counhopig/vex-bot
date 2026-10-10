/** Serializes wiki repository work: callers queue behind the previous one instead of interleaving. */
export class WikiLock {
  private tail: Promise<unknown> = Promise.resolve();
  private users = 0;

  /** Whether an operation holds the lock or waits for it. */
  get busy(): boolean { return this.users > 0; }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.users += 1;
    try { return await this.queued(fn, signal); }
    finally { this.users -= 1; }
  }

  private async queued<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<unknown>((resolve) => {
      release = () => resolve(undefined);
    });
    let onAbort: (() => void) | undefined;
    try {
      if (signal) {
        signal.throwIfAborted();
        await Promise.race([
          previous.catch(() => undefined),
          new Promise<never>((_, reject) => {
            onAbort = () => reject(signal.reason ?? new Error("Cancelled"));
            signal.addEventListener("abort", onAbort, { once: true });
          }),
        ]);
        signal.throwIfAborted();
      } else {
        await previous.catch(() => undefined);
      }
    } catch (error) {
      // Keep later callers behind the previous operation even though this waiter
      // can return promptly on cancellation.
      void previous.then(release, release);
      throw error;
    } finally {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
