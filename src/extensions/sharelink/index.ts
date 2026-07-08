/**
 * ShareLink 扩展入口
 *
 * 注册消息拦截器（自动检测）和工具（供 Agent 调用）。
 */

import type { VexConfig, ShareLinkConfig } from "../../types/index.js";
import type { InboundMessageContext } from "../../types/index.js";
import { registerMessageInterceptor } from "../../pipeline/index.js";
import { getChildLogger } from "../../utils/logger.js";
import { buildShareLinkRegistry } from "./registry-factory.js";
import { PlatformRegistry } from "./platforms/registry.js";
import { BasePlatformAdapter } from "./platforms/base.js";

const logger = getChildLogger("sharelink");

const URL_PATTERN = /https?:\/\/[^\s]+/;
const BV_PATTERN = /(?:bv|BV)([a-zA-Z0-9]{10})/;

interface ShareLinkOwnerState {
  cfg: ShareLinkConfig | undefined;
  registry: PlatformRegistry;
}

// Per-owning-Web-user state. The pipeline interceptor is process-global (one
// registry keyed by name), so it must resolve the owning user's config from the
// message context at call time — registering per user would leave the last
// user's bilibili cookie active for everyone.
const owners = new Map<string, ShareLinkOwnerState>();
const cleanupFns: Array<() => void> = [];
let pipelineRegistered = false;

const OWNER_SENTINEL = "";
function ownerKey(ownerId: string | undefined): string {
  return ownerId ?? OWNER_SENTINEL;
}

function getWebOwnerId(ctx: InboundMessageContext): string | undefined {
  const raw = ctx.raw;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw) || !("__webUserId" in raw)) {
    return undefined;
  }
  const ownerId = (raw as { __webUserId?: unknown }).__webUserId;
  return typeof ownerId === "string" ? ownerId : undefined;
}

/** 初始化 ShareLink 扩展 */
export function initShareLink(config: VexConfig, options?: { ownerId?: string }): void {
  const cfg = config.sharelink;
  logger.debug(
    {
      owner: ownerKey(options?.ownerId),
      responseMode: cfg?.responseMode,
      autoDetect: cfg?.autoDetect,
      hasBilibiliSessdata: Boolean(cfg?.bilibiliCookie?.sessdata),
      hasBilibiliJct: Boolean(cfg?.bilibiliCookie?.biliJct),
    },
    "ShareLink config resolved"
  );

  owners.set(ownerKey(options?.ownerId), { cfg, registry: buildShareLinkRegistry(cfg) });
  registerShareLinkPipeline();
  logger.info({ owner: ownerKey(options?.ownerId), autoDetect: cfg?.autoDetect }, "ShareLink extension initialized");
}

function registerShareLinkPipeline(): void {
  if (pipelineRegistered) return;
  pipelineRegistered = true;
  const unregister = registerMessageInterceptor("sharelink", async (ctx) => {
    const state = owners.get(ownerKey(getWebOwnerId(ctx)));
    if (!state?.cfg?.autoDetect) return null;

    const target = extractTarget(ctx.content);
    if (!target) return null;
    if (!state.registry.match(target)) {
      logger.debug({ target, messageId: ctx.messageId }, "ShareLink auto-detect found unsupported target");
      return null;
    }

    logger.info({ target, senderId: ctx.senderId }, "ShareLink auto-detect triggered");
    const result = await parseTarget(state.registry, state.cfg, target);
    return result ?? null;
  });
  cleanupFns.push(unregister);
}

/** Drop a single owner's ShareLink state when their runtime is torn down. */
export function disposeShareLinkOwner(ownerId: string | undefined): void {
  owners.delete(ownerKey(ownerId));
}

/** Reset all ShareLink registration and per-owner state (tests). */
export function cleanupShareLink(): void {
  for (const fn of cleanupFns) {
    fn();
  }
  cleanupFns.length = 0;
  pipelineRegistered = false;
  owners.clear();
}

/** @internal test-only: read an owner's resolved config. */
export function __getShareLinkOwnerConfigForTest(ownerId: string | undefined): ShareLinkConfig | undefined {
  return owners.get(ownerKey(ownerId))?.cfg;
}

/** 从消息中提取首个 URL 或裸 BV 号 */
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

/** 解析目标并返回输出文本 */
async function parseTarget(
  registry: PlatformRegistry,
  cfg: import("../../types/index.js").ShareLinkConfig | undefined,
  target: string
): Promise<string | undefined> {
  const startedAt = Date.now();
  const adapter = registry.match(target);
  if (!adapter) {
    logger.debug({ target }, "ShareLink parse skipped unsupported target");
    return undefined;
  }

  const resolvedUrl = await adapter.resolveUrl(target);
  const effectiveTarget = resolvedUrl ?? target;
  logger.debug({ target, resolvedUrl, adapter: adapter.name }, "ShareLink target resolved");

  const videoId = adapter.extractId(effectiveTarget);
  if (!videoId) {
    logger.debug({ target, effectiveTarget, adapter: adapter.name }, "ShareLink video id extraction failed");
    return undefined;
  }

  const metadata = await adapter.fetchMetadata(videoId);
  if (!metadata) {
    logger.warn({ target, videoId, adapter: adapter.name, durationMs: Date.now() - startedAt }, "ShareLink metadata fetch failed");
    return "解析失败：无法获取视频信息，可能是链接失效或视频不可访问。";
  }

  const canonicalUrl = adapter.getVideoUrl(videoId);
  const durationText = formatDuration(metadata.duration);
  const responseMode = cfg?.responseMode ?? "detailed";
  const includeDescription = cfg?.includeDescription ?? true;
  const includeCover = cfg?.includeCover ?? true;
  const descriptionMaxLength = cfg?.descriptionMaxLength ?? 120;

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
  const subtitleMaxLength = cfg?.subtitleMaxLength ?? 5000;
  const contentText = await fetchContentWithFallback(adapter, videoId, cfg, subtitleMaxLength);
  if (contentText) {
    lines.push("");
    lines.push("---");
    lines.push("视频内容:");
    lines.push(contentText);
  }

  logger.info(
    {
      target,
      adapter: adapter.name,
      videoId,
      responseMode,
      metadataTitleLength: metadata.title.length,
      hasContentText: Boolean(contentText),
      responseLength: lines.join("\n").length,
      durationMs: Date.now() - startedAt,
    },
    "ShareLink target parsed"
  );
  return lines.join("\n");
}

/** 尝试获取视频内容：先字幕，失败则下载音频并用 STT 转录 */
async function fetchContentWithFallback(
  adapter: import("./platforms/base.js").BasePlatformAdapter,
  videoId: string,
  cfg: import("../../types/index.js").ShareLinkConfig | undefined,
  maxLength: number
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
    cfg?.audioDownloadTimeout ?? 300
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

/** 格式化时长 */
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
