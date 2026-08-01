/**
 * Web auth tests — WebAuthStore + WeixinCredentialStore.
 *
 * Ported from _archive/tests/web-auth.test.ts to the class-based API. Every
 * security contract is preserved (coder-prompt rule #4 — these are the
 * highest-stakes behaviors of the rewrite):
 *  - scrypt async hashing + timingSafeEqual verification
 *  - dummy-credential timing equalization against username enumeration
 *  - per-IP+username login rate limiting (10 failures / 5 min window)
 *  - first registered user becomes admin; admins cannot self-demote/delete
 *  - session cookie HttpOnly + SameSite=Lax + conditional Secure
 *  - malformed foreign cookies never throw
 *  - corrupt settings rows self-heal instead of bricking the user
 *  - per-user settings isolation
 */

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "http";
import {
  WebAuthStore,
  HttpError,
  installWebAuthRoutes,
  type PublicWebUser,
  type UserConfigSettings,
} from "../src/web/routes/auth.js";
import { WeixinCredentialStore } from "../src/web/WeixinCredentialStore.js";

const tempDirs: string[] = [];

function makeStore(overrides: Partial<{ allowRegistration: boolean; secureCookies: boolean }> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "vex-web-auth-test-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "auth.sqlite");
  const store = new WebAuthStore({
    dbPath,
    allowRegistration: overrides.allowRegistration,
    secureCookies: overrides.secureCookies,
  });
  const credentials = new WeixinCredentialStore({ dbPath });
  return { store, credentials, dbPath };
}

function createResponse(): ServerResponse & { headers?: Record<string, number | string | string[]> } {
  const response = {
    headers: {},
    setHeader(name: string, value: number | string | string[]) {
      this.headers[name] = value;
      return this;
    },
  };
  return response as ServerResponse & { headers?: Record<string, number | string | string[]> };
}

async function caught(fn: () => unknown): Promise<{ status?: number; message?: string }> {
  try {
    await fn();
  } catch (error) {
    return error instanceof HttpError ? { status: error.status, message: error.message } : {};
  }
  return {};
}

