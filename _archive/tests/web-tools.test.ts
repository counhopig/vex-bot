import { describe, it, expect, vi } from "vitest";

vi.mock("../src/utils/logger.js", () => ({
  getChildLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { isBlockedAddress, assertWebFetchUrlAllowed, createWebFetchTool } from "../src/tools/builtin/web.js";

describe("isBlockedAddress", () => {
  it("blocks loopback, private, link-local and metadata ranges", () => {
    for (const ip of ["127.0.0.1", "10.0.0.5", "172.16.0.1", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1"]) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
    expect(isBlockedAddress("::1")).toBe(true);
    expect(isBlockedAddress("fd00::1")).toBe(true);
    expect(isBlockedAddress("fe80::1")).toBe(true);
    expect(isBlockedAddress("::ffff:127.0.0.1")).toBe(true); // IPv4-mapped loopback
  });

  it("allows public addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34"]) {
      expect(isBlockedAddress(ip)).toBe(false);
    }
    expect(isBlockedAddress("2606:4700:4700::1111")).toBe(false);
  });
});

describe("assertWebFetchUrlAllowed", () => {
  it("rejects non-http(s) schemes", () => {
    expect(() => assertWebFetchUrlAllowed(new URL("file:///etc/passwd"), false)).toThrow(/scheme/i);
    expect(() => assertWebFetchUrlAllowed(new URL("ftp://example.com/x"), false)).toThrow(/scheme/i);
  });

  it("rejects private/metadata IP-literal hosts", () => {
    expect(() => assertWebFetchUrlAllowed(new URL("http://169.254.169.254/latest/meta-data/"), false)).toThrow(/blocked/i);
    expect(() => assertWebFetchUrlAllowed(new URL("http://127.0.0.1:8080/"), false)).toThrow(/blocked/i);
    expect(() => assertWebFetchUrlAllowed(new URL("http://[::1]/"), false)).toThrow(/blocked/i);
  });

  it("rejects known metadata hostnames", () => {
    expect(() => assertWebFetchUrlAllowed(new URL("http://metadata.google.internal/"), false)).toThrow(/blocked/i);
  });

  it("allows public URLs", () => {
    expect(() => assertWebFetchUrlAllowed(new URL("https://example.com/page"), false)).not.toThrow();
    expect(() => assertWebFetchUrlAllowed(new URL("http://8.8.8.8/"), false)).not.toThrow();
  });

  it("permits everything (except scheme) when allowPrivate is set", () => {
    expect(() => assertWebFetchUrlAllowed(new URL("http://127.0.0.1/"), true)).not.toThrow();
    expect(() => assertWebFetchUrlAllowed(new URL("file:///etc/passwd"), true)).toThrow(/scheme/i);
  });
});

describe("web_fetch tool", () => {
  it("returns an SSRF error for a metadata URL without hitting the network", async () => {
    const tool = createWebFetchTool();
    const result = await tool.execute("c", { url: "http://169.254.169.254/latest/meta-data/iam/" }, undefined);
    expect(result.isError).toBe(true);
    const text = result.content.map((c) => c.text ?? "").join("");
    expect(text.toLowerCase()).toMatch(/blocked|denied|private/);
  });

  it("blocks a hostname that resolves to a private address (connect-time guard)", async () => {
    const tool = createWebFetchTool();
    // localhost -> 127.0.0.1: rejected by the DNS lookup guard, no connection made.
    const result = await tool.execute("c", { url: "http://localhost:9/" }, undefined);
    expect(result.isError).toBe(true);
    const text = result.content.map((c) => c.text ?? "").join("");
    expect(text.toLowerCase()).toMatch(/blocked|private|reserved/);
  }, 10000);
});
