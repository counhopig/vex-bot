/**
 * ToolRegistry tests — class-based (not process-global) registry.
 *
 * Verifies:
 *   - register / get / getAll / registerTools / clear
 *   - filterByPolicy (allow, deny, group expansion, wildcard matching)
 *   - independent instances (no cross-contamination)
 *   - duplicate registration overwrites
 */

import { describe, it, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stubTool(name: string, label?: string) {
  return {
    name,
    label: label ?? name,
    description: `${name} description`,
    parameters: {} as any,
    execute: vi.fn().mockResolvedValue({ content: [], details: {} }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ToolRegistry", () => {
  let ToolRegistry: typeof import("../src/tools/ToolRegistry.js").ToolRegistry;

  beforeAll(async () => {
    ({ ToolRegistry } = await import("../src/tools/ToolRegistry.js"));
  });

  describe("register and get", () => {
    it("registers a tool and retrieves it by name", () => {
      const registry = new ToolRegistry();
      const tool = stubTool("web_search");
      registry.register(tool);
      expect(registry.get("web_search")).toBe(tool);
    });

    it("retrieves case-insensitively", () => {
      const registry = new ToolRegistry();
      const tool = stubTool("Web_Search");
      registry.register(tool);
      expect(registry.get("web_search")).toBe(tool);
      expect(registry.get("WEB_SEARCH")).toBe(tool);
    });

    it("returns undefined for unknown tool", () => {
      const registry = new ToolRegistry();
      expect(registry.get("nonexistent")).toBeUndefined();
    });

    it("overwrites on duplicate name", () => {
      const registry = new ToolRegistry();
      const a = stubTool("bash", "Bash A");
      const b = stubTool("bash", "Bash B");
      registry.register(a);
      registry.register(b);
      expect(registry.get("bash")?.label).toBe("Bash B");
    });
  });

  describe("registerTools", () => {
    it("batch registers multiple tools", () => {
      const registry = new ToolRegistry();
      const a = stubTool("tool_a");
      const b = stubTool("tool_b");
      registry.registerTools([a, b]);
      expect(registry.get("tool_a")).toBe(a);
      expect(registry.get("tool_b")).toBe(b);
    });
  });

  describe("getAll", () => {
    it("returns all registered tools", () => {
      const registry = new ToolRegistry();
      const a = stubTool("a");
      const b = stubTool("b");
      registry.registerTools([a, b]);
      const all = registry.getAll();
      expect(all).toHaveLength(2);
      expect(all).toContain(a);
      expect(all).toContain(b);
    });

    it("returns empty when nothing registered", () => {
      const registry = new ToolRegistry();
      expect(registry.getAll()).toEqual([]);
    });
  });

  describe("clear", () => {
    it("empties the registry", () => {
      const registry = new ToolRegistry();
      registry.register(stubTool("test"));
      registry.clear();
      expect(registry.getAll()).toEqual([]);
    });
  });

  describe("independent instances", () => {
    it("does not leak tools between instances", () => {
      const r1 = new ToolRegistry();
      const r2 = new ToolRegistry();
      r1.register(stubTool("only_r1"));
      r2.register(stubTool("only_r2"));
      expect(r1.get("only_r2")).toBeUndefined();
      expect(r2.get("only_r1")).toBeUndefined();
    });
  });

  describe("filterByPolicy", () => {
    it("returns all tools when no policy", () => {
      const registry = new ToolRegistry();
      registry.registerTools([stubTool("web_search"), stubTool("web_fetch"), stubTool("bash")]);
      const filtered = registry.filterByPolicy();
      expect(filtered).toHaveLength(3);
    });

    it("returns only allow-listed tools (explicit names)", () => {
      const registry = new ToolRegistry();
      const search = stubTool("web_search");
      const fetch = stubTool("web_fetch");
      const bash = stubTool("bash");
      registry.registerTools([search, fetch, bash]);

      const filtered = registry.filterByPolicy({ allow: ["web_search"] });
      expect(filtered).toHaveLength(1);
      expect(filtered[0]).toBe(search);
    });

    it("expands group: prefixes in allow list", () => {
      const registry = new ToolRegistry();
      const search = stubTool("web_search");
      const fetch = stubTool("web_fetch");
      const weather = stubTool("weather");
      registry.registerTools([search, fetch, weather]);

      const filtered = registry.filterByPolicy({ allow: ["group:web"] });
      // group:web expands to web_search, web_fetch, weather
      expect(filtered).toHaveLength(3);
    });

    it("returns empty when allow list matches nothing", () => {
      const registry = new ToolRegistry();
      registry.register(stubTool("bash"));
      const filtered = registry.filterByPolicy({ allow: ["web_search"] });
      expect(filtered).toEqual([]);
    });

    it("excludes deny-listed tools", () => {
      const registry = new ToolRegistry();
      const search = stubTool("web_search");
      const fetch = stubTool("web_fetch");
      registry.registerTools([search, fetch]);

      const filtered = registry.filterByPolicy({ deny: ["web_search"] });
      expect(filtered).toHaveLength(1);
      expect(filtered[0]).toBe(fetch);
    });

    it("expands group: prefixes in deny list", () => {
      const registry = new ToolRegistry();
      const search = stubTool("web_search");
      const fetch = stubTool("web_fetch");
      const weather = stubTool("weather");
      const bash = stubTool("bash");
      registry.registerTools([search, fetch, weather, bash]);

      const filtered = registry.filterByPolicy({ deny: ["group:web"] });
      expect(filtered).toHaveLength(1);
      expect(filtered[0]).toBe(bash);
    });

    it("deny wins over allow for overlapping patterns", () => {
      const registry = new ToolRegistry();
      registry.register(stubTool("web_search"));

      // Deny web_search but allow * — deny wins (deny checked first in archive logic)
      const filtered = registry.filterByPolicy({
        deny: ["web_search"],
        allow: ["*"],
      });
      expect(filtered).toEqual([]);
    });

    it("deny list takes priority over allow list for the SAME tool", () => {
      const registry = new ToolRegistry();
      registry.register(stubTool("web_search"));

      // Allow web_search, but also deny web_search — deny wins
      const filtered = registry.filterByPolicy({
        allow: ["web_search"],
        deny: ["web_search"],
      });
      expect(filtered).toEqual([]);
    });

    it("matches wildcard *", () => {
      const registry = new ToolRegistry();
      registry.registerTools([stubTool("bash"), stubTool("web_search")]);

      const filtered = registry.filterByPolicy({ allow: ["*"] });
      expect(filtered).toHaveLength(2);
    });

    it("matches wildcard prefix", () => {
      const registry = new ToolRegistry();
      registry.registerTools([
        stubTool("web_search"),
        stubTool("web_fetch"),
        stubTool("bash"),
      ]);

      const filtered = registry.filterByPolicy({ allow: ["web_*"] });
      expect(filtered).toHaveLength(2);
    });

    it("is case-insensitive for tool names", () => {
      const registry = new ToolRegistry();
      const search = stubTool("Web_Search");
      registry.register(search);

      const filtered = registry.filterByPolicy({ allow: ["web_search"] });
      expect(filtered).toHaveLength(1);
    });
  });
});
