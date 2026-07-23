/**
 * QR rendering helper: generates codes locally (no third-party image service),
 * so the WeChat login URL never leaves the process and the result is a CSP-safe
 * `data:` URI for the browser.
 */

import { describe, it, expect } from "vitest";
import { renderQrSvg, renderQrSvgDataUri, renderQrTerminal } from "../src/utils/qr.js";

const DATA_URI_PREFIX = "data:image/svg+xml;base64,";

describe("utils/qr", () => {
  it("renders an inline SVG data: URI (CSP img-src 'self' data: safe)", () => {
    const uri = renderQrSvgDataUri("https://liteapp.weixin.qq.com/q/abc?qrcode=deadbeef");
    expect(uri.startsWith(DATA_URI_PREFIX)).toBe(true);
    const svg = Buffer.from(uri.slice(DATA_URI_PREFIX.length), "base64").toString("utf-8");
    expect(svg).toContain("<svg");
    expect(svg).toContain("<path");
  });

  it("never routes through a third-party QR image service", () => {
    const svg = renderQrSvg("secret-login-token");
    // The only URL allowed is the SVG XML namespace, which is an identifier, not
    // a fetch. No external QR/image service host may appear.
    expect(svg).not.toContain("qrserver");
    expect(svg).not.toContain("api.");
    expect(svg).not.toContain("secret-login-token"); // input is encoded, not embedded verbatim
  });

  it("actually encodes the input (different content -> different image)", () => {
    expect(renderQrSvgDataUri("AAAA")).not.toBe(renderQrSvgDataUri("BBBB"));
  });

  it("renders a terminal QR locally, not a link", () => {
    const term = renderQrTerminal("hello");
    expect(term.length).toBeGreaterThan(0);
    expect(term).not.toContain("qrserver");
    expect(term).not.toContain("http");
  });
});
