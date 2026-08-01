/**
 * Plugin loader — enable-state resolution + dependency order + module import.
 *
 * Source-of-truth invariants:
 *  - resolveEnableState runs through (in order) global enabled, deny,
 *    allow, per-entry enabled, exclusive-slot match, then default.
 *    The per-entry `enabled: true` is checked BEFORE the slot check
 *    so an operator can force a specific plugin on without touching
 *    the slot assignment. This is the rule the archive pinned with the
 *    "deliberate" comment.
 *  - sortByDependencies does a topological pass: dependencies load
 *    before their dependents. The visited Set guards against cycles.
 *  - loadPlugins + activateAllPlugins operate on an injected per-call
 *    `registry` Map — no module-level plugin state.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

vi.mock("../src/utils/logger.js", () => ({
  getChildLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  resolveEnableState,
  sortByDependencies,
  loadPlugins,
  activateAllPlugins,
  loadPluginModule,
  moduleToDefinition,
} from "../src/plugins/loader.js";
import type {
  LoadedPlugin,
  PluginCandidate,
  PluginEnableConfig,
} from "../src/plugins/types.js";
import type { EffectiveConfig } from "../src/config/EffectiveConfig.js";
import { ToolRegistry } from "../src/tools/ToolRegistry.js";
import { EventBus } from "../src/hooks/EventBus.js";

function candidate(overrides: Partial<PluginCandidate>): PluginCandidate {
  return {
    id: "plug",
    origin: "workspace",
    entryPath: "/tmp/plug/index.js",
    directory: "/tmp/plug",
    ...overrides,
  };
}

function emptyDeps() {
  return {
    toolRegistry: new ToolRegistry(),
    eventBus: new EventBus(),
    config: {} as EffectiveConfig,
    getStateDir: (id: string) => `/tmp/states/${id}`,
  };
}

describe("plugins/loader", () => {
  describe("resolveEnableState", () => {
    it("defaults to enabled when no enableConfig is given", () => {
      const result = resolveEnableState(candidate({}), undefined);
      expect(result).toEqual({ enabled: true, reason: "default" });
    });

    it("globally disabled beats everything else", () => {
      const result = resolveEnableState(
        candidate({}),
        { enabled: false, allow: ["plug"] },
      );
      expect(result.enabled).toBe(false);
      expect(result.reason).toBe("globally disabled");
    });

    it("deny beats allow", () => {
      const result = resolveEnableState(
        candidate({}),
        { allow: ["plug"], deny: ["plug"] },
      );
      expect(result.enabled).toBe(false);
      expect(result.reason).toBe("in deny list");
    });

    it("allow list with no match disables the plugin", () => {
      const result = resolveEnableState(
        candidate({ id: "x" }),
        { allow: ["y"] },
      );
      expect(result.enabled).toBe(false);
      expect(result.reason).toBe("not in allow list");
    });

    it("explicit per-entry enabled:false wins over default", () => {
      const result = resolveEnableState(
        candidate({}),
        { entries: { plug: { enabled: false } } },
      );
      expect(result.enabled).toBe(false);
      expect(result.reason).toBe("explicitly disabled");
    });

    it("explicit per-entry enabled:true wins over slot mismatch", () => {
      const result = resolveEnableState(
        candidate({ id: "x", manifest: { id: "x", kind: "memory" } }),
        {
          slots: { memory: "y" },
          entries: { x: { enabled: true } },
        },
      );
      expect(result.enabled).toBe(true);
      expect(result.reason).toBe("explicitly enabled");
    });

    it("exclusive slot disables candidates when another plugin holds the slot", () => {
      const result = resolveEnableState(
        candidate({ id: "x", manifest: { id: "x", kind: "memory" } }),
        { slots: { memory: "y" } },
      );
      expect(result.enabled).toBe(false);
      expect(result.reason).toContain('slot "memory" assigned to "y"');
    });

    it("bundled origin defaults to enabled with bundled reason", () => {
      const result = resolveEnableState(
        candidate({ origin: "bundled" }),
        {},
      );
      expect(result.enabled).toBe(true);
      expect(result.reason).toBe("bundled default");
    });

    it("non-bundled origin defaults to enabled with default reason", () => {
      const result = resolveEnableState(
        candidate({ origin: "workspace" }),
        {},
      );
      expect(result.enabled).toBe(true);
      expect(result.reason).toBe("default");
    });
  });

  describe("sortByDependencies", () => {
    it("orders dependencies before dependents", () => {
      const a = candidate({ id: "a", manifest: { id: "a", dependencies: ["b"] } });
      const b = candidate({ id: "b" });
      const c = candidate({ id: "c", manifest: { id: "c", dependencies: ["a"] } });
      const sorted = sortByDependencies([c, a, b]);
      expect(sorted.map((s) => s.id)).toEqual(["b", "a", "c"]);
    });

    it("ignores missing dependency ids", () => {
      const a = candidate({ id: "a", manifest: { id: "a", dependencies: ["missing"] } });
      const sorted = sortByDependencies([a]);
      expect(sorted.map((s) => s.id)).toEqual(["a"]);
    });

    it("handles a cyclic dependency without infinite recursion", () => {
      const a = candidate({ id: "a", manifest: { id: "a", dependencies: ["b"] } });
      const b = candidate({ id: "b", manifest: { id: "b", dependencies: ["a"] } });
      const sorted = sortByDependencies([a, b]);
      expect(sorted.map((s) => s.id).sort()).toEqual(["a", "b"]);
    });
  });

  describe("loadPluginModule + moduleToDefinition", () => {
    let dir = "";

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "vex-plugin-loader-"));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("loads a function-style module and turns it into a definition", async () => {
      const entry = join(dir, "fn.js");
      writeFileSync(
        entry,
        "module.exports = (api) => { api.id; };\n",
      );
      const mod = await loadPluginModule(candidate({ entryPath: entry }));
      expect(mod).not.toBeNull();
      const def = moduleToDefinition(mod!, candidate({ id: "fn" }));
      expect(typeof def.register).toBe("function");
      expect(def.meta.id).toBe("fn");
    });

    it("loads a definition-style module", async () => {
      const entry = join(dir, "def.js");
      writeFileSync(
        entry,
        "module.exports = { meta: { id: 'def', name: 'Def', version: '1.0.0' } };\n",
      );
      const mod = await loadPluginModule(candidate({ entryPath: entry }));
      expect(mod).not.toBeNull();
      const def = moduleToDefinition(mod!, candidate({ id: "def" }));
      expect(def.meta.name).toBe("Def");
    });

    it("returns null for an invalid module", async () => {
      const entry = join(dir, "bad.js");
      writeFileSync(entry, "module.exports = 42;\n");
      const mod = await loadPluginModule(candidate({ entryPath: entry }));
      expect(mod).toBeNull();
    });

    it("returns null for a module that throws on import", async () => {
      const entry = join(dir, "throws.js");
      writeFileSync(
        entry,
        "throw new Error('intentional');\n",
      );
      const mod = await loadPluginModule(
        candidate({ entryPath: entry }),
      );
      expect(mod).toBeNull();
    });

    it("moduleToDefinition fills in manifest fields when module is a function", () => {
      const def = moduleToDefinition(
        () => {},
        candidate({
          id: "alpha",
          manifest: { id: "alpha", name: "Alpha", version: "9.9.9" },
        }),
      );
      expect(def.meta).toEqual({
        id: "alpha",
        name: "Alpha",
        version: "9.9.9",
        description: undefined,
        author: undefined,
        kind: undefined,
      });
    });
  });

  describe("loadPlugins / activateAllPlugins", () => {
    let dir = "";

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "vex-plugin-runner-"));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("registers a plugin and reports it as loaded", async () => {
      const entry = join(dir, "a.js");
      writeFileSync(
        entry,
        "module.exports = { meta: { id: 'a', name: 'A', version: '1.0.0' }, register: () => {} };\n",
      );
      const registry = new Map<string, LoadedPlugin>();
      const result = await loadPlugins(
        [candidate({ id: "a", entryPath: entry, origin: "config" })],
        emptyDeps(),
        registry,
      );
      expect(result.loaded).toEqual(["a"]);
      expect(result.failed).toEqual([]);
      expect(registry.has("a")).toBe(true);
      expect(registry.get("a")!.activated).toBe(false);
    });

    it("skips a plugin when resolveEnableState says so", async () => {
      const entry = join(dir, "skipped.js");
      writeFileSync(
        entry,
        "module.exports = { meta: { id: 'skipped', name: 'S', version: '1.0.0' } };\n",
      );
      const registry = new Map<string, LoadedPlugin>();
      const enable: PluginEnableConfig = { deny: ["skipped"] };
      const result = await loadPlugins(
        [candidate({ id: "skipped", entryPath: entry, origin: "config" })],
        { ...emptyDeps(), enableConfig: enable },
        registry,
      );
      expect(result.loaded).toEqual([]);
      expect(result.skipped).toEqual([
        { id: "skipped", reason: "in deny list" },
      ]);
      expect(registry.size).toBe(0);
    });

    it("reports a failed module load without throwing", async () => {
      const entry = join(dir, "broken.js");
      writeFileSync(entry, "throw new Error('boom');\n");
      const registry = new Map<string, LoadedPlugin>();
      const result = await loadPlugins(
        [candidate({ id: "broken", entryPath: entry, origin: "config" })],
        emptyDeps(),
        registry,
      );
      expect(result.loaded).toEqual([]);
      expect(result.failed).toEqual([
        { id: "broken", error: "Failed to load module" },
      ]);
    });

    it("activateAllPlugins starts queued services and marks activated", async () => {
      const entry = join(dir, "svc.js");
      writeFileSync(
        entry,
        [
          "module.exports = {",
          "  meta: { id: 'svc', name: 'S', version: '1.0.0' },",
          "  register: (api) => { api.registerService({ id: 'task', start: () => {}, stop: () => {} }); },",
          "  activate: () => {},",
          "};",
        ].join("\n"),
      );
      const registry = new Map<string, LoadedPlugin>();
      await loadPlugins(
        [candidate({ id: "svc", entryPath: entry, origin: "config" })],
        emptyDeps(),
        registry,
      );
      const start = vi.fn();
      registry.get("svc")!.services.push({
        id: "late-svc",
        start,
        stop: () => {},
      });
      const result = await activateAllPlugins(registry, emptyDeps());
      expect(result.activated).toEqual(["svc"]);
      expect(result.failed).toEqual([]);
      expect(start).toHaveBeenCalledTimes(1);
      expect(registry.get("svc")!.activated).toBe(true);
    });

    it("plugin registers a tool with the injected ToolRegistry, not a global", async () => {
      // Place the fixture inside the project so `require('@sinclair/typebox')`
      // resolves against this repo's node_modules. The loader's
      // `await import` resolves the specifier via the importing module's
      // resolution chain, but the imported file's own CommonJS `require`
      // still searches from its own directory.
      const fixtureDir = join(process.cwd(), "tests", "fixtures", "plugins");
      mkdirSync(fixtureDir, { recursive: true });
      const entry = join(fixtureDir, "tool-fixture.js");
      writeFileSync(
        entry,
        [
          "const { Type } = require('@sinclair/typebox');",
          "module.exports = {",
          "  meta: { id: 'tool', name: 'T', version: '1.0.0' },",
          "  register: (api) => api.registerTool({",
          "    name: 'hello',",
          "    description: 'say hi',",
          "    parameters: Type.Object({}),",
          "    execute: async () => ({ content: [{ type: 'text', text: 'hi' }] }),",
          "  }),",
          "};",
        ].join("\n"),
      );
      try {
        const deps = emptyDeps();
        const registry = new Map<string, LoadedPlugin>();
        await loadPlugins(
          [candidate({ id: "tool", entryPath: entry, origin: "config" })],
          deps,
          registry,
        );
        expect(deps.toolRegistry.get("hello")).toBeDefined();
      } finally {
        rmSync(fixtureDir, { recursive: true, force: true });
      }
    });
  });
});
