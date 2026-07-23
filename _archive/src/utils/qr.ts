/**
 * Local QR rendering.
 *
 * The WeChat login flow used to hand the login URL to api.qrserver.com to turn
 * it into an image. That both violated the web CSP (`img-src 'self' data:`) and
 * leaked a login credential to a third party. These helpers encode locally
 * (vendored Nayuki generator) so nothing leaves the process:
 *  - `renderQrSvgDataUri` for the browser (a CSP-safe `data:` URI),
 *  - `renderQrTerminal` for the CLI login flow.
 */

import { qrcodegen } from "../vendor/qrcodegen.js";

const { QrCode } = qrcodegen;

function encode(text: string) {
  // MEDIUM error correction is the QR default and stays scannable with the
  // typical partial occlusion of a phone screen.
  return QrCode.encodeText(text, QrCode.Ecc.MEDIUM);
}

/** Render `text` as a standalone SVG document string. `border` is the quiet zone in modules. */
export function renderQrSvg(text: string, border = 2): string {
  const qr = encode(text);
  const dim = qr.size + border * 2;
  const parts: string[] = [];
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.getModule(x, y)) {
        parts.push(`M${x + border} ${y + border}h1v1h-1z`);
      }
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">` +
    `<rect width="${dim}" height="${dim}" fill="#ffffff"/>` +
    `<path d="${parts.join("")}" fill="#000000"/>` +
    `</svg>`
  );
}

/** Render `text` as a base64 `data:image/svg+xml` URI (allowed by `img-src data:`). */
export function renderQrSvgDataUri(text: string): string {
  const svg = renderQrSvg(text);
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf-8").toString("base64")}`;
}

/**
 * Render `text` as a terminal-scannable QR. Uses ANSI background colours (black
 * modules on a white quiet zone) so it stays dark-on-light regardless of the
 * terminal theme — a phone can scan it directly from the console.
 */
export function renderQrTerminal(text: string, border = 2): string {
  const qr = encode(text);
  const size = qr.size;
  const light = "\x1b[47m  \x1b[0m"; // two spaces on a white background
  const dark = "\x1b[40m  \x1b[0m"; // two spaces on a black background
  const isDark = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < size && y < size && qr.getModule(x, y);

  const rows: string[] = [];
  for (let y = -border; y < size + border; y++) {
    let row = "";
    for (let x = -border; x < size + border; x++) {
      row += isDark(x, y) ? dark : light;
    }
    rows.push(row);
  }
  return rows.join("\n");
}
