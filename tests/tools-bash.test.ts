import { spawnSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildChildEnv, createBashTool, truncateMiddle } from "../src/tools/bash.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

let ws: string;
beforeEach(async () => { ws = await realpath(await makeTmpDir()); });
afterEach(async () => { await removeTmpDir(ws); });

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((c) => c.text ?? "").join("");
}

describe("buildChildEnv", () => {
  it("keeps only allowlisted, locale and passthrough variables", () => {
    const env = buildChildEnv(["GITHUB_TOKEN"], {
      PATH: "/bin",
      HOME: "/h",
      LC_ALL: "zh_CN.UTF-8",
      DEEPSEEK_API_KEY: "secret",
      GITHUB_TOKEN: "gh",
    });
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", LC_ALL: "zh_CN.UTF-8", GITHUB_TOKEN: "gh" });
  });
});

describe("truncateMiddle", () => {
  it("keeps short text and elides the middle of long text", () => {
    expect(truncateMiddle("abc", 10)).toBe("abc");
    expect(truncateMiddle("aaaaXXXXbbbb", 8)).toBe("aaaa\n… (4 characters omitted) …\nbbbb");
  });
});

describe("bash tool", () => {
  it("provides the current configuration path without extending secret passthrough", async () => {
    const configPath = `${ws}/config.yaml`;
    const tool = createBashTool({ workspace: ws, envPassthrough: [], configPath });
    expect(textOf(await tool.execute("1", { command: 'printf "%s" "$VEX_CONFIG_PATH"' }))).toBe(configPath);
  });
  it("runs in the workspace and merges stderr", async () => {
    const tool = createBashTool({ workspace: ws, envPassthrough: [] });
    const result = await tool.execute("1", { command: "pwd; echo oops >&2" });
    expect(textOf(result)).toBe(`${ws}\noops\n`);
  });

  it("reports an empty output explicitly", async () => {
    const tool = createBashTool({ workspace: ws, envPassthrough: [] });
    expect(textOf(await tool.execute("1", { command: "true" }))).toBe("(no output)");
  });

  it("does not leak secrets from the parent environment", async () => {
    process.env.VEX_TEST_SECRET = "leak";
    try {
      const tool = createBashTool({ workspace: ws, envPassthrough: [] });
      expect(textOf(await tool.execute("1", { command: 'echo "[$VEX_TEST_SECRET]"' }))).toBe("[]\n");
      const allowed = createBashTool({ workspace: ws, envPassthrough: ["VEX_TEST_SECRET"] });
      expect(textOf(await allowed.execute("1", { command: 'echo "[$VEX_TEST_SECRET]"' }))).toBe("[leak]\n");
    } finally {
      delete process.env.VEX_TEST_SECRET;
    }
  });

  it("throws with output and exit code on failure", async () => {
    const tool = createBashTool({ workspace: ws, envPassthrough: [] });
    await expect(tool.execute("1", { command: "echo bad; exit 3" })).rejects.toThrow("bad\n\n[exit code 3]");
  });

  it("kills the command on timeout", async () => {
    const tool = createBashTool({ workspace: ws, envPassthrough: [] });
    const started = Date.now();
    await expect(tool.execute("1", { command: "echo start; sleep 30", timeout: 1 })).rejects.toThrow(/timed out after 1 seconds/);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("kills the command when aborted", async () => {
    const tool = createBashTool({ workspace: ws, envPassthrough: [] });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    await expect(tool.execute("1", { command: "sleep 30" }, controller.signal)).rejects.toThrow("Command interrupted");
  });

  it.skipIf(spawnSync("setsid", ["true"]).status !== 0).each(["timeout", "abort"])(
    "settles on %s when an escaped descendant holds the output pipes",
    async (reason) => {
      const tool = createBashTool({ workspace: ws, envPassthrough: [] });
      const controller = new AbortController();
      const started = Date.now();
      const abortTimer = reason === "abort" ? setTimeout(() => controller.abort(), 300) : undefined;
      try {
        const result = tool.execute("1", { command: "setsid sleep 30 & echo $! > escaped.pid; echo start; sleep 30", timeout: 1 }, controller.signal);
        await expect(result).rejects.toThrow(reason === "timeout" ? /timed out after 1 seconds and was terminated\nstart/s : "Command interrupted");
        expect(Date.now() - started).toBeLessThan(2500);
      } finally {
        clearTimeout(abortTimer);
        const pid = Number(await readFile(join(ws, "escaped.pid"), "utf8"));
        try { process.kill(pid, "SIGKILL"); } catch { /* Already exited. */ }
      }
    },
  );

  it("truncates huge output in the middle", async () => {
    const tool = createBashTool({ workspace: ws, envPassthrough: [] });
    const text = textOf(await tool.execute("1", { command: "head -c 100000 /dev/zero | tr '\\0' a; echo; echo END" }));
    expect(text.length).toBeLessThan(31_000);
    expect(text).toContain("… (");
    expect(text.endsWith("END\n")).toBe(true);
  });
});
