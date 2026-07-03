import { describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "http";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { handleStaticRequest } from "../src/web/static.js";
import type { VexConfig } from "../src/types/index.js";

function createResponse(): ServerResponse & {
  statusCodeValue?: number;
  headers?: Record<string, unknown>;
  body?: unknown;
} {
  const response = {
    writeHead(statusCode: number, headers?: Record<string, unknown>) {
      this.statusCodeValue = statusCode;
      this.headers = headers;
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
});
