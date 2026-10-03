import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.js";
import { resolvePaths } from "../src/paths.js";
import { discoverSkills } from "../src/skills/discovery.js";

const samples = new URL("../docs/samples/", import.meta.url).pathname;
const dir = await mkdtemp(join(tmpdir(), "vex-samples-"));
afterAll(() => rm(dir, { recursive: true, force: true }));

describe("documentation samples", () => {
  it.each(["config.minimal.yaml", "config.full.yaml"])("%s is a valid configuration", async (name) => {
    const text = await readFile(join(samples, name), "utf8");
    expect(() => parseConfig(text, resolvePaths(dir))).not.toThrow();
  });

  it("the sample skill is discoverable", async () => {
    const skills = await discoverSkills({ workspace: dir, builtinDir: join(samples, "skills") });
    expect(skills.map((skill) => skill.name)).toEqual(["daily-brief"]);
  });
});
