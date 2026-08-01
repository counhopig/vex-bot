/**
 * WeixinCredentialStore — per-user WeChat login credentials in SQLite.
 *
 * Review note (rewrite-plan): `listUserWeixinLogins` was originally planned
 * to move into config/, but the review flagged that WeChat login credentials
 * (token/accountId/baseUrl) are *channel startup credentials*, not config
 * overrides — the architecture doc's Config Resolution definition has no
 * place for them. They live here instead.
 *
 * This module owns the web-auth SQLite schema (all four tables) via the
 * shared `openAuthDatabase` opener, so WebAuthStore and this store never
 * drift on DDL. Each class opens its own per-instance connection (no
 * module-level cached DB — principle #5).
 */

import * as fs from "fs";
import * as path from "path";
import { homedir } from "os";
import Database from "better-sqlite3";

/** Default SQLite file for web users/auth. */
export function getDefaultAuthDbPath(): string {
  return path.join(homedir(), ".vex", "web-auth.sqlite");
}

/**
 * Open (creating if needed) the web-auth SQLite database with the full
 * schema. The archive cached one connection per file at module level;
 * here each caller gets its own per-instance connection. better-sqlite3 is
 * synchronous, so cross-connection visibility of committed writes is
 * immediate within the same process.
 */
export function openAuthDatabase(dbPath: string): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS web_users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL DEFAULT 'user',
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS web_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES web_users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_web_sessions_user_id ON web_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_web_sessions_expires_at ON web_sessions(expires_at);
    CREATE TABLE IF NOT EXISTS web_user_weixin (
      user_id TEXT PRIMARY KEY REFERENCES web_users(id) ON DELETE CASCADE,
      token TEXT NOT NULL,
      account_id TEXT NOT NULL,
      base_url TEXT,
      ilink_user_id TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS web_user_settings (
      user_id TEXT PRIMARY KEY REFERENCES web_users(id) ON DELETE CASCADE,
      settings_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  const userColumns = db.prepare("PRAGMA table_info(web_users)").all() as Array<{ name: string }>;
  if (!userColumns.some((column) => column.name === "role")) {
    db.exec("ALTER TABLE web_users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
  }
  return db;
}

/** A stored per-user WeChat login (channel startup credential). */
export interface StoredUserWeixinLogin {
  userId: string;
  token: string;
  accountId: string;
  baseUrl?: string;
  ilinkUserId?: string;
}

/** Login payload written by the QR-confirm flow. */
export interface WeixinLoginInput {
  token: string;
  accountId: string;
  baseUrl?: string;
  userId?: string;
}

export interface WeixinCredentialStoreOptions {
  /** SQLite file path. Defaults to ~/.vex/web-auth.sqlite. */
  dbPath?: string;
}

export class WeixinCredentialStore {
  private readonly db: Database.Database;

  constructor(options: WeixinCredentialStoreOptions = {}) {
    const dbPath = options.dbPath ?? getDefaultAuthDbPath();
    this.db = openAuthDatabase(dbPath);
  }

  /** All stored WeChat logins (used by web/server.ts to restore per-user
   *  channels at startup). */
  list(): StoredUserWeixinLogin[] {
    const rows = this.db.prepare(`
      SELECT user_id, token, account_id, base_url, ilink_user_id
        FROM web_user_weixin
    `).all() as Array<{
      user_id: string;
      token: string;
      account_id: string;
      base_url?: string;
      ilink_user_id?: string;
    }>;
    return rows.map((row) => ({
      userId: row.user_id,
      token: row.token,
      accountId: row.account_id,
      baseUrl: row.base_url,
      ilinkUserId: row.ilink_user_id,
    }));
  }

  /** The Weixin state for one user (used when building PublicWebUser). */
  getByUserId(userId: string): StoredUserWeixinLogin | undefined {
    return this.list().find((item) => item.userId === userId);
  }

  /** Upsert a user's WeChat login credentials. */
  save(userId: string, login: WeixinLoginInput): void {
    this.db.prepare(`
      INSERT INTO web_user_weixin (user_id, token, account_id, base_url, ilink_user_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        token = excluded.token,
        account_id = excluded.account_id,
        base_url = excluded.base_url,
        ilink_user_id = excluded.ilink_user_id,
        updated_at = excluded.updated_at
    `).run(
      userId,
      login.token,
      login.accountId,
      login.baseUrl ?? null,
      login.userId ?? null,
      Date.now(),
    );
  }

  /** Remove a user's WeChat login. Returns true when a row was deleted. */
  delete(userId: string): boolean {
    const result = this.db.prepare("DELETE FROM web_user_weixin WHERE user_id = ?").run(userId);
    return result.changes > 0;
  }

  /** Number of stored credentials. */
  get count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM web_user_weixin").get() as { count: number };
    return row.count;
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // Already closed.
    }
  }
}
