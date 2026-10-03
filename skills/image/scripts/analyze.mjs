import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";

const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

export async function analyzeImage(options, registry, modelRef) {
  const path = resolve(options.image);
  const mimeType = MIME[extname(path).toLowerCase()];
  if (!mimeType) throw new Error("仅支持 PNG、JPEG、GIF、WebP");
  if ((await stat(path)).size > 10_000_000) throw new Error("图片超过 10 MB");
  const image = await readFile(path);
  if (image.length > 10_000_000) throw new Error("图片超过 10 MB");
  const model = registry.resolve(modelRef);
  if (!model.input.includes("image")) throw new Error(`模型 ${modelRef.provider}/${modelRef.id} 不支持图片输入`);
  const result = await registry.completeSimple(model, {
    messages: [{ role: "user", timestamp: Date.now(), content: [
      { type: "text", text: options.prompt ?? "请描述这张图片。" },
      { type: "image", data: image.toString("base64"), mimeType },
    ] }],
  }, { apiKey: registry.getApiKey(model.provider), signal: AbortSignal.timeout(60_000), maxTokens: 2048 });
  if (result.stopReason === "error" || result.stopReason === "aborted") throw new Error(result.errorMessage ?? "图片分析失败");
  return result.content.filter((part) => part.type === "text").map((part) => part.text).join("");
}

async function main(args) {
  const [image, prompt, ...flags] = args;
  if (!image) throw new Error("用法：analyze.mjs 图片路径 问题 [--config 路径] [--provider 名称 --model id]");
  const values = {};
  for (let i = 0; i < flags.length; i += 2) {
    if (!["--config", "--provider", "--model"].includes(flags[i]) || !flags[i + 1]) throw new Error("无效脚本参数");
    values[flags[i].slice(2)] = flags[i + 1];
  }
  if (Boolean(values.provider) !== Boolean(values.model)) throw new Error("--provider 与 --model 必须同时指定");
  const built = new URL("../../../providers/models.js", import.meta.url);
  const source = new URL("../../../dist/providers/models.js", import.meta.url);
  const modelsUrl = existsSync(built) ? built : source;
  const { createModelRegistry } = await import(modelsUrl.href);
  const { parse } = await import("yaml");
  const configPath = values.config ?? process.env.VEX_CONFIG_PATH ?? join(process.env.VEX_HOME ?? join(homedir(), ".vex"), "config.yaml");
  const config = parse(await readFile(configPath, "utf8"));
  const modelRef = values.provider ? { provider: values.provider, id: values.model } : config.model;
  if (!modelRef?.provider || !modelRef?.id) throw new Error("未配置图片分析模型");
  const registry = createModelRegistry(config.providers ?? {});
  console.log(await analyzeImage({ image, prompt }, registry, modelRef));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
