/**
 * Plugin service — orchestrator that ties discovery + loader + activate
 * together for a single (user, channel) runtime.
 *
 * Source-of-truth invariants:
 *  - One PluginService instance = one runtime. Multiple instances can
 *    coexist (per Web user); they do NOT share state.
 *  - registerPlugin adds to the service's own registry, not a module
 *    global. The same id registered in two services lives in two
 *    registries.
 *  - unregisterPlugin stops services in REVERSE order, copies the
 *    services list so the caller's view isn't mutated, fires
 *    unsubscribers, and runs the plugin's cleanup. Idempotent on
 *    missing ids.
 *  - shutdown drops everything; the service can be re-initialized
 *    afterwards.
 *  - definePlugin / defineToolPlugin are pure factory helpers that
 *    produce PluginDefinition values; they do not register.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Type } from "@sinclair/typebox";

vi.mock("../src/utils/logger.js", () => ({
  getChildLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { PluginService } from "../src/plugins/service.js";
import {
  definePlugin,
  defineToolPlugin,
} from "../src/plugins/index.js";
import type {
  LoadedPlugin,
  PluginCandidate,
  PluginDefinition,
  PluginMeta,
} from "../src/plugins/types.js";
import type { EffectiveConfig } from "../src/config/EffectiveConfig.js";
import { ToolRegistry } from "../src/tools/ToolRegistry.js";
import { EventBus } from "../src/hooks/EventBus.js";
import type { Tool } from "../src/tools/types.js";

function fixture(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "vex-plugin-svc-"));
  const entry = join(dir, "p.js");
  writeFileSync(entry, text);
  return entry;
}

function baseDeps() {
  return {
    toolRegistry: new ToolRegistry(),
    eventBus: new EventBus(),
    config: {} as EffectiveConfig,
    getStateDir: (id: string) => `/tmp/states/${id}`,
  };
}

describe("plugins/service", () => {
  let dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs = [];
  });

  function track(dir: string): string {
    dirs.push(dir);
    return dir;
  }

  describe("registerPlugin", () => {
    it("registers a plugin in the service's own registry", () => {
      const svc = new PluginService(baseDeps());
      const def: PluginDefinition = {
        meta: { id: "p1", name: "P1", version: "1.0.0" },
      };
      svc.registerPlugin(def, "config");
      expect(svc.isLoaded("p1")).toBe(true);
      expect(svc.get("p1")?.origin).toBe("config");
    });

    it("skips duplicate ids without overwriting the existing entry", () => {
      const svc = new PluginService(baseDeps());
      const a: PluginDefinition = {
        meta: { id: "p1", name: "First", version: "1.0.0" },
      };
      const b: PluginDefinition = {
        meta: { id: "p1", name: "Second", version: "2.0.0" },
      };
      svc.registerPlugin(a, "workspace");
      svc.registerPlugin(b, "config");
      expect(svc.get("p1")?.origin).toBe("workspace");
      expect(svc.get("p1")?.definition.meta.name).toBe("First");
    });

    it("invokes the register callback with the same api handle activate will see", () => {
      const svc = new PluginService(baseDeps());
      const cfg = { agent: { defaultModel: "marker" } } as EffectiveConfig;
      let registerCfg: unknown;
      let activateCfg: unknown;
      svc.registerPlugin(
        {
          meta: { id: "cfg", name: "C", version: "1.0.0" },
          register: (api) => {
            registerCfg = api.config;
          },
          activate: (api) => {
            activateCfg = api.config;
          },
        },
        "config",
        { config: cfg },
      );
      svc.activateAll();
      expect(registerCfg).toBe(cfg);
      expect(activateCfg).toBe(cfg);
    });
  });

  describe("activateAll", () => {
    it("starts services queued in register, and activates the plugin", async () => {
      const svc = new PluginService(baseDeps());
      const start = vi.fn();
      svc.registerPlugin(
        {
          meta: { id: "svc", name: "S", version: "1.0.0" },
          register: (api) => {
            api.registerService({ id: "task", start, stop: vi.fn() });
          },
        },
        "config",
      );
      const result = await svc.activateAll();
      expect(result.activated).toEqual(["svc"]);
      expect(svc.isActivated("svc")).toBe(true);
      expect(start).toHaveBeenCalledTimes(1);
    });

    it("starts a service registered during activate", async () => {
      const svc = new PluginService(baseDeps());
      const start = vi.fn();
      svc.registerPlugin(
        {
          meta: { id: "late", name: "L", version: "1.0.0" },
          activate: (api) => {
            api.registerService({ id: "late-svc", start, stop: vi.fn() });
          },
        },
        "config",
      );
      await svc.activateAll();
      expect(start).toHaveBeenCalledTimes(1);
    });
  });

  describe("loadFromCandidates", () => {
    let dir = "";

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "vex-plugin-candidates-"));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    function candidateFor(entryPath: string, id: string): PluginCandidate {
      return { id, origin: "config", entryPath, directory: dir };
    }

    it("loads filesystem candidates into the service's own registry and exposes their tools", async () => {
      const entry = join(dir, "plug.js");
      writeFileSync(
        entry,
        [
          "module.exports = {",
          "  meta: { id: 'plug', name: 'Plug', version: '1.0.0' },",
          "  register: (api) => api.registerTool({",
          "    name: 'plug-tool',",
          "    description: 'from plugin',",
          "    parameters: { type: 'object', properties: {} },",
          "    execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),",
          "  }),",
          "};",
        ].join("\n"),
      );
      const deps = baseDeps();
      const svc = new PluginService(deps);

      const result = await svc.loadFromCandidates([candidateFor(entry, "plug")]);

      expect(result.loaded).toEqual(["plug"]);
      expect(result.failed).toEqual([]);
      expect(svc.isLoaded("plug")).toBe(true);
      expect(deps.toolRegistry.get("plug-tool")).toBeDefined();
    });

    it("reports broken modules as failed without throwing", async () => {
      const entry = join(dir, "broken.js");
      writeFileSync(entry, "throw new Error('boom');\n");
      const svc = new PluginService(baseDeps());

      const result = await svc.loadFromCandidates([candidateFor(entry, "broken")]);

      expect(result.loaded).toEqual([]);
      expect(result.failed).toEqual([
        { id: "broken", error: "Failed to load module" },
      ]);
      expect(svc.isLoaded("broken")).toBe(false);
    });

    it("lets the caller activate the loaded plugins afterwards", async () => {
      const entry = join(dir, "svc.js");
      writeFileSync(
        entry,
        [
          "module.exports = {",
          "  meta: { id: 'svc', name: 'Svc', version: '1.0.0' },",
          "  activate: () => {},",
          "};",
        ].join("\n"),
      );
      const svc = new PluginService(baseDeps());
      await svc.loadFromCandidates([candidateFor(entry, "svc")]);

      const result = await svc.activateAll();

      expect(result.activated).toEqual(["svc"]);
      expect(svc.isActivated("svc")).toBe(true);
    });
  });

  describe("unregisterPlugin", () => {
    it("stops services in reverse order without mutating the caller's list", async () => {
      const svc = new PluginService(baseDeps());
      const order: string[] = [];
      let servicesRef: Array<{ id: string }> = [];
      svc.registerPlugin(
        {
          meta: { id: "rev", name: "R", version: "1.0.0" },
          register: (api) => {
            api.registerService({
              id: "s1",
              start: vi.fn(),
              stop: () => {
                order.push("s1");
              },
            });
            api.registerService({
              id: "s2",
              start: vi.fn(),
              stop: () => {
                order.push("s2");
              },
            });
          },
        },
        "config",
      );
      servicesRef = svc.get("rev")!.services;
      await svc.unregisterPlugin("rev");
      expect(order).toEqual(["s2", "s1"]);
      // The list the caller captured should be unchanged in shape
      // (reverse iteration must not splice).
      expect(servicesRef.map((s) => s.id)).toEqual(["s1", "s2"]);
    });

    it("runs the plugin's cleanup function", async () => {
      const svc = new PluginService(baseDeps());
      const cleanup = vi.fn();
      svc.registerPlugin(
        {
          meta: { id: "c", name: "C", version: "1.0.0" },
          cleanup,
        },
        "config",
      );
      await svc.unregisterPlugin("c");
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(svc.isLoaded("c")).toBe(false);
    });

    it("unsubscribes all hooks the plugin registered", () => {
      const deps = baseDeps();
      const unsubscribe = vi.fn();
      deps.eventBus.subscribe = vi.fn(() => unsubscribe) as typeof deps.eventBus.subscribe;
      const svc = new PluginService(deps);
      svc.registerPlugin(
        {
          meta: { id: "h", name: "H", version: "1.0.0" },
          register: (api) => {
            api.registerHook("message_received", () => {});
          },
        },
        "config",
      );
      svc.unregisterPlugin("h");
      expect(unsubscribe).toHaveBeenCalled();
    });

    it("is a no-op for an unknown id", async () => {
      const svc = new PluginService(baseDeps());
      await expect(svc.unregisterPlugin("never")).resolves.toBeUndefined();
    });
  });

  describe("isolation between service instances", () => {
    it("two PluginService instances do not share state", () => {
      const a = new PluginService(baseDeps());
      const b = new PluginService(baseDeps());
      a.registerPlugin({ meta: { id: "x", name: "X", version: "1.0.0" } }, "config");
      expect(a.isLoaded("x")).toBe(true);
      expect(b.isLoaded("x")).toBe(false);
    });

    it("plugin A's tool registration does not leak into plugin B's tool registry", () => {
      const depsA = baseDeps();
      const depsB = baseDeps();
      const svcA = new PluginService(depsA);
      const svcB = new PluginService(depsB);
      const toolA: Tool = {
        name: "a-tool",
        description: "A",
        parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: "text", text: "a" }] }),
      };
      svcA.registerPlugin(
        {
          meta: { id: "p-a", name: "PA", version: "1.0.0" },
          register: (api) => api.registerTool(toolA),
        },
        "config",
      );
      expect(depsA.toolRegistry.get("a-tool")).toBeDefined();
      expect(depsB.toolRegistry.get("a-tool")).toBeUndefined();
    });
  });

  describe("list / get / isLoaded / isActivated", () => {
    it("list returns meta in insertion order", () => {
      const svc = new PluginService(baseDeps());
      svc.registerPlugin({ meta: { id: "1", name: "1", version: "0" } }, "config");
      svc.registerPlugin({ meta: { id: "2", name: "2", version: "0" } }, "config");
      const list = svc.list();
      expect(list.map((m) => m.id)).toEqual(["1", "2"]);
    });

    it("isLoaded / isActivated are consistent with the registry", async () => {
      const svc = new PluginService(baseDeps());
      expect(svc.isLoaded("x")).toBe(false);
      expect(svc.isActivated("x")).toBe(false);
      svc.registerPlugin(
        { meta: { id: "x", name: "X", version: "1.0.0" } },
        "config",
      );
      expect(svc.isLoaded("x")).toBe(true);
      expect(svc.isActivated("x")).toBe(false);
      await svc.activateAll();
      expect(svc.isActivated("x")).toBe(true);
    });
  });

  describe("shutdown", () => {
    it("drops every plugin and clears the registry", async () => {
      const svc = new PluginService(baseDeps());
      const cleanup = vi.fn();
      svc.registerPlugin(
        {
          meta: { id: "x", name: "X", version: "1.0.0" },
          cleanup,
        },
        "config",
      );
      await svc.shutdown();
      expect(svc.isLoaded("x")).toBe(false);
      expect(cleanup).toHaveBeenCalledTimes(1);
    });
  });

  describe("definePlugin + defineToolPlugin", () => {
    it("definePlugin wraps init as register", () => {
      const init = vi.fn();
      const def = definePlugin({ id: "d", name: "D", version: "1.0.0" }, init);
      expect(def.meta.id).toBe("d");
      expect(def.register).toBe(init);
    });

    it("defineToolPlugin produces a plugin that registers the given tools", () => {
      const tools: Tool[] = [
        {
          name: "x",
          description: "X",
          parameters: Type.Object({}),
          execute: async () => ({ content: [{ type: "text", text: "x" }] }),
        },
      ];
      const def = defineToolPlugin({ id: "tp", name: "TP", version: "1.0.0" }, tools);
      expect(def.meta.id).toBe("tp");
      expect(typeof def.register).toBe("function");
    });
  });
});
