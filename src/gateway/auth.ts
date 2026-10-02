import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { isIP } from "node:net";

export const COOKIE_NAME = "vex_auth";

export function isLoopback(host: string): boolean {
  const value = host.trim();
  if (value === "::1") return true;

  let hostname: string;
  const ipv6 = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (ipv6) {
    hostname = ipv6[1]!;
    return hostname === "::1" && isIP(hostname) === 6;
  } else {
    const authority = /^([^:]+)(?::\d+)?$/.exec(value);
    if (!authority) return false;
    hostname = authority[1]!;
  }

  if (hostname.toLowerCase() === "localhost") return true;
  if (isIP(hostname) !== 4) return false;
  return Number(hostname.split(".")[0]) === 127;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }
  return cookies;
}

export class WebAuth {
  constructor(private readonly token: string | undefined) {}

  get required(): boolean {
    return this.token !== undefined;
  }

  checkToken(candidate: string): boolean {
    return this.token === undefined || safeEqual(candidate, this.token);
  }

  isAuthorized(cookieHeader: string | undefined): boolean {
    if (this.token === undefined) return true;
    const value = parseCookies(cookieHeader)[COOKIE_NAME];
    return value !== undefined && safeEqual(value, this.cookieValue());
  }

  setCookieHeader(): string {
    return `${COOKIE_NAME}=${this.cookieValue()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`;
  }

  private cookieValue(): string {
    return createHmac("sha256", this.token ?? "").update("vex-web-auth").digest("hex");
  }
}

function safeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}
