import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it, afterEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "http";
import {
  createWebUser,
  deleteWebUser,
  getUserConfigSettings,
  getRequestUser,
  installWebAuthRoutes,
  listWebUsers,
  loginWebUser,
  saveUserConfigSettings,
  saveUserWeixinLogin,
  setLoginCookie,
  updateWebUserRole,
} from "../src/web/auth.js";
import type { VexConfig } from "../src/types/index.js";

const tempDirs: string[] = [];

function config(): VexConfig {
  const dir = mkdtempSync(join(tmpdir(), "vex-web-auth-test-"));
  tempDirs.push(dir);
  return {
    providers: {},
    channels: {},
    agent: { defaultModel: "deepseek-chat", defaultProvider: "deepseek" },
    server: { port: 3000 },
    logging: { level: "info" },
    webAuth: { enabled: true, database: join(dir, "auth.sqlite") },
  };
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

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("web auth", () => {
  it("registers a user and resolves the login cookie from SQLite", () => {
    const cfg = config();
    createWebUser(cfg, "alice", "password123");
    const login = loginWebUser(cfg, "alice", "password123");
    const res = createResponse();
    setLoginCookie(res, login.session);

    const cookie = String(res.headers?.["Set-Cookie"]);
    const user = getRequestUser(cfg, { headers: { cookie } } as IncomingMessage);

    expect(user?.username).toBe("alice");
    expect(user?.role).toBe("admin");
    expect(user?.hasWeixin).toBe(false);
  });

  it("adds the Secure attribute to the session cookie only when requested", () => {
    const cfg = config();
    createWebUser(cfg, "alice", "password123");
    const login = loginWebUser(cfg, "alice", "password123");

    const plainRes = createResponse();
    setLoginCookie(plainRes, login.session);
    expect(String(plainRes.headers?.["Set-Cookie"])).not.toContain("Secure");

    const secureRes = createResponse();
    setLoginCookie(secureRes, login.session, true);
    const secureCookie = String(secureRes.headers?.["Set-Cookie"]);
    expect(secureCookie).toContain("Secure");
    expect(secureCookie).toContain("HttpOnly");
    expect(secureCookie).toContain("SameSite=Lax");
  });

  it("makes only the first registered user an admin", () => {
    const cfg = config();
    const first = createWebUser(cfg, "admin-user", "password123");
    const second = createWebUser(cfg, "normal-user", "password123");

    expect(first.role).toBe("admin");
    expect(second.role).toBe("user");
  });

  it("lets admins manage other accounts", () => {
    const cfg = config();
    const admin = createWebUser(cfg, "admin-user", "password123");
    const user = createWebUser(cfg, "normal-user", "password123");

    expect(listWebUsers(cfg, admin.id).map((item) => item.username)).toEqual(["admin-user", "normal-user"]);

    const promoted = updateWebUserRole(cfg, admin.id, user.id, "admin");
    expect(promoted.role).toBe("admin");

    deleteWebUser(cfg, admin.id, user.id);
    expect(listWebUsers(cfg, admin.id).map((item) => item.username)).toEqual(["admin-user"]);
  });

  it("does not let regular users manage accounts or admins delete themselves", () => {
    const cfg = config();
    const admin = createWebUser(cfg, "admin-user", "password123");
    const user = createWebUser(cfg, "normal-user", "password123");

    expect(() => listWebUsers(cfg, user.id)).toThrow("Admin privileges required");
    expect(() => deleteWebUser(cfg, admin.id, admin.id)).toThrow("Admins cannot delete their own account");
    expect(() => updateWebUserRole(cfg, admin.id, admin.id, "user")).toThrow("Admins cannot change their own role");
  });

  it("stores per-user Weixin login state", () => {
    const cfg = config();
    const user = createWebUser(cfg, "bob", "password123");
    const updated = saveUserWeixinLogin(cfg, user.id, {
      token: "wx-token",
      accountId: "wx-account",
      baseUrl: "https://example.com",
      userId: "ilink-user",
    });

    expect(updated.hasWeixin).toBe(true);
    expect(updated.weixinAccountId).toBe("wx-account");
  });

  it("stores config settings per user without sharing values", () => {
    const cfg = config();
    const first = createWebUser(cfg, "first-user", "password123");
    const second = createWebUser(cfg, "second-user", "password123");

    saveUserConfigSettings(cfg, first.id, {
      agent: {
        defaultProvider: "deepseek",
        defaultModel: "first-model",
        temperature: 0.2,
      },
      persona: { persona_name: "First" },
    });
    saveUserConfigSettings(cfg, second.id, {
      agent: {
        defaultProvider: "deepseek",
        defaultModel: "second-model",
        temperature: 0.8,
      },
      persona: { persona_name: "Second" },
    });

    expect(getUserConfigSettings(cfg, first.id)).toMatchObject({
      agent: { defaultModel: "first-model", temperature: 0.2 },
      persona: { persona_name: "First" },
    });
    expect(getUserConfigSettings(cfg, second.id)).toMatchObject({
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

  function request(body?: unknown, cookie?: string) {
    return { headers: cookie ? { cookie } : {}, body: body ?? {}, params: {} } as never;
  }

  function loginCookie(cfg: VexConfig, username: string, password: string): string {
    const login = loginWebUser(cfg, username, password);
    const res = createResponse();
    setLoginCookie(res, login.session);
    return String(res.headers?.["Set-Cookie"]);
  }

  it("allows registration only for the first account unless allowRegistration is set", () => {
    const cfg = config();
    const routes = installWebAuthRoutes(cfg);

    const bootstrap = createRouteResponse();
    routes.register(request({ username: "founder", password: "password123" }), bootstrap as never);
    expect(bootstrap.statusCode).toBe(200);

    const denied = createRouteResponse();
    routes.register(request({ username: "stranger", password: "password123" }), denied as never);
    expect(denied.statusCode).toBe(403);

    cfg.webAuth!.allowRegistration = true;
    const allowed = createRouteResponse();
    routes.register(request({ username: "invited", password: "password123" }), allowed as never);
    expect(allowed.statusCode).toBe(200);
  });

  it("lets admins create accounts without touching their own session", () => {
    const cfg = config();
    createWebUser(cfg, "admin-user", "password123");
    const routes = installWebAuthRoutes(cfg);
    const cookie = loginCookie(cfg, "admin-user", "password123");

    const res = createRouteResponse();
    routes.createUser(request({ username: "new-user", password: "password123" }, cookie), res as never);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ user: { username: "new-user", role: "user" } });
    // No login cookie for the created user — the admin stays logged in.
    expect(res.headers["Set-Cookie"]).toBeUndefined();
  });

  it("returns 403 for anonymous or non-admin createUser and 400 for bad input", () => {
    const cfg = config();
    createWebUser(cfg, "admin-user", "password123");
    createWebUser(cfg, "normal-user", "password123");
    const routes = installWebAuthRoutes(cfg);

    const anonymous = createRouteResponse();
    routes.createUser(request({ username: "x-user", password: "password123" }), anonymous as never);
    expect(anonymous.statusCode).toBe(403);

    const nonAdmin = createRouteResponse();
    const userCookie = loginCookie(cfg, "normal-user", "password123");
    routes.createUser(request({ username: "x-user", password: "password123" }, userCookie), nonAdmin as never);
    expect(nonAdmin.statusCode).toBe(403);

    const duplicate = createRouteResponse();
    const adminCookie = loginCookie(cfg, "admin-user", "password123");
    routes.createUser(request({ username: "normal-user", password: "password123" }, adminCookie), duplicate as never);
    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.body).toMatchObject({ error: "Username already exists" });
  });

  it("returns 403 (not 400) when a non-admin hits updateUser/deleteUser", () => {
    const cfg = config();
    const admin = createWebUser(cfg, "admin-user", "password123");
    createWebUser(cfg, "normal-user", "password123");
    const routes = installWebAuthRoutes(cfg);
    const userCookie = loginCookie(cfg, "normal-user", "password123");

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
});
