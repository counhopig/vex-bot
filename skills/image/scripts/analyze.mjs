import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";

const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

export async function analyzeImage(options, registry, modelRef) {
  const path = resolve(options.image);
  const mimeType = MIME[extname(path).toLowerCase()];
  if (!mimeType) throw new Error("Only PNG, JPEG, GIF and WebP are supported");
  if ((await stat(path)).size > 10_000_000) throw new Error("The image exceeds 10 MB");
  const image = await readFile(path);
  if (image.length > 10_000_000) throw new Error("The image exceeds 10 MB");
  const model = registry.resolve(modelRef);
  if (!model.input.includes("image")) throw new Error(`The model ${modelRef.provider}/${modelRef.id} does not accept image input`);
  const result = await registry.completeSimple(model, {
    messages: [{ role: "user", timestamp: Date.now(), content: [
      { type: "text", text: options.prompt ?? "Describe this image." },
      { type: "image", data: image.toString("base64"), mimeType },
    ] }],
  }, { apiKey: registry.getApiKey(model.provider), signal: AbortSignal.timeout(60_000), maxTokens: 2048 });
  if (result.stopReason === "error" || result.stopReason === "aborted") throw new Error(result.errorMessage ?? "Image analysis failed");
  return result.content.filter((part) => part.type === "text").map((part) => part.text).join("");
}

async function main(args) {
  const [image, prompt, ...flags] = args;
  if (!image) throw new Error("Usage: analyze.mjs IMAGE_PATH QUESTION [--config PATH] [--provider NAME --model ID]");
  const values = {};
  for (let i = 0; i < flags.length; i += 2) {
    if (!["--config", "--provider", "--model"].includes(flags[i]) || !flags[i + 1]) throw new Error("Invalid script argument");
    values[flags[i].slice(2)] = flags[i + 1];
  }
  if (Boolean(values.provider) !== Boolean(values.model)) throw new Error("--provider and --model must be given together");
  const built = new URL("../../../providers/models.js", import.meta.url);
  const source = new URL("../../../dist/providers/models.js", import.meta.url);
  const modelsUrl = existsSync(built) ? built : source;
  const { createModelRegistry } = await import(modelsUrl.href);
  const { parse } = await import("yaml");
  const configPath = values.config ?? process.env.VEX_CONFIG_PATH ?? join(process.env.VEX_HOME ?? join(homedir(), ".vex"), "config.yaml");
  const config = parse(await readFile(configPath, "utf8"));
  const modelRef = values.provider ? { provider: values.provider, id: values.model } : config.model;
  if (!modelRef?.provider || !modelRef?.id) throw new Error("No model is configured for image analysis");
  const registry = createModelRegistry(config.providers ?? {});
  console.log(await analyzeImage({ image, prompt }, registry, modelRef));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
