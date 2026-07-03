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
