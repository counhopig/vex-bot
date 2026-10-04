import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearPendingReload, clearReloadError, readPendingReload, readReloadError, rollbackReload, writePendingReload } from "../src/config/reload.js";
import { resolvePaths, type VexPaths } from "../src/paths.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

let dir: string;
let paths: VexPaths;
beforeEach(async () => { dir = await makeTmpDir(); paths = resolvePaths(dir); });
afterEach(async () => { await removeTmpDir(dir); });

describe("reload safety net", () => {
  it("remembers the previous configuration until the new one has started", async () => {
    expect(await readPendingReload(paths)).toBeUndefined();
    await writePendingReload(paths, "model: old\n");
    expect(await readPendingReload(paths)).toEqual({ previous: "model: old\n" });
    await clearPendingReload(paths);
    expect(await readPendingReload(paths)).toBeUndefined();
  });

  it("restores the previous configuration after a failed start and records the reason", async () => {
    await writePendingReload(paths, "model: old\n");
    await rollbackReload(paths, { previous: "model: old\n" }, new Error("listen EADDRINUSE"));
    expect(await readFile(paths.config, "utf8")).toBe("model: old\n");
    expect(await readPendingReload(paths)).toBeUndefined();
    expect(await readReloadError(paths)).toBe("listen EADDRINUSE");
    await clearReloadError(paths);
    expect(await readReloadError(paths)).toBeUndefined();
  });

  it("ignores unreadable marker files", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(paths.home, "state"), { recursive: true });
    await writeFile(join(paths.home, "state", "pending-reload.json"), "not json");
    expect(await readPendingReload(paths)).toBeUndefined();
  });
});
