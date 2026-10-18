import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { bilibili } from "./bilibili.mjs";
import { douyin } from "./douyin.mjs";
import { firstUrl as sharedFirstUrl, hostMatches, importCompiled } from "./shared.mjs";
import { summarizeText } from "./summarize.mjs";
import { transcribeVideo } from "./stt.mjs";
import { xiaohongshu } from "./xiaohongshu.mjs";
import { youtube } from "./youtube.mjs";
import { wechat } from "./wechat.mjs";

const PLATFORMS = [bilibili, youtube, douyin, xiaohongshu, wechat];
const TRANSCRIBABLE = new Set(["Bilibili", "YouTube"]);
const MAX_TRANSCRIPT = 500_000;
const RAW_LIMIT = 30_000;
const FALLBACK_LIMIT = 20_000;

export const findPlatform = (text) => PLATFORMS.find((platform) => platform.match(text));
export const firstUrl = (text) => sharedFirstUrl(text) ?? text.trim();

function createHttp(platform, { fetchPublicPage, request, signal }) {
  const call = (url, init) => fetchPublicPage(url, { signal, request, timeoutMs: 30_000, hosts: (host) => hostMatches(`https://${host}`, platform.hosts), maxBytes: platform.maxBytes, init })
    .then((page) => ({ url: page.url, body: page.body }));
  return {
    get: (url, headers) => call(url, { headers }),
    post: (url, json, headers) => call(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(json) }),
  };
}

function duration(seconds) {
  if (!seconds) return "unknown";
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60), rest = seconds % 60;
  return hours ? `${hours}h ${minutes}m ${rest}s` : `${minutes}m ${rest}s`;
}

function header(content) {
  const description = content.description?.trim().replace(/\s+/g, " ");
  return [
    `Platform: ${content.platform}`,
    `Title: ${content.title || "(untitled)"}`,
    `Author: ${content.author || "(unknown)"}`,
    `Duration: ${duration(content.durationSeconds)}`,
    `Link: ${content.url}`,
    ...(description ? [`Description: ${description.length > 500 ? `${description.slice(0, 500)}…` : description}`] : []),
    ...(content.extra?.length ? [`More: ${content.extra.join("; ")}`] : []),
    ...(content.cover ? [`Cover: ${content.cover}`] : []),
  ];
}

export async function readOriginalSource(text, { fetchPublicPage, request, sessdata, signal, stt, runCommand, sttFetch } = {}) {
  const platform = findPlatform(text);
  if (!platform) throw new Error(`This link is not supported; supported: ${PLATFORMS.map((item) => item.name).join(", ")}`);
  const content = await platform.read(text, createHttp(platform, { fetchPublicPage, request, signal }), { sessdata });
  let sttNote;
  if (!content.text && TRANSCRIBABLE.has(content.platform)) {
    if (!stt) {
      sttNote = "(Speech to text is not configured; once a service is set under stt, videos without subtitles are transcribed)";
    } else {
      try {
        const spoken = await transcribeVideo(content, stt, { runCommand, fetchFn: sttFetch, signal });
        if (spoken) { content.text = spoken; content.textKind = "transcript"; }
        else sttNote = "(Speech to text recognised nothing)";
      } catch (error) {
        signal?.throwIfAborted();
        sttNote = `(Speech to text failed: ${error.message})`;
      }
    }
  }
  const original = content.text ?? "";
  const truncated = original.length > MAX_TRANSCRIPT;
  return {
    requestedUrl: firstUrl(text),
    canonicalUrl: content.url,
    url: content.url,
    title: content.title ?? "",
    text: original.slice(0, MAX_TRANSCRIPT),
    textKind: content.textKind ?? "text",
    truncated,
    platform: content.platform,
    author: content.author,
    description: content.description,
    durationSeconds: content.durationSeconds,
    extra: content.extra,
    cover: content.cover,
    sttNote,
  };
}

export async function readLink(text, { fetchPublicPage, request, ask, sessdata, raw = false, signal, stt, runCommand, sttFetch } = {}) {
  const content = await readOriginalSource(text, { fetchPublicPage, request, sessdata, signal, stt, runCommand, sttFetch });
  const note = content.sttNote;
  const lines = header(content);
  const body = content.text;
  const kind = content.textKind;
  if (!body) {
    lines.push("", "This link has no readable subtitles or text, so only the basic information above is available.", ...(note ? [note] : []));
  } else if (raw || !ask) {
    const display = body.length > RAW_LIMIT
      ? `${body.slice(0, RAW_LIMIT)}\n… (truncated; ${RAW_LIMIT} shown of ${body.length}${content.truncated ? " retained before the source processing limit" : " characters"})`
      : body;
    lines.push("", `Original ${kind}:`, display);
  } else {
    try {
      lines.push("", `Summary of the ${kind}:`, await summarizeText(body, kind, ask));
    } catch (error) {
      signal?.throwIfAborted();
      lines.push("", `(Summary failed: ${error.message}. Below is the original ${kind}, truncated)`, body.slice(0, FALLBACK_LIMIT));
    }
  }
  if (content.truncated) lines.push("(Source processing limit reached; this is not the complete original)");
  return lines.join("\n");
}

async function main(args) {
  const [argument, ...flags] = args;
  if (!argument) throw new Error("Usage: read.mjs LINK (or - to read the whole share text from standard input) [--raw] [--config PATH]");
  let target = argument;
  if (argument === "-") {
    target = "";
    for await (const chunk of process.stdin) target += chunk;
  }
  let raw = false, configFlag;
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === "--raw") raw = true;
    else if (flags[i] === "--config" && flags[i + 1]) configFlag = flags[++i];
    else throw new Error("Invalid script argument");
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
      { systemPrompt: "You are a careful summarizer; summarize only what the given content says.", messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
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