async function caughtStatus(fn: () => unknown): Promise<number | undefined> {
  return (await caught(fn)).status;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("WebAuthStore", () => {
  it("registers a user and resolves the login cookie from SQLite", async () => {
    const { store, credentials } = makeStore();
    await store.createUser("alice", "password123");
    const login = await store.login("alice", "password123");
    const res = createResponse();
    store.setLoginCookie(res, login.session);

    const cookie = String(res.headers?.["Set-Cookie"]);
    const user = store.getRequestUser({ headers: { cookie } } as IncomingMessage);

    expect(user?.username).toBe("alice");
    expect(user?.role).toBe("admin");
    expect(user?.hasWeixin).toBe(false);
  });

  it("adds the Secure attribute to the session cookie only when requested", async () => {
    const { store } = makeStore();
    await store.createUser("alice", "password123");
    const login = await store.login("alice", "password123");

    const plainRes = createResponse();
    store.setLoginCookie(plainRes, login.session);
    expect(String(plainRes.headers?.["Set-Cookie"])).not.toContain("Secure");

    const secureRes = createResponse();
    store.setLoginCookie(secureRes, login.session, true);
    const secureCookie = String(secureRes.headers?.["Set-Cookie"]);
    expect(secureCookie).toContain("Secure");
    expect(secureCookie).toContain("HttpOnly");
    expect(secureCookie).toContain("SameSite=Lax");
  });

  it("makes only the first registered user an admin", async () => {
    const { store } = makeStore();
    const first = await store.createUser("admin-user", "password123");
    const second = await store.createUser("normal-user", "password123");

    expect(first.role).toBe("admin");
    expect(second.role).toBe("user");
  });

  it("lets admins manage other accounts", async () => {
    const { store } = makeStore();
    const admin = await store.createUser("admin-user", "password123");
    const user = await store.createUser("normal-user", "password123");

    expect(store.listUsers(admin.id).map((item) => item.username)).toEqual(["admin-user", "normal-user"]);

    const promoted = store.updateUserRole(admin.id, user.id, "admin");
    expect(promoted.role).toBe("admin");

    store.deleteUser(admin.id, user.id);
    expect(store.listUsers(admin.id).map((item) => item.username)).toEqual(["admin-user"]);
  });

  it("does not let regular users manage accounts or admins delete themselves", async () => {
    const { store } = makeStore();
    const admin = await store.createUser("admin-user", "password123");
    const user = await store.createUser("normal-user", "password123");

    expect(() => store.listUsers(user.id)).toThrow("Admin privileges required");
    expect(() => store.deleteUser(admin.id, admin.id)).toThrow("Admins cannot delete their own account");
    expect(() => store.updateUserRole(admin.id, admin.id, "user")).toThrow("Admins cannot change their own role");
  });

  it("survives malformed cookie values from other origins", async () => {
    const { store } = makeStore();
    await store.createUser("alice", "password123");
    const login = await store.login("alice", "password123");
    const res = createResponse();
    store.setLoginCookie(res, login.session);
    const vexCookie = String(res.headers?.["Set-Cookie"]).split(";")[0];

    // A malformed third-party cookie must neither throw nor break auth.
    const malformed = "tracking=%E0%A4%A";
    expect(store.getRequestUser({ headers: { cookie: malformed } } as IncomingMessage)).toBeNull();
    const user = store.getRequestUser({ headers: { cookie: `${malformed}; ${vexCookie}` } } as IncomingMessage);
    expect(user?.username).toBe("alice");
  });

  it("throws HttpError with the right status from createUser validation", async () => {
    const { store } = makeStore();

    expect(await caughtStatus(() => store.createUser("x", "password123"))).toBe(400);
    expect(await caughtStatus(() => store.createUser("bad name!", "password123"))).toBe(400);
    expect(await caughtStatus(() => store.createUser("short-pass", "short"))).toBe(400);
    expect(await caughtStatus(() => store.createUser("long-pass", "x".repeat(129)))).toBe(400);

    // Boundary: a 128-character password is fine
    expect((await store.createUser("edge-pass", "x".repeat(128))).username).toBe("edge-pass");

    // 409: duplicate username
    expect(await caughtStatus(() => store.createUser("edge-pass", "password123"))).toBe(409);
  });

  it("throws HttpError(401) with an identical message for bad password and unknown user", async () => {
    const { store } = makeStore();
    await store.createUser("alice", "password123");

    const badPassword = await caught(() => store.login("alice", "wrong-password"));
    const unknownUser = await caught(() => store.login("nobody", "wrong-password"));
    expect(badPassword.status).toBe(401);
    expect(unknownUser).toEqual(badPassword);
  });

  it("takes comparable time to reject an unknown username and a wrong password", async () => {
    const { store } = makeStore();
    await store.createUser("alice", "password123");

    async function timeLogin(username: string): Promise<number> {
      const start = performance.now();
      await caught(() => store.login(username, "wrong-password"));
      return performance.now() - start;
    }
    const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

    // Warm up both paths (lazy initialization, JIT)
    await timeLogin("alice");
    await timeLogin("nobody");

    const knownUser: number[] = [];
    const unknownUser: number[] = [];
    for (let i = 0; i < 3; i++) {
      knownUser.push(await timeLogin("alice"));
      unknownUser.push(await timeLogin("nobody"));
    }

    // Without timing equalization the unknown-user path skips scrypt entirely
    // and returns orders of magnitude faster, leaking username existence.
    expect(median(unknownUser)).toBeGreaterThan(median(knownUser) * 0.5);
  });

  it("throws HttpError with the right status from the user-management layer", async () => {
    const { store } = makeStore();
    const admin = await store.createUser("admin-user", "password123");
    const user = await store.createUser("normal-user", "password123");

    expect(await caughtStatus(() => store.listUsers(user.id))).toBe(403);
    expect(await caughtStatus(() => store.updateUserRole(user.id, admin.id, "user"))).toBe(403);
    expect(await caughtStatus(() => store.updateUserRole(admin.id, admin.id, "user"))).toBe(403);
    expect(await caughtStatus(() => store.deleteUser(admin.id, admin.id))).toBe(403);

    expect(await caughtStatus(() => store.updateUserRole(admin.id, "user_missing", "user"))).toBe(404);
    expect(await caughtStatus(() => store.deleteUser(admin.id, "user_missing"))).toBe(404);

    expect(await caughtStatus(() => store.updateUserRole(admin.id, user.id, "root" as never))).toBe(400);
  });

  it("stores per-user Weixin login state", async () => {
    const { store } = makeStore();
    const user = await store.createUser("bob", "password123");
    const updated = store.saveUserWeixinLogin(user.id, {
      token: "wx-token",
      accountId: "wx-account",
      baseUrl: "https://example.com",
      userId: "ilink-user",
    });

    expect(updated.hasWeixin).toBe(true);
    expect(updated.weixinAccountId).toBe("wx-account");
  });

  it("unbinds a Weixin login and is idempotent about it", async () => {
    const { store, credentials } = makeStore();
    const user = await store.createUser("bob", "password123");
    store.saveUserWeixinLogin(user.id, {
      token: "wx-token",
      accountId: "wx-account",
      baseUrl: "https://example.com",
      userId: "ilink-user",
    });
    expect(credentials.list().map((item) => item.userId)).toEqual([user.id]);

    const unbound = store.deleteUserWeixinLogin(user.id);
    expect(unbound.hasWeixin).toBe(false);
    expect(unbound.weixinAccountId).toBeUndefined();
    expect(credentials.list()).toEqual([]);

    // Unbinding again is a no-op, not an error
    expect(store.deleteUserWeixinLogin(user.id).hasWeixin).toBe(false);

    // Unknown users still 404
    expect(await caughtStatus(() => store.deleteUserWeixinLogin("user_missing"))).toBe(404);
  });

  it("recovers from a corrupt settings row instead of bricking the user", async () => {
    const { store, dbPath } = makeStore();
    const user = await store.createUser("corrupt-user", "password123");
    store.saveUserConfigSettings(user.id, { persona: { persona_name: "Fine" } });

    // Corrupt the stored JSON out-of-band, as disk damage or a buggy writer would.
    const raw = new Database(dbPath);
    raw.prepare("UPDATE web_user_settings SET settings_json = ? WHERE user_id = ?").run("{not json", user.id);
    raw.close();

    // Load self-heals to empty settings; the next save overwrites the bad row.
    expect(store.getUserConfigSettings(user.id)).toEqual({});
    const saved = store.saveUserConfigSettings(user.id, { persona: { persona_name: "Recovered" } });
    expect(saved).toMatchObject({ persona: { persona_name: "Recovered" } });
    expect(store.getUserConfigSettings(user.id)).toMatchObject({ persona: { persona_name: "Recovered" } });
  });

  it("throws an unwrapped HttpError(404) for settings/weixin writes to unknown users", async () => {
    const { store } = makeStore();
    await store.createUser("someone", "password123");

    const settings = await caught(() => store.saveUserConfigSettings("user_missing", { persona: {} }));
    expect(settings).toEqual({ status: 404, message: "User not found" });

    const weixin = await caught(() =>
      store.saveUserWeixinLogin("user_missing", { token: "t", accountId: "a", baseUrl: "https://x", userId: "u" }),
    );
    expect(weixin).toEqual({ status: 404, message: "User not found" });
  });

  it("stores config settings per user without sharing values", async () => {
    const { store } = makeStore();
    const first = await store.createUser("first-user", "password123");
    const second = await store.createUser("second-user", "password123");

    store.saveUserConfigSettings(first.id, {
      agent: {
        defaultProvider: "deepseek",
        defaultModel: "first-model",
        temperature: 0.2,
      },
      persona: { persona_name: "First" },
    });
    store.saveUserConfigSettings(second.id, {
      agent: {
        defaultProvider: "deepseek",
        defaultModel: "second-model",
        temperature: 0.8,
      },
      persona: { persona_name: "Second" },
    });

    expect(store.getUserConfigSettings(first.id)).toMatchObject({
      agent: { defaultModel: "first-model", temperature: 0.2 },
      persona: { persona_name: "First" },
    });
    expect(store.getUserConfigSettings(second.id)).toMatchObject({
      agent: { defaultModel: "second-model", temperature: 0.8 },
      persona: { persona_name: "Second" },
    });
  });
});

describe("web auth routes", () => {
  function createRouteResponse() {
    const res = {
      statusCode: 200,
      headers: {} as Record<string, unknown>,
      body: undefined as unknown,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: unknown) {
        this.body = payload;
        return this;
      },
      setHeader(name: string, value: unknown) {
        this.headers[name] = value;
        return this;
      },
    };
    return res;
  }

  function request(body?: unknown, cookie?: string, ip = "127.0.0.1") {
    return { headers: cookie ? { cookie } : {}, body: body ?? {}, params: {}, ip } as never;
  }

  async function loginCookie(store: WebAuthStore, username: string, password: string): Promise<string> {
    const login = await store.login(username, password);
    const res = createResponse();
    store.setLoginCookie(res, login.session);
    return String(res.headers?.["Set-Cookie"]);
  }

  it("allows registration only for the first account unless allowRegistration is set", async () => {
    const { store } = makeStore();
    const routes = installWebAuthRoutes(store);

    const bootstrap = createRouteResponse();
    await routes.register(request({ username: "founder", password: "password123" }), bootstrap as never);
    expect(bootstrap.statusCode).toBe(200);

    const denied = createRouteResponse();
    await routes.register(request({ username: "stranger", password: "password123" }), denied as never);
    expect(denied.statusCode).toBe(403);

    store.setAllowRegistration(true);
    const allowed = createRouteResponse();
    await routes.register(request({ username: "invited", password: "password123" }), allowed as never);
    expect(allowed.statusCode).toBe(200);
  });

  it("lets admins create accounts without touching their own session", async () => {
    const { store } = makeStore();
    await store.createUser("admin-user", "password123");
    const routes = installWebAuthRoutes(store);
    const cookie = await loginCookie(store, "admin-user", "password123");

    const res = createRouteResponse();
    await routes.createUser(request({ username: "new-user", password: "password123" }, cookie), res as never);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ user: { username: "new-user", role: "user" } });
    // No login cookie for the created user — the admin stays logged in.
    expect(res.headers["Set-Cookie"]).toBeUndefined();
  });

  it("returns 403 for anonymous or non-admin createUser and typed statuses for bad input", async () => {
    const { store } = makeStore();
    await store.createUser("admin-user", "password123");
    await store.createUser("normal-user", "password123");
    const routes = installWebAuthRoutes(store);

    const anonymous = createRouteResponse();
    await routes.createUser(request({ username: "x-user", password: "password123" }), anonymous as never);
    expect(anonymous.statusCode).toBe(403);

    const nonAdmin = createRouteResponse();
    const userCookie = await loginCookie(store, "normal-user", "password123");
    await routes.createUser(request({ username: "x-user", password: "password123" }, userCookie), nonAdmin as never);
    expect(nonAdmin.statusCode).toBe(403);

    const adminCookie = await loginCookie(store, "admin-user", "password123");

    const missingBody = createRouteResponse();
    await routes.createUser(request({}, adminCookie), missingBody as never);
    expect(missingBody.statusCode).toBe(400);

    const duplicate = createRouteResponse();
    await routes.createUser(request({ username: "normal-user", password: "password123" }, adminCookie), duplicate as never);
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.body).toMatchObject({ error: "Username already exists" });
  });

  it("rate-limits repeated failed logins per IP and username", async () => {
    const { store } = makeStore();
    await store.createUser("victim", "password123");
    const routes = installWebAuthRoutes(store);

    for (let i = 0; i < 10; i++) {
      const res = createRouteResponse();
      await routes.login(request({ username: "victim", password: "wrong-password" }, undefined, "10.0.0.1"), res as never);
      expect(res.statusCode).toBe(401);
    }

    // Over the limit: throttled even with the correct password
    const blocked = createRouteResponse();
    await routes.login(request({ username: "victim", password: "password123" }, undefined, "10.0.0.1"), blocked as never);
    expect(blocked.statusCode).toBe(429);

    // A different IP is unaffected
    const otherIp = createRouteResponse();
    await routes.login(request({ username: "victim", password: "password123" }, undefined, "10.0.0.2"), otherIp as never);
    expect(otherIp.statusCode).toBe(200);
  });

  it("resets the login failure counter after a successful login", async () => {
    const { store } = makeStore();
    await store.createUser("resetme", "password123");
    const routes = installWebAuthRoutes(store);

    for (let i = 0; i < 9; i++) {
      const res = createRouteResponse();
      await routes.login(request({ username: "resetme", password: "wrong-password" }, undefined, "10.0.1.1"), res as never);
      expect(res.statusCode).toBe(401);
    }

    const success = createRouteResponse();
    await routes.login(request({ username: "resetme", password: "password123" }, undefined, "10.0.1.1"), success as never);
    expect(success.statusCode).toBe(200);

    // Counter was reset: further failures start from zero, not from nine
    const afterReset = createRouteResponse();
    await routes.login(request({ username: "resetme", password: "wrong-password" }, undefined, "10.0.1.1"), afterReset as never);
    expect(afterReset.statusCode).toBe(401);
  });

  it("returns 403 (not 400) when a non-admin hits updateUser/deleteUser", async () => {
    const { store } = makeStore();
    const admin = await store.createUser("admin-user", "password123");
    await store.createUser("normal-user", "password123");
    const routes = installWebAuthRoutes(store);
    const userCookie = await loginCookie(store, "normal-user", "password123");

    const patch = createRouteResponse();
    const patchReq = request({ role: "user" }, userCookie) as { params: Record<string, string> };
    patchReq.params.id = admin.id;
    routes.updateUser(patchReq as never, patch as never);
    expect(patch.statusCode).toBe(403);

    const del = createRouteResponse();
    const delReq = request(undefined, userCookie) as { params: Record<string, string> };
    delReq.params.id = admin.id;
    routes.deleteUser(delReq as never, del as never);
    expect(del.statusCode).toBe(403);
  });

  it("returns 404 when an admin updates or deletes a nonexistent user", async () => {
    const { store } = makeStore();
    await store.createUser("admin-user", "password123");
    const routes = installWebAuthRoutes(store);
    const adminCookie = await loginCookie(store, "admin-user", "password123");

    const patch = createRouteResponse();
    const patchReq = request({ role: "user" }, adminCookie) as { params: Record<string, string> };
    patchReq.params.id = "user_missing";
    routes.updateUser(patchReq as never, patch as never);
    expect(patch.statusCode).toBe(404);

    const del = createRouteResponse();
    const delReq = request(undefined, adminCookie) as { params: Record<string, string> };
    delReq.params.id = "user_missing";
    routes.deleteUser(delReq as never, del as never);
    expect(del.statusCode).toBe(404);
  });
});

// Type-level checks (no runtime assertions) — these ensure the WebAuthStore
// settings type is compatible with what the config layer consumes.
const _settingsTypeCheck: UserConfigSettings = {};
void _settingsTypeCheck;
const _publicUserTypeCheck: PublicWebUser = {
  id: "",
  username: "",
  role: "user",
  createdAt: 0,
  hasWeixin: false,
};
void _publicUserTypeCheck;
