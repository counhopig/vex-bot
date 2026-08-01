/**
 * WebAuthStore — local Web UI authentication and per-user account storage.
 *
 * Ported from _archive/src/web/auth.ts to a class-based API. The archive's
 * module-level singletons (`cachedAuthDb`, `dummyCredentials`, `loginFailures`)
 * are instance state now (principle #5 — no process-global state bleeding
 * across instances). Every security contract is preserved:
 *  - async scrypt (libuv threadpool — a sync scrypt on an unauthenticated
 *    route would let anyone stall the event loop)
 *  - timingSafeEqual password verification
 *  - dummy-credential timing equalization against username enumeration
 *  - per-IP+username brute-force rate limiting (10 failures / 5 min window)
 *  - first registered user becomes admin; admins cannot self-demote/delete
 *  - session cookie HttpOnly + SameSite=Lax + conditional Secure
 *  - malformed foreign cookies never throw
 *  - corrupt settings rows self-heal
 */

import { randomBytes, scrypt, timingSafeEqual } from "crypto";
import type { IncomingMessage, ServerResponse } from "http";
import type { Request, Response, NextFunction } from "express";
import Database from "better-sqlite3";
import { getChildLogger } from "../../utils/logger.js";
import {
  getDefaultAuthDbPath,
  openAuthDatabase,
  type WeixinLoginInput,
} from "../WeixinCredentialStore.js";

const logger = getChildLogger("web-auth");

const SESSION_COOKIE = "vexsid";
const PASSWORD_KEY_LENGTH = 64;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Brute-force throttle for login: fixed window per IP+username, in memory.
// Sized for a self-hosted instance — no external store, resets on restart.
const LOGIN_ATTEMPT_WINDOW_MS = 5 * 60_000;
const LOGIN_MAX_FAILURES = 10;

/** Error that carries the HTTP status it should be reported with, so route
 *  handlers don't have to guess the status from the error message. */
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

/** Per-user config overrides stored in web_user_settings. Structurally
 *  compatible with the config layer's SqliteLoader.UserConfigSettings. */
export interface UserConfigSettings {
  agent?: Record<string, unknown>;
  memory?: Record<string, unknown>;
  persona?: Record<string, unknown>;
  skillLearner?: Record<string, unknown>;
  sharelink?: Record<string, unknown>;
  weather?: Record<string, unknown>;
  sessions?: Record<string, unknown>;
}

export interface WebAuthStoreOptions {
  /** SQLite file path. Defaults to ~/.vex/web-auth.sqlite. */
  dbPath?: string;
  /** When false, getRequestUser always returns null (single-user mode). */
  enabled?: boolean;
  /** Forces the Secure cookie attribute; otherwise auto-detected per request. */
  secureCookies?: boolean;
  /** When true, self-service registration stays open past the first account. */
  allowRegistration?: boolean;
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

export class WebAuthStore {
  private readonly db: Database.Database;
  private readonly _enabled: boolean;
  private readonly _secureCookies?: boolean;
  private _allowRegistration: boolean;

  // Instance-scoped (was module-level in the archive — principle #5).
  private dummyCredentials: Pick<WebUser, "passwordHash" | "passwordSalt"> | null = null;
  private readonly loginFailures = new Map<string, { windowStart: number; count: number }>();
  private lastSessionPrune = 0;

  constructor(options: WebAuthStoreOptions = {}) {
    const dbPath = options.dbPath ?? getDefaultAuthDbPath();
    this.db = openAuthDatabase(dbPath);
    this._enabled = options.enabled ?? true;
    this._secureCookies = options.secureCookies;
    this._allowRegistration = options.allowRegistration ?? false;
  }

  get isEnabled(): boolean {
    return this._enabled;
  }

  setAllowRegistration(flag: boolean): void {
    this._allowRegistration = flag;
  }

  get allowRegistration(): boolean {
    return this._allowRegistration;
  }

  static getSessionCookieName(): string {
    return SESSION_COOKIE;
  }

