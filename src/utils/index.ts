/**
 * Utility functions — generateId / delay / retry.
 *
 * Only these three are ported per the rewrite plan; the archive's other
 * helpers (truncate, deepMerge, etc.) were dead code in the public barrel.
 * Each new module imports these from here instead of a grab-bag.
 */

import crypto from "crypto";

/** Generate a unique ID, optionally prefixed (e.g. `msg_<hex>`). */
export function generateId(prefix?: string): string {
  const id = crypto.randomBytes(8).toString("hex");
  return prefix ? `${prefix}_${id}` : id;
}

/** Delay execution for ms milliseconds. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry an async fn with optional exponential backoff. */
export async function retry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    delayMs?: number;
    backoff?: boolean;
    onRetry?: (error: Error, attempt: number) => void;
  } = {},
): Promise<T> {
  const { maxRetries = 3, delayMs = 1000, backoff = true, onRetry } = options;

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < maxRetries) {
        onRetry?.(lastError, attempt);
        const waitTime = backoff ? delayMs * Math.pow(2, attempt - 1) : delayMs;
        await delay(waitTime);
      }
    }
  }

  throw lastError;
}
