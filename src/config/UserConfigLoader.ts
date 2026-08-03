/**
 * UserConfigLoader — Tier 3 of config resolution (user-level overrides).
 *
 * Architecture doc (§9): "Config resolution at runtime — System defaults
 * (YAML) merge with user overrides (SQLite) at dispatch time."
 *
 * ConfigStore.resolve() calls load(userId) automatically for every dispatch;
 * the concrete SqliteLoader reads web_user_settings. Keeping this an
 * interface lets tests inject fakes and keeps ConfigStore decoupled from
 * better-sqlite3 (design decision 2 of the runtime-config integration plan).
 */

/** Per-section user config overrides, structurally matching the rows
 *  WebAuthStore.saveUserConfigSettings writes. Type alias (not interface)
 *  so the shape stays assignable to Record<string, unknown> for merging. */
export type UserConfigSettings = {
  agent?: Record<string, unknown>;
  memory?: Record<string, unknown>;
  persona?: Record<string, unknown>;
  skillLearner?: Record<string, unknown>;
  sharelink?: Record<string, unknown>;
  weather?: Record<string, unknown>;
};

export interface UserConfigLoader {
  /** Load a user's config-override sections. Returns {} when the user has
   *  no saved settings or the backing store is unavailable. */
  load(userId: string): UserConfigSettings;
}