  // ---------------------------------------------------------------------
  // Password hashing (async scrypt — threadpool, never sync on auth routes)
  // ---------------------------------------------------------------------

  private async scryptAsync(password: string, salt: string): Promise<Buffer> {
    return new Promise((resolvePromise, reject) => {
      scrypt(password, salt, PASSWORD_KEY_LENGTH, (error, derivedKey) => {
        if (error) reject(error);
        else resolvePromise(derivedKey);
      });
    });
  }

  private async hashPassword(password: string, salt = randomBytes(16).toString("hex")): Promise<{ hash: string; salt: string }> {
    return {
      hash: (await this.scryptAsync(password, salt)).toString("hex"),
      salt,
    };
  }

  private async verifyPassword(password: string, user: Pick<WebUser, "passwordHash" | "passwordSalt">): Promise<boolean> {
    const expected = Buffer.from(user.passwordHash, "hex");
    const actual = await this.scryptAsync(password, user.passwordSalt);
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  }

  /** Lazy dummy credentials: verifying against them costs the same scrypt as
   *  the wrong-password path, so response time cannot reveal which usernames
   *  are registered. */
  private async getDummyCredentials(): Promise<Pick<WebUser, "passwordHash" | "passwordSalt">> {
    if (!this.dummyCredentials) {
      const data = await this.hashPassword(randomBytes(32).toString("hex"));
      this.dummyCredentials = { passwordHash: data.hash, passwordSalt: data.salt };
    }
    return this.dummyCredentials;
  }

  // ---------------------------------------------------------------------
  // Cookies
  // ---------------------------------------------------------------------

  private parseCookieHeader(header: string | string[] | undefined): Record<string, string> {
    const cookieHeader = Array.isArray(header) ? header.join("; ") : header ?? "";
    const cookies: Record<string, string> = {};
    for (const part of cookieHeader.split(";")) {
      const [rawName, ...rawValue] = part.trim().split("=");
      if (!rawName) continue;
      const value = rawValue.join("=");
      // Other origins' cookies arrive here too; a malformed percent-encoding in
      // any of them must not throw and take every authenticated route down.
      try {
        cookies[rawName] = decodeURIComponent(value);
      } catch {
        cookies[rawName] = value;
      }
    }
    return cookies;
  }

