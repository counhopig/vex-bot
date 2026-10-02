import { realpath } from "node:fs/promises";
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
    expect(truncateMiddle("aaaaXXXXbbbb", 8)).toBe("aaaa\n…（省略 4 个字符）…\nbbbb");
  });
});

describe("bash tool", () => {
  it("runs in the workspace and merges stderr", async () => {
    const tool = createBashTool({ workspace: ws, envPassthrough: [] });
    const result = await tool.execute("1", { command: "pwd; echo oops >&2" });
    expect(textOf(result)).toBe(`${ws}\noops\n`);
  });

  it("reports an empty output explicitly", async () => {
    const tool = createBashTool({ workspace: ws, envPassthrough: [] });
    expect(textOf(await tool.execute("1", { command: "true" }))).toBe("(无输出)");
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
    await expect(tool.execute("1", { command: "echo bad; exit 3" })).rejects.toThrow("bad\n\n[退出码 3]");
  });

  it("kills the command on timeout", async () => {
    const tool = createBashTool({ workspace: ws, envPassthrough: [] });
    const started = Date.now();
    await expect(tool.execute("1", { command: "echo start; sleep 30", timeout: 1 })).rejects.toThrow(/超时（1 秒）/);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("kills the command when aborted", async () => {
    const tool = createBashTool({ workspace: ws, envPassthrough: [] });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    await expect(tool.execute("1", { command: "sleep 30" }, controller.signal)).rejects.toThrow("命令已中断");
  });

  it("truncates huge output in the middle", async () => {
    const tool = createBashTool({ workspace: ws, envPassthrough: [] });
    const text = textOf(await tool.execute("1", { command: "head -c 100000 /dev/zero | tr '\\0' a; echo; echo END" }));
    expect(text.length).toBeLessThan(31_000);
    expect(text).toContain("…（省略");
    expect(text.endsWith("END\n")).toBe(true);
  });
});
