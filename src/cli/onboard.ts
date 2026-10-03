import { randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import { getBuiltinModels, getBuiltinProviders, type BuiltinProvider } from "@earendil-works/pi-ai/providers/all";
import { stringify } from "yaml";
import { loadConfig, saveConfigText } from "../config/load.js";
import { isLoopback } from "../gateway/auth.js";
import type { VexPaths } from "../paths.js";
import type { LoginOptions } from "../channels/wechat/login.js";
import { ensureWorkspace } from "../workspace/workspace.js";
import { runWeChatLogin } from "./wechat.js";

export interface OnboardIO {
  ask(question: string): Promise<string>;
  print(line: string): void;
}

const FEATURED_PROVIDERS = [
  "deepseek",
  "moonshotai-cn",
  "minimax-cn",
  "zai-coding-cn",
  "qwen-token-plan-cn",
  "xiaomi",
  "openrouter",
];

export async function runOnboard(
  io: OnboardIO,
  paths: VexPaths,
  opts: { force: boolean; login?: LoginOptions & { baseUrl?: string } },
): Promise<boolean> {
  if (!opts.force && (await exists(paths.config))) {
    io.print(`配置文件已存在：${paths.config}（使用 --force 覆盖）`);
    return false;
  }

  const known: string[] = getBuiltinProviders();
  const providers = FEATURED_PROVIDERS.filter((p) => known.includes(p));
  io.print("选择模型提供方：");
  providers.forEach((p, i) => io.print(`  ${i + 1}. ${p}`));
  io.print(`  ${providers.length + 1}. 自定义（OpenAI / Anthropic 兼容端点）`);
  const choice = await askNumber(io, "编号：", 1, providers.length + 1, "编号");

  const doc: Record<string, unknown> = {};
  const provider = providers[choice - 1];
  if (provider) {
    const ids = getBuiltinModels(provider as BuiltinProvider).map((m) => m.id);
    io.print("选择模型：");
    ids.forEach((id, i) => io.print(`  ${i + 1}. ${id}`));
    const id = ids[(await askNumber(io, "编号：", 1, ids.length, "编号")) - 1]!;
    const apiKey = await askRequired(io, "API key：", "API key");
    doc.model = { provider, id };
    doc.providers = { [provider]: { apiKey } };
  } else {
    const name = await askRequired(io, "提供方名称（如 stepfun）：", "提供方名称");
    io.print("接口类型：");
    io.print("  1. openai-completions");
    io.print("  2. anthropic-messages");
    const api = (await askNumber(io, "编号：", 1, 2, "编号")) === 1 ? "openai-completions" : "anthropic-messages";
    const baseUrl = await askRequired(io, "baseUrl：", "baseUrl");
    const id = await askRequired(io, "模型 id：", "模型 id");
    const apiKey = (await io.ask("API key（没有可留空）：")).trim();
    doc.model = { provider: name, id };
    doc.providers = { [name]: { api, baseUrl, ...(apiKey ? { apiKey } : {}), models: [{ id }] } };
  }

  const host = process.env.VEX_WEB_HOST?.trim();
  const exposed = !!host && !isLoopback(host);
  const generatedToken = exposed && !process.env.VEX_WEB_TOKEN?.trim() ? randomBytes(24).toString("hex") : undefined;
  if (exposed) doc.web = { host, port: 7860, ...(generatedToken ? { token: generatedToken } : {}) };
  else doc.web = { host: "127.0.0.1", port: await askNumber(io, "WebChat 端口（默认 7860）：", 1, 65535, "端口", 7860) };

  await saveConfigText(paths, stringify(doc));
  const { config } = await loadConfig(paths);
  await ensureWorkspace(config.workspace);
  io.print(`已写入 ${paths.config}`);
  io.print(`工作区：${config.workspace}`);
  const linkNow = (await io.ask("现在扫码绑定微信吗？（y/N）：")).trim().toLowerCase();
  if (linkNow === "y" || linkNow === "yes") {
    try {
      await runWeChatLogin((text) => io.print(text), paths, { ...opts.login, restartHint: false });
    } catch (err) {
      io.print(`微信绑定没有完成：${err instanceof Error ? err.message : String(err)}。之后可以运行 vex wechat login 重试`);
    }
  } else {
    io.print("之后可以运行 vex wechat login 扫码绑定微信");
  }
  if (generatedToken) io.print(`WebChat 访问令牌（请记下，登录时使用，也保存在 ${paths.config}）：${generatedToken}`);
  io.print("运行 vex start 启动");
  return true;
}

async function askRequired(io: OnboardIO, question: string, label: string): Promise<string> {
  for (;;) {
    const answer = (await io.ask(question)).trim();
    if (answer) return answer;
    io.print(`${label} 不能为空`);
  }
}

async function askNumber(
  io: OnboardIO,
  question: string,
  min: number,
  max: number,
  label: string,
  fallback?: number,
): Promise<number> {
  for (;;) {
    const answer = (await io.ask(question)).trim();
    if (!answer && fallback !== undefined) return fallback;
    const value = Number(answer);
    if (Number.isInteger(value) && value >= min && value <= max) return value;
    io.print(`请输入 ${min} 到 ${max} 之间的${label}`);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
