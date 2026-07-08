import { describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "http";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { handleStaticRequest } from "../src/web/static.js";
import { createWebUser, loginWebUser, setLoginCookie } from "../src/web/auth.js";
import type { VexConfig } from "../src/types/index.js";

function createResponse(): ServerResponse & {
  statusCodeValue?: number;
  headers?: Record<string, unknown>;
  body?: unknown;
} {
  const response = {
    headers: {} as Record<string, unknown>,
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
  return response as ServerResponse & {
    statusCodeValue?: number;
    headers?: Record<string, unknown>;
    body?: unknown;
  };
}

describe("static web assets", () => {
  it("serves the generated Vex mascot image", () => {
    const res = createResponse();
    const handled = handleStaticRequest(
      { url: "/assets/vex-mascot.png" } as IncomingMessage,
      res,
      { config: {} as VexConfig }
    );

    expect(handled).toBe(true);
    expect(res.statusCodeValue).toBe(200);
    expect(res.headers?.["Content-Type"]).toBe("image/png");
    expect(Buffer.isBuffer(res.body)).toBe(true);
  });

  it("blocks asset path traversal", () => {
    const res = createResponse();
    const handled = handleStaticRequest(
      { url: "/assets/../static.ts" } as IncomingMessage,
      res,
      { config: {} as VexConfig }
    );

    expect(handled).toBe(true);
    expect(res.statusCodeValue).toBe(403);
  });

  it("redirects protected pages to login when web auth is enabled", () => {
    const dir = mkdtempSync(join(tmpdir(), "vex-static-auth-test-"));
    const res = createResponse();
    try {
      const handled = handleStaticRequest(
        { url: "/control", headers: {} } as IncomingMessage,
        res,
        {
          config: {
            webAuth: { enabled: true, database: join(dir, "auth.sqlite") },
          } as VexConfig,
        }
      );

      expect(handled).toBe(true);
      expect(res.statusCodeValue).toBe(302);
      expect(res.headers?.Location).toBe("/login?next=%2Fcontrol");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const openConfig = { webAuth: { enabled: false } } as VexConfig;

  function serve(url: string, config: VexConfig, cookie?: string) {
    const res = createResponse();
    const handled = handleStaticRequest(
      { url, headers: cookie ? { cookie } : {} } as IncomingMessage,
      res,
      { config },
    );
    return { res, handled };
  }

  it("serves marked locally and never references the jsdelivr CDN", () => {
    const { res } = serve("/", { ...openConfig, agent: { defaultModel: "m", defaultProvider: "deepseek" } } as VexConfig);
    const html = String(res.body);
    expect(html).toContain("/assets/marked.min.js");
    expect(html).not.toContain("cdn.jsdelivr.net");
  });

  it("serves the vendored marked asset as JavaScript", () => {
    const { res, handled } = serve("/assets/marked.min.js", {} as VexConfig);
    expect(handled).toBe(true);
    expect(res.statusCodeValue).toBe(200);
    expect(String(res.headers?.["Content-Type"])).toContain("javascript");
  });

  it("HTML-escapes config values so a crafted model string can't inject markup", () => {
    const evil = "</div><script>alert(1)</script>";
    const { res } = serve("/", { ...openConfig, agent: { defaultModel: evil, defaultProvider: "deepseek" } } as VexConfig);
    const html = String(res.body);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("sets baseline security headers on HTML and asset responses", () => {
    const page = serve("/", { ...openConfig, agent: { defaultModel: "m", defaultProvider: "deepseek" } } as VexConfig);
    expect(page.res.headers?.["X-Content-Type-Options"]).toBe("nosniff");
    expect(page.res.headers?.["X-Frame-Options"]).toBe("DENY");
    expect(String(page.res.headers?.["Content-Security-Policy"])).toContain("default-src 'self'");

    const asset = serve("/assets/marked.min.js", {} as VexConfig);
    expect(asset.res.headers?.["X-Content-Type-Options"]).toBe("nosniff");
  });

  it("serves /control to admins but redirects non-admins away", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vex-static-control-test-"));
    try {
      const config = {
        webAuth: { enabled: true, database: join(dir, "auth.sqlite") },
        agent: { defaultModel: "m", defaultProvider: "deepseek" },
      } as VexConfig;
      const admin = await createWebUser(config, "admin", "password123"); // first user => admin
      await createWebUser(config, "normal", "password123");

      const cookieFor = async (username: string) => {
        const login = await loginWebUser(config, username, "password123");
        const res = createResponse();
        setLoginCookie(res, login.session);
        return String(res.headers?.["Set-Cookie"]).split(";")[0];
      };
      expect(admin.role).toBe("admin");

      const asAdmin = serve("/control", config, await cookieFor("admin"));
      expect(asAdmin.res.statusCodeValue).toBe(200);
      expect(String(asAdmin.res.headers?.["Content-Type"])).toContain("text/html");

      const asUser = serve("/control", config, await cookieFor("normal"));
      expect(asUser.res.statusCodeValue).toBe(302);
      expect(asUser.res.headers?.Location).toBe("/");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
