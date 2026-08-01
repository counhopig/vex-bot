/**
 * Plugin discovery — 3-tier filesystem scan (bundled / global / workspace)
 * with override-priority and ts-gating.
 *
 * Source-of-truth invariants:
 *  - bundled < global < workspace < extra `paths`. Later wins for the same id.
 *  - A directory with `vex.plugin.json` and a `main` is preferred.
 *  - A directory with `package.json["vex.plugin"]` is the fallback entry hint.
 *  - A directory with `index.ts` / `index.js` / `plugin.ts` / `plugin.js` is
 *    the last-resort default.
 *  - `.ts` entries are only picked up when the runtime can import TypeScript
 *    (tsx / vitest), not in the compiled `dist/` runtime.
 *  - Malformed manifests are skipped with a warn, not a throw.
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

import { discoverPlugins, getDefaultSearchDirs } from "../src/plugins/discovery.js";

describe("plugins/discovery", () => {
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vex-plugin-disc-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("getDefaultSearchDirs", () => {
    it("returns the 3-tier default directory map", () => {
      const dirs = getDefaultSearchDirs();
      expect(Object.keys(dirs).sort()).toEqual(["bundled", "global", "workspace"]);
      expect(typeof dirs.bundled).toBe("string");
      expect(typeof dirs.global).toBe("string");
      expect(typeof dirs.workspace).toBe("string");
    });
  });

  describe("discoverPlugins", () => {
    it("returns an empty list when no paths exist and all defaults are off", async () => {
      const candidates = await discoverPlugins({
        paths: [],
        includeBuiltin: false,
        includeGlobal: false,
        includeWorkspace: false,
        allowTsEntries: true,
      });
      expect(candidates).toEqual([]);
    });

    it("finds a directory plugin via vex.plugin.json with main entry", async () => {
      const pluginDir = join(dir, "alpha");
      mkdirSync(pluginDir, { recursive: true });
      mkdirSync(join(pluginDir, "dist"), { recursive: true });
      writeFileSync(
        join(pluginDir, "vex.plugin.json"),
        JSON.stringify({ id: "alpha", name: "Alpha", version: "1.0.0", main: "dist/index.js" }),
      );
      writeFileSync(join(pluginDir, "dist", "index.js"), "module.exports = {};");
      // mkdir parent directories don't auto-create; create dist explicitly.
      // (mkdirSync recursive was used above for the dist subdir.)
      const candidates = await discoverPlugins({
        paths: [dir],
        includeBuiltin: false,
        includeGlobal: false,
        includeWorkspace: false,
        allowTsEntries: false,
      });
      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.id).toBe("alpha");
      expect(candidates[0]?.origin).toBe("config");
      expect(candidates[0]?.entryPath).toBe(join(pluginDir, "dist", "index.js"));
      expect(candidates[0]?.manifest?.name).toBe("Alpha");
    });

    it("falls back to package.json vex.plugin field when no manifest", async () => {
      const pluginDir = join(dir, "beta");
      mkdirSync(pluginDir);
      writeFileSync(
        join(pluginDir, "package.json"),
        JSON.stringify({ name: "beta", version: "2.0.0", main: "index.js", "vex.plugin": "beta.js" }),
      );
      writeFileSync(join(pluginDir, "beta.js"), "module.exports = {};");
      const candidates = await discoverPlugins({
        paths: [dir],
        includeBuiltin: false,
        includeGlobal: false,
        includeWorkspace: false,
        allowTsEntries: false,
      });
      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.id).toBe("beta");
      expect(candidates[0]?.entryPath).toBe(join(pluginDir, "beta.js"));
    });

    it("uses default index.js when no manifest and no package.json hint", async () => {
      const pluginDir = join(dir, "gamma");
      mkdirSync(pluginDir);
      writeFileSync(join(pluginDir, "index.js"), "module.exports = {};");
      const candidates = await discoverPlugins({
        paths: [dir],
        includeBuiltin: false,
        includeGlobal: false,
        includeWorkspace: false,
        allowTsEntries: false,
      });
      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.id).toBe("gamma");
      expect(candidates[0]?.entryPath).toBe(join(pluginDir, "index.js"));
    });

    it("finds single-file plugins at the top of the search path", async () => {
      writeFileSync(join(dir, "solo.js"), "module.exports = {};");
      const candidates = await discoverPlugins({
        paths: [dir],
        includeBuiltin: false,
        includeGlobal: false,
        includeWorkspace: false,
        allowTsEntries: false,
      });
      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.id).toBe("solo");
      expect(candidates[0]?.entryPath).toBe(join(dir, "solo.js"));
    });

    it("later tiers override earlier tiers for the same plugin id", async () => {
      // Two "shared" plugins, one in a "first" path and one in a "second" path.
      const first = mkdtempSync(join(tmpdir(), "vex-plugin-first-"));
      const second = mkdtempSync(join(tmpdir(), "vex-plugin-second-"));
      try {
        mkdirSync(join(first, "shared"));
        writeFileSync(join(first, "shared", "index.js"), "module.exports = {};");
        mkdirSync(join(second, "shared"));
        writeFileSync(
          join(second, "shared", "vex.plugin.json"),
          JSON.stringify({ id: "shared", name: "Shared Second", version: "9.9.9" }),
        );
        writeFileSync(join(second, "shared", "index.js"), "module.exports = {};");

        const candidates = await discoverPlugins({
          paths: [first, second],
          includeBuiltin: false,
          includeGlobal: false,
          includeWorkspace: false,
          allowTsEntries: false,
        });
        expect(candidates).toHaveLength(1);
        expect(candidates[0]?.origin).toBe("config");
        expect(candidates[0]?.manifest?.name).toBe("Shared Second");
        expect(candidates[0]?.entryPath).toBe(join(second, "shared", "index.js"));
      } finally {
        rmSync(first, { recursive: true, force: true });
        rmSync(second, { recursive: true, force: true });
      }
    });

    it("skips .ts entries when the runtime cannot import TypeScript", async () => {
      writeFileSync(join(dir, "tsonly.ts"), "export default () => {};\n");
      writeFileSync(join(dir, "jsok.js"), "module.exports = {};\n");
      const tsDirPlugin = join(dir, "tsdir");
      mkdirSync(tsDirPlugin);
      writeFileSync(join(tsDirPlugin, "index.ts"), "export default () => {};\n");

      const candidates = await discoverPlugins({
        paths: [dir],
        includeBuiltin: false,
        includeGlobal: false,
        includeWorkspace: false,
        allowTsEntries: false,
      });
      expect(candidates.map((c) => c.id)).toEqual(["jsok"]);
    });

    it("keeps .ts entries when TS imports are allowed", async () => {
      writeFileSync(join(dir, "tsonly.ts"), "export default () => {};\n");
      const candidates = await discoverPlugins({
        paths: [dir],
        includeBuiltin: false,
        includeGlobal: false,
        includeWorkspace: false,
        allowTsEntries: true,
      });
      expect(candidates.map((c) => c.id)).toEqual(["tsonly"]);
    });

    it("skips a directory with no entry file, no manifest, and no package.json", async () => {
      mkdirSync(join(dir, "empty"));
      writeFileSync(join(dir, "empty", "README.md"), "# not a plugin");
      const candidates = await discoverPlugins({
        paths: [dir],
        includeBuiltin: false,
        includeGlobal: false,
        includeWorkspace: false,
        allowTsEntries: true,
      });
      expect(candidates).toEqual([]);
    });

    it("skips a malformed manifest without throwing", async () => {
      const pluginDir = join(dir, "bad");
      mkdirSync(pluginDir);
      writeFileSync(join(pluginDir, "vex.plugin.json"), "{ this is not json");
      const candidates = await discoverPlugins({
        paths: [dir],
        includeBuiltin: false,
        includeGlobal: false,
        includeWorkspace: false,
        allowTsEntries: true,
      });
      // The malformed manifest is dropped but the directory still falls through
      // to the index.* default-entry search. Without an index file the
      // directory produces no candidate.
      expect(candidates).toEqual([]);
    });
  });
});
