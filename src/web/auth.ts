/**
 * Local Web UI authentication and per-user Web account storage.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import { randomBytes, scryptSync, timingSafeEqual } from "crypto";
import type { IncomingMessage, ServerResponse } from "http";
import type { Request, Response, NextFunction } from "express";
import type { LoginResult } from "../channels/weixin/login.js";
import type { VexConfig } from "../types/index.js";
import type { ConfigSaveParams } from "./types.js";

const SESSION_COOKIE = "vexsid";
const PASSWORD_KEY_LENGTH = 64;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Error that carries the HTTP status it should be reported with, so route
 * handlers don't have to guess the status from the error message. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function errorStatus(error: unknown, fallback: number): number {
  return error instanceof HttpError ? error.status : fallback;
}

export interface WebUser {
  id: string;
  username: string;
  role: "admin" | "user";
  passwordHash: string;
  passwordSalt: string;
  createdAt: number;
  weixin?: {
    token: string;
    accountId: string;
    baseUrl?: string;
    userId?: string;
    updatedAt: number;
  };
}

export interface WebAuthSession {
  id: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
}

export interface PublicWebUser {
  id: string;
  username: string;
  role: "admin" | "user";
  createdAt: number;
  hasWeixin: boolean;
  weixinAccountId?: string;
}

export interface StoredUserWeixinLogin {
  userId: string;
  token: string;
  accountId: string;
  baseUrl?: string;
  ilinkUserId?: string;
}

export type UserConfigSettings = Pick<
  ConfigSaveParams,
  "agent" | "memory" | "persona" | "skillLearner" | "sharelink" | "weather" | "sessions"
>;

function getAuthStorePath(config: VexConfig): string {
  return config.webAuth?.database ?? join(homedir(), ".vex", "web-auth.sqlite");
}

// A better-sqlite3 connection is synchronous and meant to be long-lived. Cache
// one per database file so every request reuses it instead of opening a new
// connection and re-running the full schema DDL on every HTTP call.
let cachedAuthDb: { file: string; db: Database.Database } | null = null;

function openAuthDatabase(config: VexConfig): Database.Database {
  const file = getAuthStorePath(config);
  if (cachedAuthDb) {
    if (cachedAuthDb.file === file) return cachedAuthDb.db;
    // The target file changed (config reload / tests): drop the old connection.
    try {
      cachedAuthDb.db.close();
    } catch {
      // Already closed or underlying file removed — nothing to do.
    }
    cachedAuthDb = null;
  }
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
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
  cachedAuthDb = { file, db };
  return db;
}

// Expired sessions are already excluded by every lookup's `expires_at > now`
// filter, so pruning is pure housekeeping — throttle it instead of issuing a
// DELETE write on every single request.
let lastSessionPrune = 0;
const SESSION_PRUNE_INTERVAL_MS = 60_000;

function pruneExpiredSessions(db: Database.Database, now: number): void {
  if (now - lastSessionPrune < SESSION_PRUNE_INTERVAL_MS) return;
  lastSessionPrune = now;
  db.prepare("DELETE FROM web_sessions WHERE expires_at <= ?").run(now);
}

function hashPassword(password: string, salt = randomBytes(16).toString("hex")): { hash: string; salt: string } {
  return {
    hash: scryptSync(password, salt, PASSWORD_KEY_LENGTH).toString("hex"),
    salt,
  };
}

function verifyPassword(password: string, user: WebUser): boolean {
  const expected = Buffer.from(user.passwordHash, "hex");
  const actual = scryptSync(password, user.passwordSalt, PASSWORD_KEY_LENGTH);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

function parseCookieHeader(header: string | string[] | undefined): Record<string, string> {
  const cookieHeader = Array.isArray(header) ? header.join("; ") : header ?? "";
  const cookies: Record<string, string> = {};
  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (!rawName) continue;
    cookies[rawName] = decodeURIComponent(rawValue.join("="));
  }
  return cookies;
}

function serializeSessionCookie(sessionId: string, maxAgeSeconds: number, secure: boolean): string {
  const attributes = [
    `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  // Mark the session cookie Secure over HTTPS so it is never sent in cleartext.
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

/**
 * Decide whether the session cookie should carry the Secure attribute.
 * `webAuth.secureCookies` forces the answer when set; otherwise auto-detect
 * from the request so HTTPS deployments get Secure while plain-HTTP/localhost
 * development still works.
 */
