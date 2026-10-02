import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runOnboard, type OnboardIO } from "../src/cli/onboard.js";
import { loadConfig } from "../src/config/load.js";
import { resolvePaths, type VexPaths } from "../src/paths.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

let dir: string;
let paths: VexPaths;
beforeEach(async () => {
  dir = await makeTmpDir();
  paths = resolvePaths(dir);
});
afterEach(async () => { await removeTmpDir(dir); });

function scripted(answers: string[]): OnboardIO & { output: string[] } {
  const output: string[] = [];
  return {
    output,
    ask: async (question) => {
      output.push(question);
      const answer = answers.shift();
      if (answer === undefined) throw new Error(`unexpected question: ${question}`);
      return answer;
    },
    print: (line) => output.push(line),
  };
}

describe("runOnboard", () => {
  it("configures a built-in provider", async () => {
    const io = scripted(["9", "1", "1", "", "sk-test", ""]);
    expect(await runOnboard(io, paths, { force: false })).toBe(true);
    const { config } = await loadConfig(paths);
    expect(config.model).toEqual({ provider: "deepseek", id: getBuiltinModels("deepseek")[0]!.id });
    expect(config.providers.deepseek?.apiKey).toBe("sk-test");
    expect(config.web.port).toBe(7860);
    expect((await stat(join(dir, "workspace", "SOUL.md"))).isFile()).toBe(true);
    expect(io.output).toContain("请输入 1 到 8 之间的编号");
    expect(io.output).toContain("API key 不能为空");
  });

  it("configures a custom provider", async () => {
    const io = scripted(["8", "stepfun", "1", "https://api.stepfun.com/v1", "step-2-16k", "", "abc", "8000"]);
    expect(await runOnboard(io, paths, { force: false })).toBe(true);
    const { config } = await loadConfig(paths);
    expect(config.model).toEqual({ provider: "stepfun", id: "step-2-16k" });
    expect(config.providers.stepfun).toEqual({
      api: "openai-completions",
      baseUrl: "https://api.stepfun.com/v1",
      models: [{ id: "step-2-16k" }],
    });
    expect(config.web.port).toBe(8000);
    expect(io.output).toContain("请输入 1 到 65535 之间的端口");
  });

  it("refuses to overwrite an existing config without --force", async () => {
    await writeFile(paths.config, "model: { provider: deepseek, id: x }\n", "utf8");
    const io = scripted([]);
    expect(await runOnboard(io, paths, { force: false })).toBe(false);
    expect(io.output[0]).toContain("--force");
  });
});
