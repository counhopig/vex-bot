import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isAlive, readPid, removePid, tailLines, waitUntil, writePid } from "../src/cli/process.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

let dir: string;
beforeEach(async () => { dir = await makeTmpDir(); });
afterEach(async () => { await removeTmpDir(dir); });

describe("pid file", () => {
  it("writes, reads and removes", async () => {
    const file = join(dir, "vexd.pid");
    expect(await readPid(file)).toBeUndefined();
    await writePid(file, process.pid);
    expect(await readPid(file)).toBe(process.pid);
    await removePid(file);
    expect(await readPid(file)).toBeUndefined();
  });

  it("ignores garbage", async () => {
    const file = join(dir, "vexd.pid");
    await writeFile(file, "abc", "utf8");
    expect(await readPid(file)).toBeUndefined();
  });

  it("does not trust a legacy PID even when the process is alive", async () => {
    const file = join(dir, "vexd.pid");
    await writeFile(file, `${process.pid}\n`);
    expect(await readPid(file)).toBeUndefined();
    expect(isAlive(process.pid)).toBe(true);
  });

  it("rejects reused PIDs and records for another CLI", async () => {
    const file = join(dir, "vexd.pid");
    const cliPath = join(dir, "vex.js");
    await writePid(file, process.pid, cliPath);
    expect(await readPid(file, cliPath)).toBe(process.pid);
    expect(await readPid(file, join(dir, "other.js"))).toBeUndefined();
    const record = JSON.parse(await readFile(file, "utf8"));
    record.identity.startTime += "0";
    await writeFile(file, JSON.stringify(record));
    expect(await readPid(file, cliPath)).toBeUndefined();
    expect(isAlive(process.pid)).toBe(true);
  });

  it("rejects a changed command identity", async () => {
    const file = join(dir, "vexd.pid");
    await writePid(file, process.pid);
    const record = JSON.parse(await readFile(file, "utf8"));
    record.identity.command = "other-process";
    await writeFile(file, JSON.stringify(record));
    expect(await readPid(file)).toBeUndefined();
  });
});

describe("isAlive", () => {
  it("detects live and exited processes", async () => {
    expect(isAlive(process.pid)).toBe(true);
    const child = spawn("true");
    await new Promise((r) => child.on("exit", r));
    expect(isAlive(child.pid!)).toBe(false);
  });
});

describe("waitUntil", () => {
  it("resolves true once the check passes and false on timeout", async () => {
    let n = 0;
    expect(await waitUntil(() => ++n >= 3, 1000, 5)).toBe(true);
    expect(await waitUntil(() => false, 50, 5)).toBe(false);
  });
});

describe("tailLines", () => {
  it("returns the last lines of a file", async () => {
    const file = join(dir, "log");
    await writeFile(file, "1\n2\n3\n4\n", "utf8");
    expect(await tailLines(file, 2)).toEqual(["3", "4"]);
    expect(await tailLines(join(dir, "missing"), 2)).toEqual([]);
  });
});
