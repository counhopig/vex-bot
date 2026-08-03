/**
 * Static asset service tests — handleStaticRequest.
 *
 * Ported from _archive/tests/static-assets.test.ts to the new architecture:
 * the archive's module-global getRequestUser/isWebAuthEnabled(config) helpers
 * are replaced by an injected WebAuthStore instance (principle #5), and
 * VexConfig is SystemConfig. Every security contract is preserved:
 *  - asset path traversal blocked (normalize + prefix check)
 *  - webAuth-enabled protected pages redirect to /login
 *  - /control served to admins only, redirected for non-admins
 *  - vendored marked.min.js served locally, never the jsdelivr CDN
 *  - config values HTML-escaped (no markup injection through model strings)
 *  - baseline security headers on HTML and asset responses
 */

import { describe, expect, it, afterEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "http";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Script } from "vm";
import { handleStaticRequest } from "../src/web/static/index.js";
import { CONTROL_CLIENT_JS, WEBCHAT_CLIENT_JS } from "../src/web/static/client.js";
import { I18N_CLIENT_JS } from "../src/web/static/i18n.js";
import type { SystemConfig } from "../src/web/routes/config.js";
import { WebAuthStore } from "../src/web/routes/auth.js";

const tempDirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "vex-static-assets-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createResponse(): ServerResponse & {
  statusCodeValue?: number;
  headers?: Record<string, unknown>;
  body?: unknown;
} {
  const response = {
    headers: {} as Record<string, unknown>,
    statusCodeValue: undefined as number | undefined,
    body: undefined as unknown,
    writeHead(statusCode: number, headers?: Record<string, unknown>) {
      this.statusCodeValue = statusCode;
      this.headers = { ...this.headers, ...headers };
      return this;
    },
    setHeader(name: string, value: unknown) {
      this.headers[name] = value;
      return this;
    },
    end(body?: unknown) {
      this.body = body;
      return this;
    },
  };
  return response as unknown as ServerResponse & {
    statusCodeValue?: number;
    headers?: Record<string, unknown>;
    body?: unknown;
  };
}

function makeAuth(enabled: boolean): WebAuthStore {
  return new WebAuthStore({
    dbPath: join(tmpDir(), "auth.sqlite"),
    enabled,
    allowRegistration: true,
  });
}

const openConfig: SystemConfig = { webAuth: { enabled: false } };

function serve(url: string, config: SystemConfig, auth?: WebAuthStore, cookie?: string) {
  const res = createResponse();
  const handled = handleStaticRequest(
    { url, headers: cookie ? { cookie } : {} } as IncomingMessage,
    res,
    { config, auth: auth ?? makeAuth(false) },
  );
  return { res, handled };
}

describe("static web assets", () => {
  it("ships syntactically valid inline browser scripts", () => {
    expect(() => new Script(I18N_CLIENT_JS + CONTROL_CLIENT_JS)).not.toThrow();
    expect(() => new Script(
      I18N_CLIENT_JS + WEBCHAT_CLIENT_JS.replace("${MASCOT_AVATAR_HTML}", '<img src="/assets/vex-mascot.png">'),
    )).not.toThrow();
  });

  it("serves the generated Vex mascot image", () => {
    const { res, handled } = serve("/assets/vex-mascot.png", openConfig);
    expect(handled).toBe(true);
    expect(res.statusCodeValue).toBe(200);
    expect(res.headers?.["Content-Type"]).toBe("image/png");
    expect(Buffer.isBuffer(res.body)).toBe(true);
  });

  it("blocks asset path traversal", () => {
    const { res, handled } = serve("/assets/../static.ts", openConfig);
    expect(handled).toBe(true);
    expect(res.statusCodeValue).toBe(403);
  });

  it("redirects protected pages to login when web auth is enabled", () => {
    const res = createResponse();
    const handled = handleStaticRequest(
      { url: "/control", headers: {} } as IncomingMessage,
      res,
      { config: openConfig, auth: makeAuth(true) },
    );
    expect(handled).toBe(true);
    expect(res.statusCodeValue).toBe(302);
    expect(res.headers?.Location).toBe("/login?next=%2Fcontrol");
  });

  it("serves marked locally and never references the jsdelivr CDN", () => {
    const { res } = serve("/", { ...openConfig, agent: { defaultModel: "m", defaultProvider: "deepseek" } });
    const html = String(res.body);
    expect(html).toContain("/assets/marked.min.js");
    expect(html).toContain('rel="icon"');
    expect(html).toContain('script data-cfasync="false"');
    expect(html).not.toContain("cdn.jsdelivr.net");
  });

  it("serves the vendored marked asset as JavaScript", () => {
    const { res, handled } = serve("/assets/marked.min.js", openConfig);
    expect(handled).toBe(true);
    expect(res.statusCodeValue).toBe(200);
    expect(String(res.headers?.["Content-Type"])).toContain("javascript");
  });

  it("HTML-escapes config values so a crafted model string can't inject markup", () => {
    const evil = "</div><script>alert(1)</script>";
    const { res } = serve("/", { ...openConfig, agent: { defaultModel: evil, defaultProvider: "deepseek" } });
    const html = String(res.body);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("sets baseline security headers on HTML and asset responses", () => {
    const page = serve("/", { ...openConfig, agent: { defaultModel: "m", defaultProvider: "deepseek" } });
    expect(page.res.headers?.["X-Content-Type-Options"]).toBe("nosniff");
    expect(page.res.headers?.["X-Frame-Options"]).toBe("DENY");
    expect(String(page.res.headers?.["Content-Security-Policy"])).toContain("default-src 'self'");

    const asset = serve("/assets/marked.min.js", openConfig);
    expect(asset.res.headers?.["X-Content-Type-Options"]).toBe("nosniff");
  });

  it("serves /control to admins but redirects non-admins away", async () => {
    const auth = makeAuth(true);
    await auth.createUser("admin", "password123"); // first user => admin
    await auth.createUser("normal", "password123");
    const config: SystemConfig = { ...openConfig, agent: { defaultModel: "m", defaultProvider: "deepseek" } };

    const adminSession = await auth.login("admin", "password123");
    const adminRes = createResponse();
    const adminHandled = handleStaticRequest(
      { url: "/control", headers: { cookie: `vexsid=${adminSession.session.id}` } } as IncomingMessage,
      adminRes,
      { config, auth },
    );
    expect(adminHandled).toBe(true);
    expect(adminRes.statusCodeValue).toBe(200);
    const controlHtml = String(adminRes.body);
    expect(controlHtml).toContain("Console");
    expect(controlHtml).toContain('"Users": "用户"');
    expect(controlHtml).toContain("Console Connection");
    expect(controlHtml).not.toContain("Received WebSocket message:");
    expect(controlHtml).toContain('class="settings-workspace"');
    expect(controlHtml).toContain('data-settings-target="tab-agent"');
    expect(controlHtml).toContain("Save Changes");
    expect(controlHtml).not.toContain('id="view-config"');
    expect(controlHtml).not.toContain('id="config-save-btn"');

    const normalSession = await auth.login("normal", "password123");
    const normalRes = createResponse();
    handleStaticRequest(
      { url: "/control", headers: { cookie: `vexsid=${normalSession.session.id}` } } as IncomingMessage,
      normalRes,
      { config, auth },
    );
    expect(normalRes.statusCodeValue).toBe(302);
    expect(normalRes.headers?.Location).toBe("/");
  });
});
