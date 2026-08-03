/**
 * WS method handler tests — status.get / session.info / config.*
 *
 * Pure handler factories injected into WebChatChannel.handlers. WebAuthStore
 * is a structural mock (only isEnabled/getUserConfigSettings/
 * saveUserConfigSettings are used); config save writes to a real temp YAML
 * file so the single-user vs per-user persistence paths are exercised for
 * real. Covers: status mapping + per-user weixin channel, session.info
 * passthrough, config.get system-vs-user resolution, config.validate,
 * config.save single-user vs multi-user (non-admin/admin).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createAdminHandlers, type AdminHandlersOptions } from "../src/web/routes/admin.js";
import type { WsClientView } from "../src/channels/webchat/WebChatChannel.js";
import type { WebAuthStore } from "../src/web/routes/auth.js";

const tempDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vex-admin-routes-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function makeView(overrides?: Partial<WsClientView>): WsClientView {
  return {
    id: "client-1",
    user: null,
    sessionKey: null,
    sessionId: null,
    sendEvent: () => {},
    onDisconnect: () => {},
    ...overrides,
  };
}

function makeUser(id: string, role: "admin" | "user" = "user"): WsClientView["user"] {
  return { id, username: `user-${id}`, role, createdAt: 1, hasWeixin: false };
}

/** Minimal WebAuthStore structural mock. */
function makeAuth(overrides?: {
  enabled?: boolean;
  settings?: Record<string, Record<string, unknown>>;
}): {
  isEnabled: boolean;
  getUserConfigSettings: ReturnType<typeof vi.fn>;
  saveUserConfigSettings: ReturnType<typeof vi.fn>;
} {
  const settings = overrides?.settings ?? {};
  return {
    isEnabled: overrides?.enabled ?? true,
    getUserConfigSettings: vi.fn((userId: string) => settings[userId] ?? {}),
    saveUserConfigSettings: vi.fn((userId: string, patch: Record<string, unknown>) => patch),
  } as unknown as {
    isEnabled: boolean;
    getUserConfigSettings: ReturnType<typeof vi.fn>;
    saveUserConfigSettings: ReturnType<typeof vi.fn>;
  };
}

function makeOptions(overrides?: Partial<AdminHandlersOptions>): AdminHandlersOptions {
  return {
    version: "1.15.0",
    getConfig: () => ({ agent: { defaultProvider: "deepseek", defaultModel: "deepseek-chat" } }),
    configPath: path.join(tmpDir(), "config.local.yaml"),
    auth: makeAuth() as unknown as WebAuthStore,
    getProviders: () => [{ id: "deepseek", name: "DeepSeek", available: true }],
    getChannels: () => [{ id: "webchat", name: "webchat", connected: true }],
    getUptimeMs: () => 1234,
    getClientCount: () => 2,
    ...overrides,
  };
}

describe("status.get", () => {
  it("maps providers/channels/uptime/sessions", () => {
    const handlers = createAdminHandlers(makeOptions());
    const result = handlers["status.get"](makeView(), {}) as {
      version: string;
      defaultProvider: string;
      defaultModel: string;
      uptime: number;
      providers: Array<{ id: string; name: string; available: boolean }>;
      channels: Array<{ id: string; name: string; connected: boolean }>;
      sessions: number;
    };
    expect(result.version).toBe("1.15.0");
    expect(result.defaultProvider).toBe("deepseek");
    expect(result.defaultModel).toBe("deepseek-chat");
    expect(result.uptime).toBe(1234);
    expect(result.providers).toEqual([{ id: "deepseek", name: "DeepSeek", available: true }]);
    expect(result.channels).toEqual([{ id: "webchat", name: "webchat", connected: true }]);
    expect(result.sessions).toBe(2);
  });

  it("appends the per-user weixin channel when configured", () => {
    const handlers = createAdminHandlers(
      makeOptions({
        getUserWeixinStatus: (userId) => ({ configured: true, connected: true, accountId: "acc-1" }),
      }),
    );
    const result = handlers["status.get"](makeView({ user: makeUser("u1") }), {}) as {
      channels: Array<{ id: string; name: string; connected: boolean }>;
    };
    expect(result.channels).toContainEqual({
      id: "weixin",
      name: "Personal WeChat",
      connected: true,
    });
  });

  it("does not append weixin when the user has no configured channel", () => {
    const handlers = createAdminHandlers(
      makeOptions({
        getUserWeixinStatus: (userId) => ({ configured: false, connected: false }),
      }),
    );
    const result = handlers["status.get"](makeView({ user: makeUser("u1") }), {}) as {
      channels: Array<{ id: string }>;
    };
    expect(result.channels.some((c) => c.id === "weixin")).toBe(false);
  });
});

describe("session.info", () => {
  it("returns sessionKey/sessionId with injected info spread in", async () => {
    const handlers = createAdminHandlers(
      makeOptions({
        getSessionInfo: () => ({ messageCount: 3, estimatedTokens: 100 }),
      }),
    );
    const result = (await handlers["session.info"](
      makeView({ sessionKey: "webchat:u1:s1", sessionId: "sid-1" }),
      {},
    )) as { sessionKey: string; sessionId: string; messageCount: number };
    expect(result.sessionKey).toBe("webchat:u1:s1");
    expect(result.sessionId).toBe("sid-1");
    expect(result.messageCount).toBe(3);
  });

  it("returns only sessionKey/sessionId when no getSessionInfo is provided", async () => {
    const handlers = createAdminHandlers(makeOptions());
    const result = (await handlers["session.info"](
      makeView({ sessionKey: "webchat:u1:s1", sessionId: "sid-1" }),
      {},
    )) as { sessionKey: string; sessionId: string };
    expect(result).toEqual({ sessionKey: "webchat:u1:s1", sessionId: "sid-1" });
  });
});

