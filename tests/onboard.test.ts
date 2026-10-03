import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WeChatStore } from "../src/channels/wechat/store.js";
import { runOnboard, type OnboardIO } from "../src/cli/onboard.js";
import { loadConfig } from "../src/config/load.js";
import { resolvePaths, type VexPaths } from "../src/paths.js";
import { FakeIlink } from "./helpers/ilink.js";
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
    const io = scripted(["9", "1", "1", "", "sk-test", "", ""]);
    expect(await runOnboard(io, paths, { force: false })).toBe(true);
    const { config } = await loadConfig(paths);
    expect(config.model).toEqual({ provider: "deepseek", id: getBuiltinModels("deepseek")[0]!.id });
    expect(config.providers.deepseek?.apiKey).toBe("sk-test");
    expect(config.web.port).toBe(7860);
    expect((await stat(join(dir, "workspace", "SOUL.md"))).isFile()).toBe(true);
    expect(io.output).toContain("请输入 1 到 8 之间的编号");
    expect(io.output).toContain("API key 不能为空");
  });

  it("links WeChat right away when asked", async () => {
    const ilink = new FakeIlink();
    await ilink.start();
    try {
      ilink.on("/ilink/bot/get_bot_qrcode", () => ({ qrcode: "q1", qrcode_img_content: "https://login.example/q1" }));
      ilink.on("/ilink/bot/get_qrcode_status", () => ({ status: "confirmed", bot_token: "tok", ilink_bot_id: "bot1", ilink_user_id: "owner1" }));
      const io = scripted(["1", "1", "sk-test", "", "y"]);
      expect(await runOnboard(io, paths, { force: false, login: { baseUrl: ilink.baseUrl, pollIntervalMs: 1 } })).toBe(true);
      expect((await new WeChatStore(paths.wechat).loadCredentials())?.userId).toBe("owner1");
      expect(io.output).toContain("已绑定微信，主人是扫码的这个微信号（owner1）。");
      expect(io.output.at(-1)).toBe("运行 vex start 启动");
      expect(io.output.some((line) => line.includes("重启 vexd"))).toBe(false);
    } finally {
      await ilink.stop();
    }
  });

  it("finishes onboarding when the WeChat login fails", async () => {
    const ilink = new FakeIlink();
    await ilink.start();
    try {
      ilink.on("/ilink/bot/get_bot_qrcode", () => ({ qrcode: "q1", qrcode_img_content: "https://login.example/q1" }));
      ilink.on("/ilink/bot/get_qrcode_status", () => ({ status: "cancel" }));
      const io = scripted(["1", "1", "sk-test", "", "y"]);
      expect(await runOnboard(io, paths, { force: false, login: { baseUrl: ilink.baseUrl, pollIntervalMs: 1 } })).toBe(true);
      expect(await new WeChatStore(paths.wechat).loadCredentials()).toBeUndefined();
      expect(io.output).toContain("微信绑定没有完成：已在手机上取消登录。之后可以运行 vex wechat login 重试");
      expect(io.output.at(-1)).toBe("运行 vex start 启动");
    } finally {
      await ilink.stop();
    }
  });

  it("configures a custom provider", async () => {
    const io = scripted(["8", "stepfun", "1", "https://api.stepfun.com/v1", "step-2-16k", "", "abc", "8000", "n"]);
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