function shouldUseSecureCookie(config: VexConfig, req: Request): boolean {
  const configured = config.webAuth?.secureCookies;
  if (typeof configured === "boolean") return configured;
  if (req.secure) return true;
  const forwardedProto = req.headers["x-forwarded-proto"];
  const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  return (proto ?? "").split(",")[0]?.trim() === "https";
}

function toPublicUser(user: WebUser): PublicWebUser {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    createdAt: user.createdAt,
    hasWeixin: Boolean(user.weixin?.token),
    weixinAccountId: user.weixin?.accountId,
  };
}

interface WebUserRow {
  id: string;
  username: string;
  role: "admin" | "user";
  password_hash: string;
  password_salt: string;
  created_at: number;
  token?: string;
  account_id?: string;
  base_url?: string;
  ilink_user_id?: string;
  updated_at?: number;
}

interface WebSessionRow {
  id: string;
  user_id: string;
  created_at: number;
  expires_at: number;
}

function rowToUser(row: WebUserRow): WebUser {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    passwordHash: row.password_hash,
    passwordSalt: row.password_salt,
    createdAt: row.created_at,
    weixin: row.token && row.account_id
      ? {
          token: row.token,
          accountId: row.account_id,
          baseUrl: row.base_url,
          userId: row.ilink_user_id,
          updatedAt: row.updated_at ?? 0,
        }
      : undefined,
  };
}

