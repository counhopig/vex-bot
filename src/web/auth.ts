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

const SESSION_COOKIE = "vexsid";
const PASSWORD_KEY_LENGTH = 64;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface WebUser {
  id: string;
  username: string;
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

function getAuthStorePath(config: VexConfig): string {
  return config.webAuth?.database ?? join(homedir(), ".vex", "web-auth.sqlite");
}

function openAuthDatabase(config: VexConfig): Database.Database {
  const file = getAuthStorePath(config);
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS web_users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
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
  `);
  return db;
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

function serializeSessionCookie(sessionId: string, maxAgeSeconds: number): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ].join("; ");
}

function toPublicUser(user: WebUser): PublicWebUser {
  return {
    id: user.id,
    username: user.username,
    createdAt: user.createdAt,
    hasWeixin: Boolean(user.weixin?.token),
    weixinAccountId: user.weixin?.accountId,
  };
}

interface WebUserRow {
  id: string;
  username: string;
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
    SELECT u.id, u.username, u.password_hash, u.password_salt, u.created_at,
           w.token, w.account_id, w.base_url, w.ilink_user_id, w.updated_at
      FROM web_users u
      LEFT JOIN web_user_weixin w ON w.user_id = u.id
     WHERE u.username = ?
  `).get(username) as WebUserRow | undefined;
  return row ? rowToUser(row) : null;
}

function getUserById(db: Database.Database, userId: string): WebUser | null {
  const row = db.prepare(`
    SELECT u.id, u.username, u.password_hash, u.password_salt, u.created_at,
           w.token, w.account_id, w.base_url, w.ilink_user_id, w.updated_at
      FROM web_users u
      LEFT JOIN web_user_weixin w ON w.user_id = u.id
     WHERE u.id = ?
  `).get(userId) as WebUserRow | undefined;
  return row ? rowToUser(row) : null;
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
  try {
    db.prepare("DELETE FROM web_sessions WHERE expires_at <= ?").run(now);
    const sessionRow = db.prepare("SELECT id, user_id, created_at, expires_at FROM web_sessions WHERE id = ? AND expires_at > ?")
      .get(sessionId, now) as WebSessionRow | undefined;
    if (!sessionRow) return null;
    const user = getUserById(db, sessionRow.user_id);
    return user ? toPublicUser(user) : null;
  } finally {
    db.close();
  }
}

export function createWebUser(config: VexConfig, username: string, password: string): PublicWebUser {
  const normalizedUsername = username.trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(normalizedUsername)) {
    throw new Error("Username must be 3-32 characters and use letters, numbers, dot, underscore, or dash");
  }
  if (password.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }

  const db = openAuthDatabase(config);
  const passwordData = hashPassword(password);
  const user: WebUser = {
    id: `user_${randomBytes(12).toString("hex")}`,
    username: normalizedUsername,
    passwordHash: passwordData.hash,
    passwordSalt: passwordData.salt,
    createdAt: Date.now(),
  };
  try {
    db.prepare(`
      INSERT INTO web_users (id, username, password_hash, password_salt, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(user.id, user.username, user.passwordHash, user.passwordSalt, user.createdAt);
    return toPublicUser(user);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("UNIQUE")) {
      throw new Error("Username already exists");
    }
    throw error;
  } finally {
    db.close();
  }
}

export function loginWebUser(config: VexConfig, username: string, password: string): { user: PublicWebUser; session: WebAuthSession } {
  const normalizedUsername = username.trim().toLowerCase();
  const db = openAuthDatabase(config);
  try {
    const user = getUserByUsername(db, normalizedUsername);
    if (!user || !verifyPassword(password, user)) {
      throw new Error("Invalid username or password");
    }

    const now = Date.now();
    db.prepare("DELETE FROM web_sessions WHERE expires_at <= ?").run(now);
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
  } finally {
    db.close();
  }
}

export function logoutWebUser(config: VexConfig, req: IncomingMessage): void {
  const sessionId = parseCookieHeader(req.headers.cookie)[SESSION_COOKIE];
  if (!sessionId) return;
  const db = openAuthDatabase(config);
  try {
    db.prepare("DELETE FROM web_sessions WHERE id = ?").run(sessionId);
  } finally {
    db.close();
  }
}

export function setLoginCookie(res: ServerResponse, session: WebAuthSession): void {
  const maxAgeSeconds = Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000));
  res.setHeader("Set-Cookie", serializeSessionCookie(session.id, maxAgeSeconds));
}

export function clearLoginCookie(res: ServerResponse): void {
  res.setHeader("Set-Cookie", serializeSessionCookie("", 0));
}

export function saveUserWeixinLogin(config: VexConfig, userId: string, login: LoginResult): PublicWebUser {
  const db = openAuthDatabase(config);
  try {
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
  } finally {
    db.close();
  }
}

export function listUserWeixinLogins(config: VexConfig): StoredUserWeixinLogin[] {
  if (!isWebAuthEnabled(config)) return [];
  const db = openAuthDatabase(config);
  try {
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
  } finally {
    db.close();
  }
}

function getCredentials(body: unknown): { username: string; password: string } {
  if (body === null || typeof body !== "object") {
    throw new Error("Request body must be an object");
  }
  const record = body as Record<string, unknown>;
  const username = typeof record.username === "string" ? record.username : "";
  const password = typeof record.password === "string" ? record.password : "";
  if (!username || !password) {
    throw new Error("Username and password are required");
  }
  return { username, password };
}

export function installWebAuthRoutes(config: VexConfig) {
  return {
    register(req: Request, res: Response): void {
      try {
        const credentials = getCredentials(req.body);
        createWebUser(config, credentials.username, credentials.password);
        const login = loginWebUser(config, credentials.username, credentials.password);
        setLoginCookie(res, login.session);
        res.json({ user: login.user });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(400).json({ error: message });
      }
    },
    login(req: Request, res: Response): void {
      try {
        const credentials = getCredentials(req.body);
        const login = loginWebUser(config, credentials.username, credentials.password);
        setLoginCookie(res, login.session);
        res.json({ user: login.user });
      } catch {
        res.status(401).json({ error: "Invalid username or password" });
      }
    },
    logout(req: Request, res: Response): void {
      logoutWebUser(config, req);
      clearLoginCookie(res);
      res.json({ ok: true });
    },
    me(req: Request, res: Response): void {
      const user = getRequestUser(config, req);
      res.json({ user });
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
