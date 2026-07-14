import { describe, it, expect } from "vitest";
import {
  parseAriaSnapshot,
  resolveRefLocatorSpec,
  browserLaunchArgs,
  assertNavigableUrl,
} from "../src/tools/builtin/browser.js";

describe("tools/builtin/browser pure helpers", () => {
  describe("resolveRefLocatorSpec", () => {
    it("resolves an e-ref to a role locator (not a bogus CSS selector)", () => {
      const refs = parseAriaSnapshot(['- button "Save"', '- link "Home"'].join("\n"));
      const spec = resolveRefLocatorSpec("e1", refs);
      expect(spec.kind).toBe("role");
      if (spec.kind === "role") {
        expect(spec.role).toBe("button");
        expect(spec.name).toBe("Save");
      }
    });

    it("disambiguates repeated role+name with nth", () => {
      const refs = parseAriaSnapshot(['- button "Add"', '- button "Add"'].join("\n"));
      const first = resolveRefLocatorSpec("e1", refs);
      const second = resolveRefLocatorSpec("e2", refs);
      expect(first.kind === "role" && first.nth).toBeUndefined();
      expect(second.kind === "role" && second.nth).toBe(1);
    });

    it("accepts @-prefixed and ref= forms", () => {
      const refs = parseAriaSnapshot(['- textbox "Email"'].join("\n"));
      expect(resolveRefLocatorSpec("@e1", refs).kind).toBe("role");
      expect(resolveRefLocatorSpec("ref=e1", refs).kind).toBe("role");
    });

    it("throws on an unknown e-ref", () => {
      const refs = parseAriaSnapshot(['- button "Save"'].join("\n"));
      expect(() => resolveRefLocatorSpec("e9", refs)).toThrow(/Unknown ref/);
    });

    it("falls back to CSS for non-ref selectors", () => {
      const refs = parseAriaSnapshot("");
      const spec = resolveRefLocatorSpec(".my-class", refs);
      expect(spec.kind).toBe("css");
      if (spec.kind === "css") expect(spec.selector).toBe(".my-class");
    });
  });

  describe("assertNavigableUrl", () => {
    it("rejects the cloud metadata address", () => {
      expect(() => assertNavigableUrl("http://169.254.169.254/latest/meta-data/", false)).toThrow();
    });
    it("rejects private addresses", () => {
      expect(() => assertNavigableUrl("http://127.0.0.1:8080/admin", false)).toThrow();
    });
    it("rejects non-http schemes", () => {
      expect(() => assertNavigableUrl("file:///etc/passwd", false)).toThrow();
    });
    it("allows a normal public URL", () => {
      expect(() => assertNavigableUrl("https://example.com/", false)).not.toThrow();
    });
    it("allows private addresses when explicitly permitted", () => {
      expect(() => assertNavigableUrl("http://127.0.0.1:8080/", true)).not.toThrow();
    });
  });

  describe("browserLaunchArgs", () => {
    it("does not disable the sandbox by default", () => {
      expect(browserLaunchArgs(false)).not.toContain("--no-sandbox");
    });
    it("disables the sandbox only when explicitly opted in", () => {
      const args = browserLaunchArgs(true);
      expect(args).toContain("--no-sandbox");
      expect(args).toContain("--disable-setuid-sandbox");
    });
  });
});
