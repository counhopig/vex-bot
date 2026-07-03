import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it, afterEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "http";
import {
  createWebUser,
  getRequestUser,
  loginWebUser,
  saveUserWeixinLogin,
  setLoginCookie,
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
    expect(user?.hasWeixin).toBe(false);
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
});