describe("config.get", () => {
  it("returns the system config for a client in single-user mode", () => {
    const options = makeOptions();
    (options.auth as { isEnabled: boolean }).isEnabled = false;
    const handlers = createAdminHandlers(options);
    const result = handlers["config.get"](makeView({ user: null }), {}) as {
      agent: { defaultProvider: string };
    };
    expect(result.agent.defaultProvider).toBe("deepseek");
  });

  it("returns the system config for an unauthenticated client", () => {
    const handlers = createAdminHandlers(makeOptions());
    const result = handlers["config.get"](makeView(), {}) as { agent: { defaultProvider: string } };
    expect(result.agent.defaultProvider).toBe("deepseek");
  });

  it("merges user settings for an authenticated user in multi-user mode", () => {
    const options = makeOptions({
      getConfig: () => ({
        agent: { defaultProvider: "deepseek", temperature: 0.7 },
      }),
    });
    (options.auth as unknown as { getUserConfigSettings: ReturnType<typeof vi.fn> }).getUserConfigSettings.mockReturnValue({
      agent: { temperature: 0.9 },
    });
    const handlers = createAdminHandlers(options);
    const result = handlers["config.get"](makeView({ user: makeUser("u1") }), {}) as {
      agent: { defaultProvider: string; temperature?: number };
    };
    expect(result.agent.temperature).toBe(0.9);
    expect(result.agent.defaultProvider).toBe("deepseek");
  });
});

describe("config.validate", () => {
  it("returns valid for a well-formed params", () => {
    const handlers = createAdminHandlers(makeOptions());
    const result = handlers["config.validate"](makeView(), {
      agent: { defaultProvider: "deepseek" },
    }) as { valid: boolean; errors: string[] };
    expect(result.valid).toBe(true);
  });

  it("returns errors for an invalid provider", () => {
    const handlers = createAdminHandlers(makeOptions());
    const result = handlers["config.validate"](makeView(), {
      agent: { defaultProvider: "not-a-provider" },
    }) as { valid: boolean; errors: string[] };
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Invalid provider"))).toBe(true);
  });
});

describe("config.save", () => {
  it("single-user mode writes the system config file", async () => {
    const configPath = path.join(tmpDir(), "config.local.yaml");
    const options = makeOptions({ configPath });
    (options.auth as { isEnabled: boolean }).isEnabled = false;
    const handlers = createAdminHandlers(options);

    const result = (await handlers["config.save"](makeView({ user: null }), {
      server: { port: 4000 },
    })) as { success: boolean; message: string };
    expect(result.success).toBe(true);
    expect(fs.existsSync(configPath)).toBe(true);
    const written = fs.readFileSync(configPath, "utf-8");
    expect(written).toContain("port: 4000");
  });

  it("multi-user non-admin persists user settings only and never writes the system file", async () => {
    const configPath = path.join(tmpDir(), "config.local.yaml");
    const auth = makeAuth();
    const handlers = createAdminHandlers({
      ...makeOptions({ configPath }),
      auth: auth as unknown as WebAuthStore,
    });

    const result = (await handlers["config.save"](makeView({ user: makeUser("u1") }), {
      agent: { temperature: 0.9 },
    })) as { success: boolean; message: string };
    expect(result.success).toBe(true);
    expect(result.message).toBe("User settings saved");
    expect(auth.saveUserConfigSettings).toHaveBeenCalledWith("u1", { agent: { temperature: 0.9 } });
    expect(fs.existsSync(configPath)).toBe(false); // system config untouched
  });

  it("multi-user admin persists user settings AND system config", async () => {
    const configPath = path.join(tmpDir(), "config.local.yaml");
    const auth = makeAuth();
    const handlers = createAdminHandlers({
      ...makeOptions({ configPath }),
      auth: auth as unknown as WebAuthStore,
    });

    const result = (await handlers["config.save"](makeView({ user: makeUser("a1", "admin") }), {
      agent: { temperature: 0.9 },
      server: { port: 5000 },
    })) as { success: boolean; message: string };
    expect(result.success).toBe(true);
    expect(result.message).toBe("User settings and system config saved");
    expect(auth.saveUserConfigSettings).toHaveBeenCalledWith("a1", { agent: { temperature: 0.9 } });
    expect(fs.existsSync(configPath)).toBe(true);
    const written = fs.readFileSync(configPath, "utf-8");
    expect(written).toContain("port: 5000");
  });

  it("multi-user non-admin cannot persist system-level params via channels", async () => {
    const configPath = path.join(tmpDir(), "config.local.yaml");
    const auth = makeAuth();
    const handlers = createAdminHandlers({
      ...makeOptions({ configPath }),
      auth: auth as unknown as WebAuthStore,
    });

    const result = (await handlers["config.save"](makeView({ user: makeUser("u1") }), {
      channels: { weixin: { hasConfig: true, enabled: true } },
    })) as { success: boolean; message: string };
    expect(result.success).toBe(true);
    expect(result.message).toBe("User settings saved");
    expect(fs.existsSync(configPath)).toBe(false); // channel change ignored for non-admin
  });

  it("returns validation failure for invalid params without touching disk", async () => {
    const configPath = path.join(tmpDir(), "config.local.yaml");
    const handlers = createAdminHandlers(makeOptions({ configPath }));

    const result = (await handlers["config.save"](makeView({ user: makeUser("a1", "admin") }), {
      agent: { defaultProvider: "not-a-provider" },
    })) as { success: boolean; message: string };
    expect(result.success).toBe(false);
    expect(result.message).toContain("Config validation failed");
    expect(fs.existsSync(configPath)).toBe(false);
  });
});