  private serializeSessionCookie(sessionId: string, maxAgeSeconds: number, secure: boolean): string {
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

  /** Decide whether the session cookie should carry Secure: forced by the
   *  constructor option when set, otherwise auto-detected from the request
   *  (req.secure / x-forwarded-proto). */
  shouldUseSecureCookie(req: Request): boolean {
    if (typeof this._secureCookies === "boolean") return this._secureCookies;
    if (req.secure) return true;
    const forwardedProto = req.headers["x-forwarded-proto"];
    const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
    return (proto ?? "").split(",")[0]?.trim() === "https";
  }

  /** True when no user exists yet — self-service registration is allowed only
   *  for bootstrapping the first (admin) account. */
  needsBootstrapAdmin(): boolean {
    return this.countWebUsers() === 0;
  }

  /** Throw HttpError(429) when the key has exceeded the brute-force limit. */
  checkLoginRateLimit(rateKey: string): void {
    assertLoginAllowed(this.loginFailures, rateKey, Date.now());
  }

  /** Record a failed login attempt for the key (10 failures / 5 min window). */
  recordLoginFailure(rateKey: string): void {
    recordLoginFailure(this.loginFailures, rateKey, Date.now());
  }

  /** Clear the failure counter for a key after a successful login. */
  clearLoginFailures(rateKey: string): void {
    this.loginFailures.delete(rateKey);
  }

  // ---------------------------------------------------------------------
  // Row mapping
  // ---------------------------------------------------------------------

  private rowToUser(row: WebUserRow): WebUser {
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

  private rowToSession(row: WebSessionRow): WebAuthSession {
    return {
      id: row.id,
      userId: row.user_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  private toPublicUser(user: WebUser): PublicWebUser {
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      createdAt: user.createdAt,
      hasWeixin: Boolean(user.weixin?.token),
      weixinAccountId: user.weixin?.accountId,
    };
  }

  private getUserByUsername(username: string): WebUser | null {
    const row = this.db.prepare(`
      SELECT u.id, u.username, u.role, u.password_hash, u.password_salt, u.created_at,
             w.token, w.account_id, w.base_url, w.ilink_user_id, w.updated_at
        FROM web_users u
        LEFT JOIN web_user_weixin w ON w.user_id = u.id
       WHERE u.username = ?
    `).get(username) as WebUserRow | undefined;
    return row ? this.rowToUser(row) : null;
  }

  private getUserById(userId: string): WebUser | null {
    const row = this.db.prepare(`
      SELECT u.id, u.username, u.role, u.password_hash, u.password_salt, u.created_at,
             w.token, w.account_id, w.base_url, w.ilink_user_id, w.updated_at
        FROM web_users u
        LEFT JOIN web_user_weixin w ON w.user_id = u.id
       WHERE u.id = ?
    `).get(userId) as WebUserRow | undefined;
    return row ? this.rowToUser(row) : null;
  }

  private countWebUsers(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM web_users").get() as { count: number };
    return row.count;
  }

  private requireAdmin(actorId: string): WebUser {
    const actor = this.getUserById(actorId);
    if (!actor || actor.role !== "admin") {
      throw new HttpError(403, "Admin privileges required");
    }
    return actor;
  }

  private pruneExpiredSessions(now: number): void {
    // Expired sessions are already excluded by every lookup's `expires_at > now`
    // filter, so pruning is pure housekeeping — throttle it instead of issuing
    // a DELETE write on every single request.
    if (now - this.lastSessionPrune < 60_000) return;
    this.lastSessionPrune = now;
    this.db.prepare("DELETE FROM web_sessions WHERE expires_at <= ?").run(now);
  }

  // ---------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------

  async createUser(username: string, password: string): Promise<PublicWebUser> {
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

    const passwordData = await this.hashPassword(password);
    const user: WebUser = {
      id: `user_${randomBytes(12).toString("hex")}`,
      username: normalizedUsername,
      role: "user",
      passwordHash: passwordData.hash,
      passwordSalt: passwordData.salt,
      createdAt: Date.now(),
    };
    try {
      const inserted = this.db.transaction(() => {
        const userCount = this.countWebUsers();
        const role: WebUser["role"] = userCount === 0 ? "admin" : "user";
        this.db.prepare(`
          INSERT INTO web_users (id, username, role, password_hash, password_salt, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(user.id, user.username, role, user.passwordHash, user.passwordSalt, user.createdAt);
        return { ...user, role };
      })();
      return this.toPublicUser(inserted);
    } catch (error) {
      // better-sqlite3 reports constraint violations with a structured code;
      // web_users has a single UNIQUE constraint (username).
      if ((error as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
        throw new HttpError(409, "Username already exists");
      }
      throw error;
    }
  }

  listUsers(actorId: string): PublicWebUser[] {
    this.requireAdmin(actorId);
    const rows = this.db.prepare(`
      SELECT u.id, u.username, u.role, u.password_hash, u.password_salt, u.created_at,
             w.token, w.account_id, w.base_url, w.ilink_user_id, w.updated_at
        FROM web_users u
        LEFT JOIN web_user_weixin w ON w.user_id = u.id
       ORDER BY u.created_at ASC
    `).all() as WebUserRow[];
    return rows.map((row) => this.toPublicUser(this.rowToUser(row)));
  }

  updateUserRole(
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

    this.requireAdmin(actorId);
    const target = this.getUserById(targetUserId);
    if (!target) throw new HttpError(404, "User not found");
    this.db.prepare("UPDATE web_users SET role = ? WHERE id = ?").run(role, targetUserId);
    const updated = this.getUserById(targetUserId);
    if (!updated) throw new HttpError(404, "User not found");
    return this.toPublicUser(updated);
  }

  deleteUser(actorId: string, targetUserId: string): void {
    if (actorId === targetUserId) {
      throw new HttpError(403, "Admins cannot delete their own account");
    }

    this.requireAdmin(actorId);
    const target = this.getUserById(targetUserId);
    if (!target) throw new HttpError(404, "User not found");
    this.db.prepare("DELETE FROM web_users WHERE id = ?").run(targetUserId);
  }

  async login(username: string, password: string): Promise<{ user: PublicWebUser; session: WebAuthSession }> {
    const normalizedUsername = username.trim().toLowerCase();
    const user = this.getUserByUsername(normalizedUsername);
    const valid = await this.verifyPassword(password, user ?? (await this.getDummyCredentials()));
    if (!user || !valid) {
      throw new HttpError(401, "Invalid username or password");
    }

    const now = Date.now();
    this.pruneExpiredSessions(now);
    const session: WebAuthSession = {
      id: `sess_${randomBytes(24).toString("hex")}`,
      userId: user.id,
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
    };
    this.db.prepare(`
      INSERT INTO web_sessions (id, user_id, created_at, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(session.id, session.userId, session.createdAt, session.expiresAt);
    return { user: this.toPublicUser(user), session };
  }

  logout(req: IncomingMessage): void {
    const sessionId = this.parseCookieHeader(req.headers.cookie)[SESSION_COOKIE];
    if (!sessionId) return;
    this.db.prepare("DELETE FROM web_sessions WHERE id = ?").run(sessionId);
  }

  getRequestUser(req: IncomingMessage): PublicWebUser | null {
    if (!this._enabled) return null;
    const sessionId = this.parseCookieHeader(req.headers.cookie)[SESSION_COOKIE];
    if (!sessionId) return null;

    const now = Date.now();
    this.pruneExpiredSessions(now);
    const sessionRow = this.db.prepare("SELECT id, user_id, created_at, expires_at FROM web_sessions WHERE id = ? AND expires_at > ?")
      .get(sessionId, now) as WebSessionRow | undefined;
    if (!sessionRow) return null;
    const user = this.getUserById(sessionRow.user_id);
    return user ? this.toPublicUser(user) : null;
  }

  setLoginCookie(res: ServerResponse, session: WebAuthSession, secure = false): void {
    const maxAgeSeconds = Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000));
    res.setHeader("Set-Cookie", this.serializeSessionCookie(session.id, maxAgeSeconds, secure));
  }

  clearLoginCookie(res: ServerResponse, secure = false): void {
    res.setHeader("Set-Cookie", this.serializeSessionCookie("", 0, secure));
  }

  // ---------------------------------------------------------------------
  // Weixin credential writes (user-facing, return PublicWebUser)
  // ---------------------------------------------------------------------

  saveUserWeixinLogin(userId: string, login: WeixinLoginInput): PublicWebUser {
    const user = this.getUserById(userId);
    if (!user) throw new HttpError(404, "User not found");
    this.db.prepare(`
      INSERT INTO web_user_weixin (user_id, token, account_id, base_url, ilink_user_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        token = excluded.token,
        account_id = excluded.account_id,
        base_url = excluded.base_url,
        ilink_user_id = excluded.ilink_user_id,
        updated_at = excluded.updated_at
    `).run(userId, login.token, login.accountId, login.baseUrl ?? null, login.userId ?? null, Date.now());
    // Synchronous driver, single process: the user cannot vanish between the
    // check above and this re-read (which picks up the new weixin state).
    return this.toPublicUser(this.getUserById(userId)!);
  }

  deleteUserWeixinLogin(userId: string): PublicWebUser {
    const user = this.getUserById(userId);
    if (!user) throw new HttpError(404, "User not found");
    this.db.prepare("DELETE FROM web_user_weixin WHERE user_id = ?").run(userId);
    return this.toPublicUser(this.getUserById(userId)!);
  }

  // ---------------------------------------------------------------------
  // Per-user config settings (web_user_settings)
  // ---------------------------------------------------------------------

  getUserConfigSettings(userId: string): UserConfigSettings {
    const row = this.db.prepare("SELECT settings_json FROM web_user_settings WHERE user_id = ?")
      .get(userId) as { settings_json: string } | undefined;
    if (!row) return {};
    try {
      const parsed = JSON.parse(row.settings_json) as UserConfigSettings;
      if (parsed && typeof parsed === "object") return parsed;
    } catch (error) {
      logger.warn({ error, userId }, "Corrupt user settings row; falling back to empty settings");
    }
    // A corrupt row must not brick the user's runtime — the next save overwrites it.
    return {};
  }

  saveUserConfigSettings(userId: string, patch: UserConfigSettings): UserConfigSettings {
    const user = this.getUserById(userId);
    if (!user) throw new HttpError(404, "User not found");
    const next = this.mergeUserConfigSettings(this.getUserConfigSettings(userId), patch);
    this.db.prepare(`
      INSERT INTO web_user_settings (user_id, settings_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        settings_json = excluded.settings_json,
        updated_at = excluded.updated_at
    `).run(userId, JSON.stringify(next), Date.now());
    return next;
  }

  private mergeUserConfigSettings(existing: UserConfigSettings, patch: UserConfigSettings): UserConfigSettings {
    return {
      ...existing,
      ...(patch.agent ? { agent: { ...existing.agent, ...patch.agent } } : {}),
      ...(patch.memory ? { memory: { ...existing.memory, ...patch.memory } } : {}),
      ...(patch.persona ? { persona: { ...existing.persona, ...patch.persona } } : {}),
      ...(patch.skillLearner ? { skillLearner: { ...existing.skillLearner, ...patch.skillLearner } } : {}),
      ...(patch.sharelink ? { sharelink: this.mergeSharelinkSettings(existing.sharelink, patch.sharelink) } : {}),
      ...(patch.weather ? { weather: { ...existing.weather, ...patch.weather } } : {}),
      ...(patch.sessions ? { sessions: { ...existing.sessions, ...patch.sessions } } : {}),
    };
  }

  private mergeSharelinkSettings(
    existing: UserConfigSettings["sharelink"],
    patch: UserConfigSettings["sharelink"],
  ): UserConfigSettings["sharelink"] {
    if (!patch) return existing;
    const next = { ...existing, ...patch };
    if (!patch.bilibiliCookie) return next;
    next.bilibiliCookie = {
      ...((existing?.bilibiliCookie as Record<string, unknown> | undefined) ?? {}),
      ...(patch.bilibiliCookie as Record<string, unknown>),
    };
    return next;
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // Already closed.
    }
  }
}

// ---------------------------------------------------------------------
// Route layer
// ---------------------------------------------------------------------

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

export interface WebAuthRoutes {
  register(req: Request, res: Response): Promise<void>;
  createUser(req: Request, res: Response): Promise<void>;
  login(req: Request, res: Response): Promise<void>;
  logout(req: Request, res: Response): void;
  me(req: Request, res: Response): void;
  listUsers(req: Request, res: Response): void;
  updateUser(req: Request, res: Response): void;
  deleteUser(req: Request, res: Response): void;
  requireAuth(req: Request, res: Response, next: NextFunction): void;
}

/** Build the Express route handlers for a WebAuthStore instance. */
export function installWebAuthRoutes(store: WebAuthStore): WebAuthRoutes {
  function requireAdminRequest(req: Request): PublicWebUser {
    const user = store.getRequestUser(req);
    if (!user || user.role !== "admin") {
      throw new HttpError(403, "Admin privileges required");
    }
    return user;
  }

  function shouldUseSecureCookie(req: Request): boolean {
    return store.shouldUseSecureCookie(req);
  }

  return {
    async register(req: Request, res: Response): Promise<void> {
      try {
        // Self-service registration is only for bootstrapping the first account
        // (which becomes admin) or when the operator has explicitly opted into
        // open registration. Otherwise an admin must create the account, so a
        // publicly reachable instance can't be claimed by the first stranger.
        const isBootstrap = store.needsBootstrapAdmin();
        if (!isBootstrap && !store.allowRegistration) {
          res.status(403).json({ error: "Registration is disabled. Ask an administrator to create your account." });
          return;
        }
        const credentials = getCredentials(req.body);
        await store.createUser(credentials.username, credentials.password);
        const login = await store.login(credentials.username, credentials.password);
        store.setLoginCookie(res, login.session, shouldUseSecureCookie(req));
        res.json({ user: login.user });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(errorStatus(error, 500)).json({ error: message });
      }
    },

    async createUser(req: Request, res: Response): Promise<void> {
      try {
        requireAdminRequest(req);
        const credentials = getCredentials(req.body);
        // Create the account without logging the admin out of their own session.
        const user = await store.createUser(credentials.username, credentials.password);
        res.json({ user });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(errorStatus(error, 500)).json({ error: message });
      }
    },

    async login(req: Request, res: Response): Promise<void> {
      try {
        const credentials = getCredentials(req.body);
        const rateKey = `${req.ip ?? "unknown"}|${credentials.username.trim().toLowerCase()}`;
        store.checkLoginRateLimit(rateKey);
        let login;
        try {
          login = await store.login(credentials.username, credentials.password);
        } catch (error) {
          if (error instanceof HttpError && error.status === 401) {
            store.recordLoginFailure(rateKey);
          }
          throw error;
        }
        store.clearLoginFailures(rateKey);
        store.setLoginCookie(res, login.session, shouldUseSecureCookie(req));
        res.json({ user: login.user });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(errorStatus(error, 500)).json({ error: message });
      }
    },

    logout(req: Request, res: Response): void {
      store.logout(req);
      store.clearLoginCookie(res, shouldUseSecureCookie(req));
      res.json({ ok: true });
    },

    me(req: Request, res: Response): void {
      const user = store.getRequestUser(req);
      res.json({ user });
    },

    listUsers(req: Request, res: Response): void {
      try {
        const actor = requireAdminRequest(req);
        res.json({ users: store.listUsers(actor.id) });
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
        res.json({ user: store.updateUserRole(actor.id, targetUserId, role) });
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
        store.deleteUser(actor.id, targetUserId);
        res.json({ ok: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(errorStatus(error, 500)).json({ error: message });
      }
    },

    requireAuth(req: Request, res: Response, next: NextFunction): void {
      if (!store.isEnabled || store.getRequestUser(req)) {
        next();
        return;
      }
      res.status(401).json({ error: "Authentication required" });
    },
  };
}

// ---------------------------------------------------------------------
// Login rate limiting (per IP+username, in-memory, per-store instance)
// ---------------------------------------------------------------------

type LoginFailureMap = Map<string, { windowStart: number; count: number }>;

function assertLoginAllowed(failures: LoginFailureMap, key: string, now: number): void {
  const entry = failures.get(key);
  if (!entry || now - entry.windowStart >= LOGIN_ATTEMPT_WINDOW_MS) return;
  if (entry.count >= LOGIN_MAX_FAILURES) {
    throw new HttpError(429, "Too many failed login attempts. Try again later.");
  }
}

function recordLoginFailure(failures: LoginFailureMap, key: string, now: number): void {
  const entry = failures.get(key);
  if (entry && now - entry.windowStart < LOGIN_ATTEMPT_WINDOW_MS) {
    entry.count += 1;
    return;
  }
  // Starting a fresh window; drop stale entries so the map cannot grow unbounded.
  if (failures.size >= 10_000) {
    for (const [staleKey, stale] of failures) {
      if (now - stale.windowStart >= LOGIN_ATTEMPT_WINDOW_MS) failures.delete(staleKey);
    }
  }
  failures.set(key, { windowStart: now, count: 1 });
}