function rowToSession(row: WebSessionRow): WebAuthSession {
  return {
    id: row.id,
    userId: row.user_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function getUserByUsername(db: Database.Database, username: string): WebUser | null {
  const row = db.prepare(`
    SELECT u.id, u.username, u.role, u.password_hash, u.password_salt, u.created_at,
           w.token, w.account_id, w.base_url, w.ilink_user_id, w.updated_at
      FROM web_users u
      LEFT JOIN web_user_weixin w ON w.user_id = u.id
     WHERE u.username = ?
  `).get(username) as WebUserRow | undefined;
  return row ? rowToUser(row) : null;
}

function getUserById(db: Database.Database, userId: string): WebUser | null {
  const row = db.prepare(`
    SELECT u.id, u.username, u.role, u.password_hash, u.password_salt, u.created_at,
           w.token, w.account_id, w.base_url, w.ilink_user_id, w.updated_at
      FROM web_users u
      LEFT JOIN web_user_weixin w ON w.user_id = u.id
     WHERE u.id = ?
  `).get(userId) as WebUserRow | undefined;
  return row ? rowToUser(row) : null;
}

function countWebUsers(db: Database.Database): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM web_users").get() as { count: number };
  return row.count;
}

function requireAdmin(db: Database.Database, actorId: string): WebUser {
  const actor = getUserById(db, actorId);
  if (!actor || actor.role !== "admin") {
    throw new HttpError(403, "Admin privileges required");
  }
  return actor;
}

export function isWebAuthEnabled(config: VexConfig): boolean {
  return config.webAuth?.enabled !== false;
}

export function getSessionCookieName(): string {
  return SESSION_COOKIE;
}

export function getRequestUser(config: VexConfig, req: IncomingMessage): PublicWebUser | null {
  if (!isWebAuthEnabled(config)) return null;
  const sessionId = parseCookieHeader(req.headers.cookie)[SESSION_COOKIE];
  if (!sessionId) return null;

  const now = Date.now();
  const db = openAuthDatabase(config);
  pruneExpiredSessions(db, now);
  const sessionRow = db.prepare("SELECT id, user_id, created_at, expires_at FROM web_sessions WHERE id = ? AND expires_at > ?")
    .get(sessionId, now) as WebSessionRow | undefined;
  if (!sessionRow) return null;
  const user = getUserById(db, sessionRow.user_id);
  return user ? toPublicUser(user) : null;
}

export function createWebUser(config: VexConfig, username: string, password: string): PublicWebUser {
  const normalizedUsername = username.trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(normalizedUsername)) {
    throw new HttpError(400, "Username must be 3-32 characters and use letters, numbers, dot, underscore, or dash");
  }
  if (password.length < 8) {
    throw new HttpError(400, "Password must be at least 8 characters");
  }
  // Upper bound keeps the synchronous scrypt on unauthenticated routes from
  // chewing on arbitrarily large inputs.
  if (password.length > 128) {
    throw new HttpError(400, "Password must be at most 128 characters");
  }

  const db = openAuthDatabase(config);
  const passwordData = hashPassword(password);
  const user: WebUser = {
    id: `user_${randomBytes(12).toString("hex")}`,
    username: normalizedUsername,
    role: "user",
    passwordHash: passwordData.hash,
    passwordSalt: passwordData.salt,
    createdAt: Date.now(),
  };
  try {
    const inserted = db.transaction(() => {
      const userCount = db.prepare("SELECT COUNT(*) AS count FROM web_users").get() as { count: number };
      const role: WebUser["role"] = userCount.count === 0 ? "admin" : "user";
      db.prepare(`
        INSERT INTO web_users (id, username, role, password_hash, password_salt, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(user.id, user.username, role, user.passwordHash, user.passwordSalt, user.createdAt);
      return { ...user, role };
    })();
    return toPublicUser(inserted);
  } catch (error) {
    // better-sqlite3 reports constraint violations with a structured code;
    // web_users has a single UNIQUE constraint (username).
    if ((error as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
      throw new HttpError(409, "Username already exists");
    }
    throw error;
  }
}

export function listWebUsers(config: VexConfig, actorId: string): PublicWebUser[] {
  const db = openAuthDatabase(config);
  requireAdmin(db, actorId);
  const rows = db.prepare(`
    SELECT u.id, u.username, u.role, u.password_hash, u.password_salt, u.created_at,
           w.token, w.account_id, w.base_url, w.ilink_user_id, w.updated_at
      FROM web_users u
      LEFT JOIN web_user_weixin w ON w.user_id = u.id
     ORDER BY u.created_at ASC
  `).all() as WebUserRow[];
  return rows.map((row) => toPublicUser(rowToUser(row)));
}

export function updateWebUserRole(
  config: VexConfig,
  actorId: string,
  targetUserId: string,
  role: WebUser["role"],
): PublicWebUser {
  if (role !== "admin" && role !== "user") {
    throw new HttpError(400, "Invalid role");
  }
  if (actorId === targetUserId) {
    throw new HttpError(403, "Admins cannot change their own role");
  }

  const db = openAuthDatabase(config);
  requireAdmin(db, actorId);
  const target = getUserById(db, targetUserId);
  if (!target) throw new HttpError(404, "User not found");
  db.prepare("UPDATE web_users SET role = ? WHERE id = ?").run(role, targetUserId);
  const updated = getUserById(db, targetUserId);
  if (!updated) throw new HttpError(404, "User not found");
  return toPublicUser(updated);
}

export function deleteWebUser(config: VexConfig, actorId: string, targetUserId: string): void {
  if (actorId === targetUserId) {
    throw new HttpError(403, "Admins cannot delete their own account");
  }

  const db = openAuthDatabase(config);
  requireAdmin(db, actorId);
  const target = getUserById(db, targetUserId);
  if (!target) throw new HttpError(404, "User not found");
  db.prepare("DELETE FROM web_users WHERE id = ?").run(targetUserId);
}

export function loginWebUser(config: VexConfig, username: string, password: string): { user: PublicWebUser; session: WebAuthSession } {
  const normalizedUsername = username.trim().toLowerCase();
  const db = openAuthDatabase(config);
  const user = getUserByUsername(db, normalizedUsername);
  if (!user || !verifyPassword(password, user)) {
    throw new Error("Invalid username or password");
  }

  const now = Date.now();
  pruneExpiredSessions(db, now);
  const session: WebAuthSession = {
    id: `sess_${randomBytes(24).toString("hex")}`,
    userId: user.id,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  };
  db.prepare(`
    INSERT INTO web_sessions (id, user_id, created_at, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(session.id, session.userId, session.createdAt, session.expiresAt);
  return { user: toPublicUser(user), session };
}

export function logoutWebUser(config: VexConfig, req: IncomingMessage): void {
  const sessionId = parseCookieHeader(req.headers.cookie)[SESSION_COOKIE];
  if (!sessionId) return;
  const db = openAuthDatabase(config);
  db.prepare("DELETE FROM web_sessions WHERE id = ?").run(sessionId);
}

export function setLoginCookie(res: ServerResponse, session: WebAuthSession, secure = false): void {
  const maxAgeSeconds = Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000));
  res.setHeader("Set-Cookie", serializeSessionCookie(session.id, maxAgeSeconds, secure));
}

export function clearLoginCookie(res: ServerResponse, secure = false): void {
  res.setHeader("Set-Cookie", serializeSessionCookie("", 0, secure));
}

export function saveUserWeixinLogin(config: VexConfig, userId: string, login: LoginResult): PublicWebUser {
  const db = openAuthDatabase(config);
  const user = getUserById(db, userId);
  if (!user) throw new Error("User not found");
  db.prepare(`
    INSERT INTO web_user_weixin (user_id, token, account_id, base_url, ilink_user_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      token = excluded.token,
      account_id = excluded.account_id,
      base_url = excluded.base_url,
      ilink_user_id = excluded.ilink_user_id,
      updated_at = excluded.updated_at
  `).run(userId, login.token, login.accountId, login.baseUrl, login.userId, Date.now());
  const updatedUser = getUserById(db, userId);
  if (!updatedUser) throw new Error("User not found");
  return toPublicUser(updatedUser);
}

export function listUserWeixinLogins(config: VexConfig): StoredUserWeixinLogin[] {
  if (!isWebAuthEnabled(config)) return [];
  const db = openAuthDatabase(config);
  const rows = db.prepare(`
    SELECT user_id, token, account_id, base_url, ilink_user_id
      FROM web_user_weixin
     WHERE token <> ''
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

export function getUserConfigSettings(config: VexConfig, userId: string): UserConfigSettings {
  if (!isWebAuthEnabled(config)) return {};
  const db = openAuthDatabase(config);
  try {
    const row = db.prepare("SELECT settings_json FROM web_user_settings WHERE user_id = ?")
      .get(userId) as { settings_json: string } | undefined;
    if (!row) return {};
    const parsed = JSON.parse(row.settings_json) as UserConfigSettings;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    throw new Error(`Failed to load user settings: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function saveUserConfigSettings(config: VexConfig, userId: string, patch: UserConfigSettings): UserConfigSettings {
  if (!isWebAuthEnabled(config)) return {};
  const db = openAuthDatabase(config);
  try {
    const user = getUserById(db, userId);
    if (!user) throw new Error("User not found");
    const row = db.prepare("SELECT settings_json FROM web_user_settings WHERE user_id = ?")
      .get(userId) as { settings_json: string } | undefined;
    const existing = row ? JSON.parse(row.settings_json) as UserConfigSettings : {};
    const next = mergeUserConfigSettings(existing, patch);
    db.prepare(`
      INSERT INTO web_user_settings (user_id, settings_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        settings_json = excluded.settings_json,
        updated_at = excluded.updated_at
    `).run(userId, JSON.stringify(next), Date.now());
    return next;
  } catch (error) {
    throw new Error(`Failed to save user settings: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function mergeUserConfigSettings(existing: UserConfigSettings, patch: UserConfigSettings): UserConfigSettings {
  return {
    ...existing,
    ...(patch.agent ? { agent: { ...existing.agent, ...patch.agent } } : {}),
    ...(patch.memory ? { memory: { ...existing.memory, ...patch.memory } } : {}),
    ...(patch.persona ? { persona: { ...existing.persona, ...patch.persona } } : {}),
    ...(patch.skillLearner ? { skillLearner: { ...existing.skillLearner, ...patch.skillLearner } } : {}),
    ...(patch.sharelink ? { sharelink: mergeSharelinkSettings(existing.sharelink, patch.sharelink) } : {}),
    ...(patch.weather ? { weather: mergeWeatherSettings(existing.weather, patch.weather) } : {}),
    ...(patch.sessions ? { sessions: { ...existing.sessions, ...patch.sessions } } : {}),
  };
}

function mergeSharelinkSettings(
  existing: UserConfigSettings["sharelink"],
  patch: UserConfigSettings["sharelink"],
): UserConfigSettings["sharelink"] {
  if (!patch) return existing;
  const next = { ...existing, ...patch };
  if (!patch.bilibiliCookie) return next;
  next.bilibiliCookie = {
    ...existing?.bilibiliCookie,
    ...patch.bilibiliCookie,
  };
  return next;
}

function mergeWeatherSettings(
  existing: UserConfigSettings["weather"],
  patch: UserConfigSettings["weather"],
): UserConfigSettings["weather"] {
  if (!patch) return existing;
  return { ...existing, ...patch };
}

function getCredentials(body: unknown): { username: string; password: string } {
  if (body === null || typeof body !== "object") {
    throw new HttpError(400, "Request body must be an object");
  }
  const record = body as Record<string, unknown>;
  const username = typeof record.username === "string" ? record.username : "";
  const password = typeof record.password === "string" ? record.password : "";
  if (!username || !password) {
    throw new HttpError(400, "Username and password are required");
  }
  return { username, password };
}

export function installWebAuthRoutes(config: VexConfig) {
  function requireAdminRequest(req: Request): PublicWebUser {
    const user = getRequestUser(config, req);
    if (!user || user.role !== "admin") {
      throw new HttpError(403, "Admin privileges required");
    }
    return user;
  }

  return {
    register(req: Request, res: Response): void {
      try {
        // Self-service registration is only for bootstrapping the first account
        // (which becomes admin) or when the operator has explicitly opted into
        // open registration. Otherwise an admin must create the account, so a
        // publicly reachable instance can't be claimed by the first stranger.
        const db = openAuthDatabase(config);
        const isBootstrap = countWebUsers(db) === 0;
        const openRegistration = config.webAuth?.allowRegistration === true;
        if (!isBootstrap && !openRegistration) {
          res.status(403).json({ error: "Registration is disabled. Ask an administrator to create your account." });
          return;
        }
        const credentials = getCredentials(req.body);
        createWebUser(config, credentials.username, credentials.password);
        const login = loginWebUser(config, credentials.username, credentials.password);
        setLoginCookie(res, login.session, shouldUseSecureCookie(config, req));
        res.json({ user: login.user });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(errorStatus(error, 500)).json({ error: message });
      }
    },
    createUser(req: Request, res: Response): void {
      try {
        requireAdminRequest(req);
        const credentials = getCredentials(req.body);
        // Create the account without logging the admin out of their own session.
        const user = createWebUser(config, credentials.username, credentials.password);
        res.json({ user });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(errorStatus(error, 500)).json({ error: message });
      }
    },
    login(req: Request, res: Response): void {
      try {
        const credentials = getCredentials(req.body);
        const login = loginWebUser(config, credentials.username, credentials.password);
        setLoginCookie(res, login.session, shouldUseSecureCookie(config, req));
        res.json({ user: login.user });
      } catch {
        res.status(401).json({ error: "Invalid username or password" });
      }
    },
    logout(req: Request, res: Response): void {
      logoutWebUser(config, req);
      clearLoginCookie(res, shouldUseSecureCookie(config, req));
      res.json({ ok: true });
    },
    me(req: Request, res: Response): void {
      const user = getRequestUser(config, req);
      res.json({ user });
    },
    listUsers(req: Request, res: Response): void {
      try {
        const actor = requireAdminRequest(req);
        res.json({ users: listWebUsers(config, actor.id) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(errorStatus(error, 500)).json({ error: message });
      }
    },
    updateUser(req: Request, res: Response): void {
      try {
        const actor = requireAdminRequest(req);
        const targetUserId = req.params.id;
        const body = req.body as Record<string, unknown>;
        const role = body.role;
        if (typeof targetUserId !== "string" || !targetUserId) {
          throw new HttpError(400, "User id is required");
        }
        if (role !== "admin" && role !== "user") {
          throw new HttpError(400, "Invalid role");
        }
        res.json({ user: updateWebUserRole(config, actor.id, targetUserId, role) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(errorStatus(error, 500)).json({ error: message });
      }
    },
    deleteUser(req: Request, res: Response): void {
      try {
        const actor = requireAdminRequest(req);
        const targetUserId = req.params.id;
        if (typeof targetUserId !== "string" || !targetUserId) {
          throw new HttpError(400, "User id is required");
        }
        deleteWebUser(config, actor.id, targetUserId);
        res.json({ ok: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(errorStatus(error, 500)).json({ error: message });
      }
    },
    requireAuth(req: Request, res: Response, next: NextFunction): void {
      if (!isWebAuthEnabled(config) || getRequestUser(config, req)) {
        next();
        return;
      }
      res.status(401).json({ error: "Authentication required" });
    },
  };
}
