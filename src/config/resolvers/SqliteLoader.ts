/**
 * SqliteLoader — reads user-level config overrides from SQLite.
 *
 * Architecture doc (§9): Tier 3 of the config resolution chain
 * (user-level overrides from web_user_settings table).
 *
 * This is a pure reader — write/save of user settings belongs to the
 * Web UI layer (src/web/), not here.
 */

import Database from "better-sqlite3";
import { getChildLogger } from "../../utils/logger.js";
import type { UserConfigLoader } from "../UserConfigLoader.js";
import type { UserConfigSettings } from "../UserConfigLoader.js";

const logger = getChildLogger("sqlite-loader");

export type { UserConfigSettings } from "../UserConfigLoader.js";

export class SqliteLoader implements UserConfigLoader {
  private readonly dbPath: string;

  constructor(options: { dbPath: string }) {
    this.dbPath = options.dbPath;
  }

  /** Load user config settings from the web_user_settings table.
   *  Returns an empty object when the user has no saved settings or the
   *  database does not exist yet. */
  load(userId: string): UserConfigSettings {
    let db: Database.Database | null = null;
    try {
      db = new Database(this.dbPath, { readonly: true });
      const row = db
        .prepare("SELECT settings_json FROM web_user_settings WHERE user_id = ?")
        .get(userId) as { settings_json: string } | undefined;

      if (!row) return {};

      try {
        const parsed = JSON.parse(row.settings_json) as UserConfigSettings;
        if (parsed && typeof parsed === "object") return parsed;
      } catch (error) {
        // A corrupt row must not brick the user's runtime — YAML/defaults
        // stand in until the next save overwrites it. Logged so the failure
        // is observable, not silent.
        logger.warn({ error, userId }, "Corrupt user settings row; falling back to YAML");
      }
      return {};
    } catch {
      // DB not yet created, file not found, or table missing — not an error.
      return {};
    } finally {
      db?.close();
    }
  }

  /** Check whether the SQLite database has any users at all (proxy for
   *  "web auth enabled" when combined with the config flag). */
  hasAnyUsers(): boolean {
    try {
      const db = new Database(this.dbPath, { readonly: true });
      const count = db.prepare("SELECT COUNT(*) AS cnt FROM web_users").get() as
        | { cnt: number }
        | undefined;
      db.close();
      return (count?.cnt ?? 0) > 0;
    } catch {
      return false;
    }
  }
}
