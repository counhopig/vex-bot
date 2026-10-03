import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { bilibili } from "./bilibili.mjs";
import { douyin } from "./douyin.mjs";
import { hostMatches } from "./shared.mjs";
import { summarizeText } from "./summarize.mjs";
import { transcribeVideo } from "./stt.mjs";
import { xiaohongshu } from "./xiaohongshu.mjs";
import { youtube } from "./youtube.mjs";

const PLATFORMS = [bilibili, youtube, douyin, xiaohongshu];
const TRANSCRIBABLE = new Set(["B站", "YouTube"]);
const MAX_TRANSCRIPT = 500_000;
const RAW_LIMIT = 30_000;
const FALLBACK_LIMIT = 20_000;

export const findPlatform = (text) => PLATFORMS.find((platform) => platform.match(text));

function createHttp(platform, { fetchPublicPage, request, signal }) {
  const call = (url, init) => fetchPublicPage(url, { signal, request, timeoutMs: 30_000, hosts: (host) => hostMatches(`https://${host}`, platform.hosts), init })
    .then((page) => ({ url: page.url, body: page.body }));
  return {
    get: (url, headers) => call(url, { headers }),
    post: (url, json, headers) => call(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(json) }),
  };
}

function duration(seconds) {
  if (!seconds) return "未知";
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60), rest = seconds % 60;
  return hours ? `${hours}小时${minutes}分${rest}秒` : `${minutes}分${rest}秒`;
}

function header(content) {
  const description = content.description?.trim().replace(/\s+/g, " ");
  return [
    `平台：${content.platform}`,
    `标题：${content.title || "（无标题）"}`,
    `作者：${content.author || "（未知）"}`,
    `时长：${duration(content.durationSeconds)}`,
    `链接：${content.url}`,
    ...(description ? [`简介：${description.length > 500 ? `${description.slice(0, 500)}…` : description}`] : []),
    ...(content.extra?.length ? [`其他：${content.extra.join("；")}`] : []),
    ...(content.cover ? [`封面：${content.cover}`] : []),
  ];
}

export async function readLink(text, { fetchPublicPage, request, ask, sessdata, raw = false, signal, stt, runCommand, sttFetch } = {}) {
  const platform = findPlatform(text);
  if (!platform) throw new Error(`暂不支持这个链接，目前支持：${PLATFORMS.map((item) => item.name).join("、")}`);
  const content = await platform.read(text, createHttp(platform, { fetchPublicPage, request, signal }), { sessdata });
  let note;
  if (!content.text && TRANSCRIBABLE.has(content.platform)) {
    if (!stt) {
      note = "（未配置语音转文字；在配置的 stt 中填写服务后，没有字幕的视频会转写音频）";
    } else {
      try {
        const spoken = await transcribeVideo(content, stt, { runCommand, fetchFn: sttFetch, signal });
        if (spoken) { content.text = spoken; content.textKind = "语音转写"; }
        else note = "（语音转写没有识别出内容）";
      } catch (error) {
        signal?.throwIfAborted();
        note = `（语音转写失败：${error.message}）`;
      }
    }
  }
  const lines = header(content);
  const body = content.text?.slice(0, MAX_TRANSCRIPT);
  const kind = content.textKind ?? "正文";
  if (!body) {
    lines.push("", "该链接没有可读取的字幕或正文，只能提供上面的基本信息。", ...(note ? [note] : []));
  } else if (raw || !ask) {
    lines.push("", `${kind}原文：`, body.length > RAW_LIMIT ? `${body.slice(0, RAW_LIMIT)}\n…（已截断，共 ${body.length} 字）` : body);
  } else {
    try {
      lines.push("", `${kind}摘要：`, await summarizeText(body, kind, ask));
    } catch (error) {
      signal?.throwIfAborted();
      lines.push("", `（摘要失败：${error.message}。以下为${kind}原文，已截断）`, body.slice(0, FALLBACK_LIMIT));
    }
  }
  return lines.join("\n");
}

async function importCompiled(path) {
  const built = new URL(`../../../${path}`, import.meta.url);
  const source = new URL(`../../../dist/${path}`, import.meta.url);
  return import((existsSync(built) ? built : source).href);
}

async function main(args) {
  const [argument, ...flags] = args;
  if (!argument) throw new Error("用法：read.mjs 链接（或 - 从标准输入读取整段分享文字） [--raw] [--config 路径]");
  let target = argument;
  if (argument === "-") {
    target = "";
    for await (const chunk of process.stdin) target += chunk;
  }
  let raw = false, configFlag;
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === "--raw") raw = true;
    else if (flags[i] === "--config" && flags[i + 1]) configFlag = flags[++i];
    else throw new Error("无效脚本参数");
  }
  const { fetchPublicPage } = await importCompiled("tools/web.js");
  const { createModelRegistry } = await importCompiled("providers/models.js");
  const { parse } = await import("yaml");
  const configPath = configFlag ?? process.env.VEX_CONFIG_PATH ?? join(process.env.VEX_HOME ?? join(homedir(), ".vex"), "config.yaml");
  const config = parse(await readFile(configPath, "utf8"));
  const registry = createModelRegistry(config.providers ?? {});
  const model = registry.resolve(config.backgroundModel ?? config.model);
  const ask = async (prompt) => {
    const result = await registry.completeSimple(
      model,
      { systemPrompt: "你是严谨的内容摘要助手，只依据给出的内容总结。", messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
      { apiKey: registry.getApiKey(model.provider), maxTokens: 1500, signal: AbortSignal.timeout(120_000) },
    );
    if (result.stopReason === "error" || result.stopReason === "aborted") throw new Error(result.errorMessage ?? result.stopReason);
    return result.content.filter((part) => part.type === "text").map((part) => part.text).join("").trim();
  };
  const sessdata = config.links?.bilibili?.sessdata || process.env.BILIBILI_SESSDATA;
  console.log(await readLink(target, { fetchPublicPage, ask: raw ? undefined : ask, sessdata, raw, stt: config.stt?.baseUrl && config.stt?.model ? config.stt : undefined, signal: AbortSignal.timeout(570_000) }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
