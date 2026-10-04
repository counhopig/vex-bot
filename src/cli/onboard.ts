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
    io.print(`Config file already exists: ${paths.config} (use --force to overwrite)`);
    return false;
  }

  const known: string[] = getBuiltinProviders();
  const providers = FEATURED_PROVIDERS.filter((p) => known.includes(p));
  io.print("Choose a model provider:");
  providers.forEach((p, i) => io.print(`  ${i + 1}. ${p}`));
  io.print(`  ${providers.length + 1}. Custom (OpenAI- or Anthropic-compatible endpoint)`);
  const choice = await askNumber(io, "Number: ", 1, providers.length + 1, "number");

  const doc: Record<string, unknown> = {};
  const provider = providers[choice - 1];
  if (provider) {
    const ids = getBuiltinModels(provider as BuiltinProvider).map((m) => m.id);
    io.print("Choose a model:");
    ids.forEach((id, i) => io.print(`  ${i + 1}. ${id}`));
    const id = ids[(await askNumber(io, "Number: ", 1, ids.length, "number")) - 1]!;
    const apiKey = await askRequired(io, "API key：", "API key");
    doc.model = { provider, id };
    doc.providers = { [provider]: { apiKey } };
  } else {
    const name = await askRequired(io, "Provider name (for example stepfun): ", "The provider name");
    io.print("API type:");
    io.print("  1. openai-completions");
    io.print("  2. anthropic-messages");
    const api = (await askNumber(io, "Number: ", 1, 2, "number")) === 1 ? "openai-completions" : "anthropic-messages";
    const baseUrl = await askRequired(io, "baseUrl：", "baseUrl");
    const id = await askRequired(io, "Model id: ", "The model id");
    const apiKey = (await io.ask("API key (leave empty if none): ")).trim();
    doc.model = { provider: name, id };
    doc.providers = { [name]: { api, baseUrl, ...(apiKey ? { apiKey } : {}), models: [{ id }] } };
  }

  const host = process.env.VEX_WEB_HOST?.trim();
  const exposed = !!host && !isLoopback(host);
  const generatedToken = exposed && !process.env.VEX_WEB_TOKEN?.trim() ? randomBytes(24).toString("hex") : undefined;
  if (exposed) doc.web = { host, port: 7860, ...(generatedToken ? { token: generatedToken } : {}) };
  else doc.web = { host: "127.0.0.1", port: await askNumber(io, "WebChat port (default 7860): ", 1, 65535, "port", 7860) };

  await saveConfigText(paths, stringify(doc));
  const { config } = await loadConfig(paths);
  await ensureWorkspace(config.workspace);
  io.print(`Wrote ${paths.config}`);
  io.print(`Workspace: ${config.workspace}`);
  const linkNow = (await io.ask("Link WeChat by QR code now? (y/N): ")).trim().toLowerCase();
  if (linkNow === "y" || linkNow === "yes") {
    try {
      await runWeChatLogin((text) => io.print(text), paths, { ...opts.login, restartHint: false });
    } catch (err) {
      io.print(`WeChat linking did not finish: ${err instanceof Error ? err.message : String(err)}. Run vex wechat login later to try again`);
    }
  } else {
    io.print("Run vex wechat login later to link WeChat by QR code");
  }
  if (generatedToken) io.print(`WebChat access token (note it down for signing in; it is also stored in ${paths.config}): ${generatedToken}`);
  io.print("Run vex start to launch");
  return true;
}

async function askRequired(io: OnboardIO, question: string, label: string): Promise<string> {
  for (;;) {
    const answer = (await io.ask(question)).trim();
    if (answer) return answer;
    io.print(`${label} must not be empty`);
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
    io.print(`Enter a ${label} between ${min} and ${max}`);
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
