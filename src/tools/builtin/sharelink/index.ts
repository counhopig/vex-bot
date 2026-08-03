/**
 * ShareLink tool + auto-detect interceptor.
 *
 * Public API:
 *   - createShareLinkTool(options)     -> Tool named "sharelink_parse"
 *   - createShareLinkInterceptor(opts) -> MessageInterceptor
 *
 * Instance-scoped: every factory call builds a fresh PlatformRegistry;
 * zero module-level mutable state.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { Tool } from "../../types.js";
import type { MessageInterceptor } from "../../../agent/Pipeline.js";
import type { InboundMessageContext } from "../../../channels/ChannelAdapter.js";
import { textResult, errorResult, readStringParam } from "../../common.js";
import { buildShareLinkRegistry } from "./registry-factory.js";
import { PlatformRegistry } from "./platforms/registry.js";
import { BasePlatformAdapter } from "./platforms/base.js";
import { getChildLogger } from "../../../utils/logger.js";

const logger = getChildLogger("sharelink");

const URL_PATTERN = /https?:\/\/[^\s]+/;
const BV_PATTERN = /(?:bv|BV)([a-zA-Z0-9]{10})/;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ShareLinkConfig {
  enabled?: boolean;
  responseMode?: "simple" | "detailed";
  includeDescription?: boolean;
  includeCover?: boolean;
  descriptionMaxLength?: number;
  bilibiliCookie?: { sessdata?: string; biliJct?: string };
  summarizeProviderId?: string;
  sttProviderId?: string;
  audioDownloadTimeout?: number;
  subtitleMaxLength?: number;
  llmShortContentThreshold?: number;
  llmChunkSize?: number;
  autoDetect?: boolean;
}

// ---------------------------------------------------------------------------
// LLM summarizer injection
// ---------------------------------------------------------------------------

export type ShareLinkLlmComplete = (opts: { prompt: string }) => Promise<{ text: string }>;

// ---------------------------------------------------------------------------
// Factory: Tool
// ---------------------------------------------------------------------------

export function createShareLinkTool(options: {
  config: ShareLinkConfig;
  complete?: ShareLinkLlmComplete;
}): Tool {
  const parameters = Type.Object({
    url: Type.String({
      description: "Bilibili/YouTube URL, b23.tv short link, BV id, or YouTube video id",
    }),
  });

  return {
    name: "sharelink_parse",
    label: "ShareLink Parse",
    description:
      "Parse a Bilibili or YouTube share link and return metadata plus subtitles when available.",
    parameters,
    execute: async (_toolCallId, args, _signal, _onUpdate, _ctx) => {
      try {
        const params = args as Static<typeof parameters>;
        const url = readStringParam(params, "url", { required: true, label: "url" });
        const registry = buildShareLinkRegistry(options.config);
        const result = await parseTarget({
          registry,
          config: options.config,
          complete: options.complete,
          target: url ?? "",
        });
        return textResult(result);
      } catch (error) {
        return errorResult(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Factory: MessageInterceptor
// ---------------------------------------------------------------------------

export function createShareLinkInterceptor(options: {
  config: ShareLinkConfig;
  complete?: ShareLinkLlmComplete;
}): MessageInterceptor {
  return async (ctx: InboundMessageContext): Promise<string | null> => {
    if (!options.config.autoDetect) {
      return null;
    }

    const target = extractTarget(ctx.content);
    if (!target) {
      return null;
    }

    const registry = buildShareLinkRegistry(options.config);
    if (!registry.match(target)) {
      logger.debug({ target, messageId: ctx.messageId }, "ShareLink auto-detect found unsupported target");
      return null;
    }

    logger.info({ target, senderId: ctx.senderId }, "ShareLink auto-detect triggered");
    const result = await parseTarget({
      registry,
      config: options.config,
      complete: options.complete,
      target,
    });
    return result ?? null;
  };
}

// ---------------------------------------------------------------------------
// Internal parsing
// ---------------------------------------------------------------------------

interface ParseTargetOptions {
  registry: PlatformRegistry;
  config: ShareLinkConfig | undefined;
  complete: ShareLinkLlmComplete | undefined;
  target: string;
}

async function parseTarget(options: ParseTargetOptions): Promise<string> {
  const { registry, config, complete, target } = options;
  const startedAt = Date.now();

  const adapter = registry.match(target);
  if (!adapter) {
    throw new Error("Unsupported link. Currently supports Bilibili and YouTube.");
  }

  const resolvedUrl = await adapter.resolveUrl(target);
  const effectiveTarget = resolvedUrl ?? target;
  logger.debug({ target, resolvedUrl, adapter: adapter.name }, "ShareLink target resolved");

  const videoId = adapter.extractId(effectiveTarget);
  if (!videoId) {
    throw new Error("Could not extract a video id from the link.");
  }

  const metadata = await adapter.fetchMetadata(videoId);
  if (!metadata) {
    logger.warn(
      { target, videoId, adapter: adapter.name, durationMs: Date.now() - startedAt },
      "ShareLink metadata fetch failed",
    );
    throw new Error("解析失败：无法获取视频信息，可能是链接失效或视频不可访问。");
  }

  const canonicalUrl = adapter.getVideoUrl(videoId);
  const durationText = formatDuration(metadata.duration);
  const responseMode = config?.responseMode ?? "detailed";
  const includeDescription = config?.includeDescription ?? true;
  const includeCover = config?.includeCover ?? true;
  const descriptionMaxLength = config?.descriptionMaxLength ?? 120;

  const lines: string[] = ["解析结果"];

  if (responseMode === "simple") {
    lines.push(`标题: ${metadata.title || "(无标题)"}`);
    lines.push(`作者: ${metadata.owner || "(未知)"}`);
    lines.push(`链接: ${canonicalUrl}`);
  } else {
    lines.push(`平台: ${adapter.displayName}`);
    lines.push(`标题: ${metadata.title || "(无标题)"}`);
    lines.push(`作者: ${metadata.owner || "(未知)"}`);
    lines.push(`时长: ${durationText}`);
    lines.push(`${adapter.idLabel}: ${adapter.formatDisplayId(videoId)}`);
    lines.push(`规范链接: ${canonicalUrl}`);
  }

  if (resolvedUrl && resolvedUrl !== target) {
    lines.push(`原始短链: ${target}`);
  }

  if (includeDescription && metadata.description) {
    let desc = metadata.description.trim().replace(/\n/g, " ");
    if (desc.length > descriptionMaxLength) {
      desc = desc.slice(0, descriptionMaxLength) + "...";
    }
    lines.push(`简介: ${desc}`);
  }

  if (includeCover && metadata.thumbnailUrl) {
    lines.push(`封面: ${metadata.thumbnailUrl}`);
  }

  // Subtitles / audio fallback
  const subtitleMaxLength = config?.subtitleMaxLength ?? 5000;
  const contentText = await fetchContentWithFallback(adapter, videoId, config, subtitleMaxLength);

  let processedContent: string | undefined;
  if (contentText) {
    const threshold = config?.llmShortContentThreshold ?? 0;
    if (threshold > 0 && contentText.length <= threshold) {
      // Short content bypasses LLM
      processedContent = contentText;
    } else if (complete) {
      try {
        processedContent = await summarizeContent(
          contentText,
          complete,
          config?.llmChunkSize ?? 4000,
        );
      } catch (error) {
        logger.warn({ error }, "ShareLink summarization failed; using raw content");
        processedContent = contentText;
      }
    } else {
      // Deterministic fallback: raw subtitles truncated
      processedContent = contentText;
    }
  }

  if (processedContent) {
    lines.push("");
    lines.push("---");
    lines.push("视频内容:");
    lines.push(redactCookieValues(processedContent, config));
  }

  const output = lines.join("\n");
  logger.info(
    {
      target,
      adapter: adapter.name,
      videoId,
      responseMode,
      metadataTitleLength: metadata.title.length,
      hasContentText: Boolean(contentText),
      responseLength: output.length,
      durationMs: Date.now() - startedAt,
    },
    "ShareLink target parsed",
  );

  return redactCookieValues(output, config);
}

// ---------------------------------------------------------------------------
// Content fetching with fallback
// ---------------------------------------------------------------------------

async function fetchContentWithFallback(
  adapter: BasePlatformAdapter,
  videoId: string,
  cfg: ShareLinkConfig | undefined,
  maxLength: number,
): Promise<string | undefined> {
  // 1. Try subtitles
  try {
    const subtitles = await adapter.fetchSubtitles(videoId, maxLength);
    if (subtitles) {
      logger.info({ videoId, length: subtitles.length }, "Subtitles fetched successfully");
      return subtitles;
    }
  } catch (error) {
    logger.warn({ error, videoId }, "Subtitle fetch failed");
  }

  // 2. Subtitles unavailable, try audio download
  logger.info({ videoId }, "Subtitles unavailable, trying audio download");
  const audioPath = await adapter.downloadAudio(
    videoId,
    cfg?.audioDownloadTimeout ?? 300_000,
  );

  if (!audioPath) {
    logger.warn({ videoId }, "Audio download failed");
    return undefined;
  }

  // 3. STT transcription — not available in vex-bot core; return a hint
  logger.info({ videoId, audioPath }, "Audio downloaded; STT not available in vex-bot");
  (adapter.constructor as typeof BasePlatformAdapter).cleanupAudio(audioPath);
  return undefined;
}

// ---------------------------------------------------------------------------
// LLM summarization
// ---------------------------------------------------------------------------

async function summarizeContent(
  text: string,
  complete: ShareLinkLlmComplete,
  chunkSize: number,
): Promise<string> {
  if (text.length === 0) {
    return text;
  }

  if (text.length <= chunkSize) {
    const result = await complete({ prompt: `Summarize the following video content concisely:\n\n${text}` });
    return result.text;
  }

  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }

  const summaries: string[] = [];
  for (const chunk of chunks) {
    const result = await complete({ prompt: `Summarize this part of a video transcript:\n\n${chunk}` });
    summaries.push(result.text);
  }

  const combined = summaries.join("\n\n");
  if (combined.length <= chunkSize) {
    return combined;
  }

  const finalResult = await complete({
    prompt: `Synthesize these summaries into a coherent overview:\n\n${combined}`,
  });
  return finalResult.text;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractTarget(message: string): string | undefined {
  const urlMatch = URL_PATTERN.exec(message);
  if (urlMatch) {
    return urlMatch[0];
  }
  const bvMatch = BV_PATTERN.exec(message);
  if (bvMatch?.[1]) {
    return `BV${bvMatch[1]}`;
  }
  return undefined;
}

function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) {
    return "未知";
  }
  const sec = Math.floor(seconds % 60);
  const minutes = Math.floor((seconds / 60) % 60);
  const hours = Math.floor(seconds / 3600);
  if (hours > 0) {
    return `${hours}小时${minutes}分${sec}秒`;
  }
  return `${minutes}分${sec}秒`;
}

function redactCookieValues(text: string, config: ShareLinkConfig | undefined): string {
  if (!config?.bilibiliCookie) {
    return text;
  }
  let result = text;
  if (config.bilibiliCookie.sessdata) {
    result = result.replaceAll(config.bilibiliCookie.sessdata, "[REDACTED]");
  }
  if (config.bilibiliCookie.biliJct) {
    result = result.replaceAll(config.bilibiliCookie.biliJct, "[REDACTED]");
  }
  return result;
}
