import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { textResult, errorResult, readStringParam } from "../common.js";
import { BilibiliAdapter } from "../../extensions/sharelink/platforms/bilibili.js";
import { YouTubeAdapter } from "../../extensions/sharelink/platforms/youtube.js";
import { PlatformRegistry } from "../../extensions/sharelink/platforms/registry.js";
import { getShareLinkConfig } from "../../extensions/sharelink/config.js";

function createRegistry(): PlatformRegistry {
  const cfg = getShareLinkConfig();
  const cookie = cfg?.bilibiliCookie ?? {};
  const registry = new PlatformRegistry();
  registry.register(new BilibiliAdapter(cookie.sessdata ?? "", cookie.biliJct ?? ""));
  registry.register(new YouTubeAdapter());
  return registry;
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) {
    return "未知";
  }
  const sec = Math.floor(seconds % 60);
  const minutes = Math.floor((seconds / 60) % 60);
  const hours = Math.floor(seconds / 3600);
  return hours > 0 ? `${hours}小时${minutes}分${sec}秒` : `${minutes}分${sec}秒`;
}

async function parseShareLink(target: string): Promise<string> {
  const cfg = getShareLinkConfig();
  const registry = createRegistry();
  const adapter = registry.match(target);
  if (!adapter) {
    throw new Error("Unsupported link. Currently supports Bilibili and YouTube.");
  }

  const resolvedUrl = await adapter.resolveUrl(target);
  const effectiveTarget = resolvedUrl ?? target;
  const videoId = adapter.extractId(effectiveTarget);
  if (!videoId) {
    throw new Error("Could not extract a video id from the link.");
  }

  const metadata = await adapter.fetchMetadata(videoId);
  if (!metadata) {
    throw new Error("Could not fetch video metadata.");
  }

  const responseMode = cfg?.responseMode ?? "detailed";
  const includeDescription = cfg?.includeDescription ?? true;
  const includeCover = cfg?.includeCover ?? true;
  const descriptionMaxLength = cfg?.descriptionMaxLength ?? 120;
  const lines: string[] = ["解析结果"];

  if (responseMode === "simple") {
    lines.push(`标题: ${metadata.title || "(无标题)"}`);
    lines.push(`作者: ${metadata.owner || "(未知)"}`);
    lines.push(`链接: ${adapter.getVideoUrl(videoId)}`);
  } else {
    lines.push(`平台: ${adapter.displayName}`);
    lines.push(`标题: ${metadata.title || "(无标题)"}`);
    lines.push(`作者: ${metadata.owner || "(未知)"}`);
    lines.push(`时长: ${formatDuration(metadata.duration)}`);
    lines.push(`${adapter.idLabel}: ${adapter.formatDisplayId(videoId)}`);
    lines.push(`规范链接: ${adapter.getVideoUrl(videoId)}`);
  }

  if (resolvedUrl && resolvedUrl !== target) {
    lines.push(`原始短链: ${target}`);
  }

  if (includeDescription && metadata.description) {
    const normalized = metadata.description.trim().replace(/\s+/g, " ");
    const description = normalized.length > descriptionMaxLength
      ? `${normalized.slice(0, descriptionMaxLength)}...`
      : normalized;
    lines.push(`简介: ${description}`);
  }

  if (includeCover && metadata.thumbnailUrl) {
    lines.push(`封面: ${metadata.thumbnailUrl}`);
  }

  const subtitles = await adapter.fetchSubtitles(videoId, cfg?.subtitleMaxLength ?? 5000);
  if (subtitles) {
    lines.push("", "---", "视频内容:", subtitles);
  }

  return lines.join("\n");
}

export function createShareLinkTool(): AgentTool {
  return {
    name: "sharelink_parse",
    label: "ShareLink Parse",
    description: "Parse a Bilibili or YouTube share link and return metadata plus subtitles when available.",
    parameters: Type.Object({
      url: Type.String({ description: "Bilibili/YouTube URL, b23.tv short link, BV id, or YouTube video id" }),
    }),
    execute: async (_toolCallId, args) => {
      try {
        const params = args as Record<string, unknown>;
        const url = readStringParam(params, "url", { required: true, label: "url" });
        const result = await parseShareLink(url ?? "");
        return textResult(result);
      } catch (error) {
        return errorResult(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
}

export { parseShareLink };
