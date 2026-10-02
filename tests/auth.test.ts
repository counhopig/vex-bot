import { describe, expect, it } from "vitest";
import { COOKIE_NAME, isLoopback, parseCookies, WebAuth } from "../src/gateway/auth.js";

describe("isLoopback", () => {
  it("recognizes local addresses", () => {
    expect(["127.0.0.1", "127.0.0.2", "::1", "localhost"].every(isLoopback)).toBe(true);
    expect(["0.0.0.0", "192.168.1.2", "::"].some(isLoopback)).toBe(false);
  });

  it("parses loopback Host authorities and rejects lookalikes", () => {
    expect(["localhost:3000", "127.255.1.2:80", "[::1]:443"].every(isLoopback)).toBe(true);
    expect(["127.evil", "127.0.0.1.evil", "localhost.evil", "[::2]:80", "127.1", "localhost/path"].some(isLoopback)).toBe(false);
  });
});

describe("parseCookies", () => {
  it("parses pairs and tolerates bad encoding", () => {
    expect(parseCookies("a=1; b=x%20y; bad=%E0%A4%A; flag")).toEqual({ a: "1", b: "x y", bad: "%E0%A4%A" });
    expect(parseCookies(undefined)).toEqual({});
  });
});

describe("WebAuth", () => {
  it("requires nothing without a token", () => {
    const auth = new WebAuth(undefined);
    expect(auth.required).toBe(false);
    expect(auth.isAuthorized(undefined)).toBe(true);
  });

  it("checks the token and the cookie it issues", () => {
    const auth = new WebAuth("secret");
    expect(auth.required).toBe(true);
    expect(auth.checkToken("secret")).toBe(true);
    expect(auth.checkToken("Secret")).toBe(false);
    const header = auth.setCookieHeader();
    expect(header).toMatch(new RegExp(`^${COOKIE_NAME}=[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000$`));
    const cookie = header.split(";")[0]!;
    expect(auth.isAuthorized(cookie)).toBe(true);
    expect(auth.isAuthorized(`${COOKIE_NAME}=forged`)).toBe(false);
    expect(new WebAuth("other").isAuthorized(cookie)).toBe(false);
  });
});
