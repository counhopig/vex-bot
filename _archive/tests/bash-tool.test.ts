/**
 * Bash tool tests - env allowlist behavior and option handling
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createBashTool, buildChildEnv } from "../src/tools/builtin/bash.js";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? "").join("");
}

describe("tools/builtin/bash", () => {
  it("defaults the working directory to the first allowed path (per-user sandbox)", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "vex-bash-cwd-")));
    try {
      const tool = createBashTool({ allowedPaths: [dir] });
      const result = await tool.execute("call-cwd", { command: "pwd" }, undefined);
      expect(textOf(result).trim()).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("executes a command when envPassthrough is explicitly undefined (default agent config)", async () => {
    // agent.ts passes envPassthrough: config.agent.bashEnvPassthrough, which is
    // undefined unless the user configured it — this must not break the tool.
    const tool = createBashTool({ allowedPaths: [process.cwd()], envPassthrough: undefined });
    const result = await tool.execute("call-1", { command: "echo hello" }, undefined);

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("hello");
  });

  describe("child process environment", () => {
    const touched: string[] = [];
    function setEnv(key: string, value: string) {
      touched.push(key);
      process.env[key] = value;
    }
    afterEach(() => {
      for (const key of touched.splice(0)) delete process.env[key];
    });

    it("withholds unlisted variables (e.g. API keys) from spawned commands", async () => {
      setEnv("VEX_TEST_SECRET", "s3cret-value");
      const tool = createBashTool({ allowedPaths: [process.cwd()] });
      const result = await tool.execute("call-1", { command: 'echo "secret=[$VEX_TEST_SECRET]"' }, undefined);
      expect(textOf(result)).toContain("secret=[]");
    });

    it("exposes variables opted in via envPassthrough", async () => {
      setEnv("VEX_TEST_SECRET", "s3cret-value");
      const tool = createBashTool({ allowedPaths: [process.cwd()], envPassthrough: ["VEX_TEST_SECRET"] });
      const result = await tool.execute("call-1", { command: 'echo "secret=[$VEX_TEST_SECRET]"' }, undefined);
      expect(textOf(result)).toContain("secret=[s3cret-value]");
    });

    it("passes proxy variables through by default", async () => {
      setEnv("http_proxy", "http://proxy.example:8080");
      setEnv("NO_PROXY", "localhost");
      const tool = createBashTool({ allowedPaths: [process.cwd()] });
      const result = await tool.execute("call-1", { command: 'echo "proxy=[$http_proxy] noproxy=[$NO_PROXY]"' }, undefined);
      expect(textOf(result)).toContain("proxy=[http://proxy.example:8080]");
      expect(textOf(result)).toContain("noproxy=[localhost]");
    });

    it("matches allowlist names case-insensitively when requested (Windows env semantics)", () => {
      // On Windows, process.env enumerates keys in their original casing
      // ("Path", not "PATH") — the allowlist must still match them.
      setEnv("Path", "C:\\Windows\\System32");
      expect(buildChildEnv([], { caseInsensitive: true })["Path"]).toBe("C:\\Windows\\System32");
      expect(buildChildEnv([], { caseInsensitive: false })["Path"]).toBeUndefined();
    });
  });
});
