import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { expandHome, resolvePaths } from "../src/paths.js";

describe("resolvePaths", () => {
  const saved = process.env.VEX_HOME;
  afterEach(() => {
    if (saved === undefined) delete process.env.VEX_HOME;
    else process.env.VEX_HOME = saved;
  });

  it("derives every path from the given home", () => {
    const p = resolvePaths("/data/vex");
    expect(p).toEqual({
      home: "/data/vex",
      config: "/data/vex/config.yaml",
      sessions: "/data/vex/sessions",
      webSessions: "/data/vex/sessions/web",
      logs: "/data/vex/logs",
      logFile: "/data/vex/logs/vexd.log",
      pidFile: "/data/vex/vexd.pid",
      defaultWorkspace: "/data/vex/workspace",
      wechat: "/data/vex/wechat",
    });
  });

  it("uses VEX_HOME when no home is given", () => {
    process.env.VEX_HOME = "/env/vex";
    expect(resolvePaths().home).toBe("/env/vex");
  });

  it("defaults to ~/.vex", () => {
    delete process.env.VEX_HOME;
    expect(resolvePaths().home).toBe(join(homedir(), ".vex"));
  });
});

describe("expandHome", () => {
  it("expands a leading ~", () => {
    expect(expandHome("~")).toBe(homedir());
    expect(expandHome("~/notes")).toBe(join(homedir(), "notes"));
  });

  it("leaves other paths alone", () => {
    expect(expandHome("/abs/~x")).toBe("/abs/~x");
    expect(expandHome("rel/path")).toBe("rel/path");
  });
});
