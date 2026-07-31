/**
 * Sessions module — barrel.
 *
 * Re-exports the public types, the FileSessionStore class, the title
 * helpers, and the default store path constant. The legacy
 * `getSessionStore()` / `initSessionStore()` module-level singletons
 * are intentionally NOT re-exported — every consumer (per-Web-user
 * server bootstrap, CLI diagnostics, tests) instantiates its own
 * FileSessionStore with its own storePath.
 */

export * from "./types.js";
export { FileSessionStore, DEFAULT_SESSION_STORE_PATH } from "./store.js";
export {
  sanitizeTitle,
  generateSessionTitle,
  DEFAULT_MAX_TITLE_LEN,
  type LlmCompleteLike,
  type LlmCompleteResult,
  type GenerateTitleOptions,
} from "./title.js";
