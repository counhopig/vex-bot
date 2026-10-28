import { spawnSync } from "node:child_process";
import { mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBashTool } from "../src/tools/bash.js";
import { prepareSandbox, sandboxArguments, type SandboxPaths } from "../src/tools/sandbox.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

let root: string;
let paths: SandboxPaths;
const savedTmp = process.env.TMPDIR;
beforeEach(async () => {
  root = await realpath(await makeTmpDir());
  const home = join(root, "home");
  paths = { home, workspace: join(home, "workspace"), config: join(home, "config.yaml") };
  await mkdir(paths.workspace, { recursive: true });
  await mkdir(join(root, "outside"));
  await mkdir(join(root, "tmp"));
  await writeFile(paths.config, "model: { provider: p, id: m }\n");
  await writeFile(join(home, "secret"), "token");
  // The test tree lives under the system temporary directory, which the sandbox leaves writable.
  process.env.TMPDIR = join(root, "tmp");
});
afterEach(async () => {
  if (savedTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmp;
  await removeTmpDir(root);
});

const flags = (args: string[], flag: string) => args.flatMap((arg, i) => (arg === flag && args[i + 1] ? [args[i + 1]!] : []));

describe("sandboxArguments", () => {
  it("reads around the data home, keeps the configuration readable and writes only the workspace and temporary files", async () => {
    await symlink(paths.home, join(root, "alias"));
    const args = sandboxArguments(paths, { readable: [], writable: ["/extra"] });
    const read = flags(args, "-r");
    expect(read).toContain(join(root, "outside"));
    expect(read).toContain(paths.config);
    expect(read).not.toContain(paths.home);
    // A symlink into the data home would reopen it.
    expect(read).not.toContain(join(root, "alias"));
    expect(read).not.toContain("/");
    expect(flags(args, "-w")).toEqual(expect.arrayContaining([paths.workspace, join(root, "tmp"), "/dev/null", "/extra"]));
    expect(flags(args, "-l")).toEqual(["/"]);
  });
});

describe("unavailable sandbox", () => {
  it("reports a missing helper and refuses every command", async () => {
    const sandbox = await prepareSandbox(paths, { mode: "workspace", readable: [], writable: [], helper: join(root, "missing") });
    expect(sandbox).toMatchObject({ ok: false });
    const tool = createBashTool({ workspace: paths.workspace, envPassthrough: [], sandbox: sandbox! });
    await expect(tool.execute("1", { command: "touch ran" })).rejects.toThrow(/sandbox is on but cannot confine commands/);
    await expect(readFile(join(paths.workspace, "ran"))).rejects.toThrow();
  });

  it("is absent when the mode is off", async () => {
    expect(await prepareSandbox(paths, { mode: "off", readable: [], writable: [] })).toBeUndefined();
  });
});

describe("Landlock sandbox", async () => {
  const dir = await makeTmpDir();
  const helper = join(dir, "vex-sandbox");
  const built = process.platform === "linux" && spawnSync("cc", ["-O2", "-o", helper, "native/vex-sandbox.c"]).status === 0;
  const supported = built && spawnSync(helper, ["--probe"]).status === 0;
  afterAll(() => removeTmpDir(dir));

  it.skipIf(!supported)("confines writes to the workspace and hides the data home", async () => {
    const sandbox = await prepareSandbox(paths, { mode: "workspace", readable: [], writable: [], helper });
    expect(sandbox).toMatchObject({ ok: true });
    const tool = createBashTool({ workspace: paths.workspace, envPassthrough: [], configPath: paths.config, sandbox: sandbox! });
    const run = (command: string) => tool.execute("1", { command }).then(
      (result) => result.content.map((part) => ("text" in part ? part.text : "")).join(""),
      (error: Error) => `failed: ${error.message}`,
    );
    expect(await run("echo hi > note && cat note")).toBe("hi\n");
    expect(await run('cat "$VEX_CONFIG_PATH"')).toContain("provider");
    expect(await run(`echo x > ${join(root, "outside", "x")}`)).toMatch(/failed: .*Permission denied/);
    expect(await run(`cat ${join(paths.home, "secret")}`)).toMatch(/failed: .*Permission denied/);
    expect(await run(`echo x > "$TMPDIR/x" && echo ok`)).toBe("ok\n");
    // Landlock forbids tracing processes outside the sandbox, which guards the daemon's environment; root bypasses it.
    if (process.getuid?.() !== 0) expect((await run(`cat /proc/${process.pid}/environ`)).startsWith("failed:")).toBe(true);
    expect(await run(`kill -0 ${process.pid}`)).toMatch(/failed: .*not permitted/);
  });

  it.skipIf(!supported)("still stops a timed-out command", async () => {
    const sandbox = await prepareSandbox(paths, { mode: "workspace", readable: [], writable: [], helper });
    const tool = createBashTool({ workspace: paths.workspace, envPassthrough: [], sandbox: sandbox! });
    await expect(tool.execute("1", { command: "sleep 30", timeout: 1 })).rejects.toThrow(/timed out/);
  });
});
