/**
 * Web tool tests — isBlockedAddress, assertWebFetchUrlAllowed, web_search, web_fetch.
 *
 * SSRF protection preserved from _archive/src/tools/builtin/web.ts.
 */

import { describe, it, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// SSRF: isBlockedAddress
// ---------------------------------------------------------------------------

describe("isBlockedAddress", () => {
  let isBlockedAddress: (ip: string) => boolean;

  beforeAll(async () => {
    ({ isBlockedAddress } = await import("../src/tools/builtin/web.js"));
  });

  // Private IPv4
  it("blocks 127.0.0.1 (loopback)", () => {
    expect(isBlockedAddress("127.0.0.1")).toBe(true);
  });

  it("blocks 10.0.0.1 (private)", () => {
    expect(isBlockedAddress("10.0.0.1")).toBe(true);
  });

  it("blocks 192.168.1.1 (private)", () => {
    expect(isBlockedAddress("192.168.1.1")).toBe(true);
  });

  it("blocks 172.16.0.1 (private)", () => {
    expect(isBlockedAddress("172.16.0.1")).toBe(true);
  });

  it("blocks 172.31.255.254 (private)", () => {
    expect(isBlockedAddress("172.31.255.254")).toBe(true);
  });

  it("blocks 169.254.169.254 (link-local / cloud metadata)", () => {
    expect(isBlockedAddress("169.254.169.254")).toBe(true);
  });

  it("blocks 100.64.0.1 (CGNAT)", () => {
    expect(isBlockedAddress("100.64.0.1")).toBe(true);
  });

  it("blocks 0.0.0.0 (this network)", () => {
    expect(isBlockedAddress("0.0.0.0")).toBe(true);
  });

  it("blocks multicast (224.0.0.1)", () => {
    expect(isBlockedAddress("224.0.0.1")).toBe(true);
  });

  // Public IPv4
  it("allows 8.8.8.8 (public)", () => {
    expect(isBlockedAddress("8.8.8.8")).toBe(false);
  });

  it("allows 1.1.1.1 (public)", () => {
    expect(isBlockedAddress("1.1.1.1")).toBe(false);
  });

  // IPv6
  it("blocks ::1 (IPv6 loopback)", () => {
    expect(isBlockedAddress("::1")).toBe(true);
  });

  it("blocks fe80::1 (IPv6 link-local)", () => {
    expect(isBlockedAddress("fe80::1")).toBe(true);
  });

  it("blocks fc00::1 (IPv6 ULA)", () => {
    expect(isBlockedAddress("fc00::1")).toBe(true);
  });

  it("blocks fd00::1 (IPv6 ULA)", () => {
    expect(isBlockedAddress("fd00::1")).toBe(true);
  });

  it("blocks ::ffff:127.0.0.1 (IPv4-mapped IPv6 loopback)", () => {
    expect(isBlockedAddress("::ffff:127.0.0.1")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SSRF: assertWebFetchUrlAllowed
// ---------------------------------------------------------------------------

describe("assertWebFetchUrlAllowed", () => {
  let assertWebFetchUrlAllowed: (url: URL, allowPrivate: boolean) => void;

  beforeAll(async () => {
    ({ assertWebFetchUrlAllowed } = await import("../src/tools/builtin/web.js"));
  });

  it("rejects non-http(s) schemes", () => {
    expect(() => assertWebFetchUrlAllowed(new URL("file:///etc/passwd"), false)).toThrow(
      "Unsupported URL scheme",
    );
  });

  it("rejects ftp scheme", () => {
    expect(() => assertWebFetchUrlAllowed(new URL("ftp://example.com"), false)).toThrow(
      "Unsupported URL scheme",
    );
  });

  it("allows https when allowPrivate is true", () => {
    expect(() =>
      assertWebFetchUrlAllowed(new URL("https://127.0.0.1/test"), true),
    ).not.toThrow();
  });

  it("rejects private IP when allowPrivate is false", () => {
    expect(() =>
      assertWebFetchUrlAllowed(new URL("http://10.0.0.1/admin"), false),
    ).toThrow("Blocked request to private/reserved address");
  });

  it("rejects metadata host when allowPrivate is false", () => {
    expect(() =>
      assertWebFetchUrlAllowed(
        new URL("http://metadata.google.internal/"),
        false,
      ),
    ).toThrow("Blocked request to metadata host");
  });
});

// ---------------------------------------------------------------------------
// Web fetch tool (smoke test — actual HTTP calls tested via integration)
// ---------------------------------------------------------------------------

describe("createWebFetchTool", () => {
  let createWebFetchTool: () => any;

  beforeAll(async () => {
    ({ createWebFetchTool } = await import("../src/tools/builtin/web.js"));
  });

  it("has correct metadata", () => {
    const tool = createWebFetchTool();
    expect(tool.name).toBe("web_fetch");
    expect(tool.label).toBe("Web Fetch");
  });

  it("rejects unparseable URL", async () => {
    const tool = createWebFetchTool();
    const result = await tool.execute("call-1", { url: "not a url" });
    expect(result.isError).toBe(true);
    expect(result.details.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Web search tool (smoke test)
// ---------------------------------------------------------------------------

describe("createWebSearchTool", () => {
  let createWebSearchTool: () => any;

  beforeAll(async () => {
    ({ createWebSearchTool } = await import("../src/tools/builtin/web.js"));
  });

  it("has correct metadata", () => {
    const tool = createWebSearchTool();
    expect(tool.name).toBe("web_search");
    expect(tool.label).toBe("Web Search");
  });

  it("returns missing_api_key when no BRAVE_API_KEY set", async () => {
    const prev = process.env.BRAVE_API_KEY;
    delete process.env.BRAVE_API_KEY;
    try {
      const tool = createWebSearchTool();
      const result = await tool.execute("call-1", { query: "test" });
      expect(result.details.error).toBe("missing_api_key");
    } finally {
      if (prev) process.env.BRAVE_API_KEY = prev;
    }
  });
});
