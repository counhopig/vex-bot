/**
 * Bilibili（B站）平台适配器
 */

import { BasePlatformAdapter, type VideoMetadata } from "./base.js";
import { getChildLogger } from "../../../utils/logger.js";
import { spawn } from "child_process";
import { existsSync, unlinkSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const logger = getChildLogger("sharelink-bilibili");

const BVID_PATTERN = /(?:bv|BV)([a-zA-Z0-9]{10})/;
const AVID_PATTERN = /(?:av|AV)(\d+)/;

const SHORT_LINK_RESOLVE_TIMEOUT = 10_000;
const REST_API_TIMEOUT = 15_000;
const AUDIO_DOWNLOAD_TIMEOUT_DEFAULT = 300_000;
const AUDIO_QUALITY = "192";
const SOCKET_TIMEOUT = 30;

const BILIBILI_API_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/120.0.0.0 Safari/537.36",
  Referer: "https://www.bilibili.com/",
};

interface BilibiliApiResponse<T = unknown> {
  readonly code: number;
  readonly message?: string;
  readonly data?: T;
}

interface BilibiliVideoInfo {
  readonly title?: string;
  readonly desc?: string;
  readonly duration?: number;
  readonly owner?: { readonly name?: string };
  readonly pic?: string;
  readonly pages?: ReadonlyArray<{ readonly cid: number }>;
}

interface BilibiliSubtitleItem {
  readonly lan?: string;
  readonly subtitle_url?: string;
}

export class BilibiliAdapter extends BasePlatformAdapter {
  readonly name = "bilibili";
  readonly displayName = "B站";

  private readonly sessdata: string;
  private readonly biliJct: string;

  constructor(sessdata = "", biliJct = "") {
    super();
    this.sessdata = sessdata;
    this.biliJct = biliJct;
  }

  get idLabel(): string {
    return "BV号";
  }

  formatDisplayId(videoId: string): string {
    return `BV${videoId}`;
  }

  match(url: string): boolean {
    if (BVID_PATTERN.test(url) || AVID_PATTERN.test(url)) {
      return true;
    }
    try {
      const parsed = new URL(url);
      if (parsed.hostname.includes("bilibili.com") || parsed.hostname.includes("b23.tv")) {
        return true;
      }
    } catch {
      // ignore invalid URL
    }
    return false;
  }

  extractId(url: string): string | undefined {
    const match = BVID_PATTERN.exec(url);
    if (match?.[1]) {
      return match[1];
    }
    return undefined;
  }

  async resolveUrl(url: string): Promise<string | undefined> {
    if (!url.includes("b23.tv")) {
      return undefined;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SHORT_LINK_RESOLVE_TIMEOUT);
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: BILIBILI_API_HEADERS,
        redirect: "follow",
        signal: controller.signal,
      });
      const finalUrl = response.url;
      const bvMatch = BVID_PATTERN.exec(finalUrl);
      if (bvMatch?.[1]) {
        return `https://www.bilibili.com/video/BV${bvMatch[1]}`;
      }
      logger.warn({ finalUrl }, "b23.tv resolve returned unexpected URL");
      return undefined;
    } catch (error) {
      logger.error({ error, url }, "b23.tv resolve failed");
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }

  async fetchMetadata(videoId: string): Promise<VideoMetadata | undefined> {
    return this.fetchMetadataViaRest(videoId);
  }

  async fetchSubtitles(videoId: string, maxLength = 4000): Promise<string | undefined> {
    return this.fetchSubtitlesViaRest(videoId, maxLength);
  }

  getVideoUrl(videoId: string): string {
    return `https://www.bilibili.com/video/BV${videoId}`;
  }

  async downloadAudio(videoId: string, timeout = AUDIO_DOWNLOAD_TIMEOUT_DEFAULT): Promise<string | undefined> {
    const binary = await this.resolveYtDlpBinary();
    if (!binary) {
      logger.error("yt-dlp not found in PATH");
      return undefined;
    }

    const videoUrl = this.getVideoUrl(videoId);
    const outputTemplate = join(tmpdir(), `bilibili_audio_${videoId}.%(ext)s`);
    const args = [
      "--format", "bestaudio/best",
      "--extract-audio",
      "--audio-format", "mp3",
      "--audio-quality", AUDIO_QUALITY,
      "--output", outputTemplate,
      "--restrict-filenames",
      "--quiet",
      "--no-warnings",
      "--socket-timeout", String(SOCKET_TIMEOUT),
      "--add-header", `User-Agent:${BILIBILI_API_HEADERS["User-Agent"]}`,
      "--add-header", `Referer:${BILIBILI_API_HEADERS.Referer}`,
      videoUrl,
    ];

    return new Promise((resolve) => {
      const proc = spawn(binary, args, { stdio: "ignore" });
      const timer = setTimeout(() => {
        proc.kill("SIGTERM");
        logger.error({ videoId, timeout }, "Audio download timeout");
        resolve(undefined);
      }, timeout);

      proc.on("error", (error) => {
        clearTimeout(timer);
        logger.error({ error, videoId }, "Audio download spawn error");
        resolve(undefined);
      });

      proc.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          logger.error({ code, videoId }, "Audio download failed");
          resolve(undefined);
          return;
        }
        const expectedPath = join(tmpdir(), `bilibili_audio_${videoId}.mp3`);
        if (existsSync(expectedPath)) {
          resolve(expectedPath);
          return;
        }
        // Fallback: scan tmpdir for matching prefix
        try {
          const files = readdirSync(tmpdir());
          for (const fname of files) {
            if (fname.startsWith(`bilibili_audio_${videoId}`)) {
              resolve(join(tmpdir(), fname));
              return;
            }
          }
        } catch {
          // ignore
        }
        logger.warn({ videoId }, "Audio download succeeded but file not found");
        resolve(undefined);
      });
    });
  }

  static cleanupAudio(audioPath: string): void {
    if (audioPath && existsSync(audioPath)) {
      try {
        unlinkSync(audioPath);
        logger.debug({ audioPath }, "Cleaned up temporary audio");
      } catch (error) {
        logger.warn({ error, audioPath }, "Failed to clean up audio");
      }
    }
  }

  // ── REST API 实现 ──────────────────────────────────────────────────

  private async fetchMetadataViaRest(videoId: string): Promise<VideoMetadata | undefined> {
    const apiUrl = `https://api.bilibili.com/x/web-interface/view?bvid=${videoId}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REST_API_TIMEOUT);
    try {
      const response = await fetch(apiUrl, {
        headers: { ...BILIBILI_API_HEADERS, Cookie: this.buildCookie() },
        signal: controller.signal,
      });
      if (!response.ok) {
        logger.warn({ status: response.status }, "Bilibili REST API returned non-200");
        return undefined;
      }
      const json = (await response.json()) as BilibiliApiResponse<BilibiliVideoInfo>;
      if (json.code !== 0) {
        logger.warn({ message: json.message }, "Bilibili REST API error");
        return undefined;
      }
      const data = json.data;
      if (!data) {
        return undefined;
      }
      const pages = data.pages ?? [];
      const cid = pages[0]?.cid;
      return {
        videoId,
        title: data.title ?? "",
        platform: this.name,
        description: data.desc ?? "",
        duration: data.duration ?? 0,
        owner: data.owner?.name ?? "",
        thumbnailUrl: data.pic ?? "",
        extra: cid !== undefined ? { cid } : {},
      };
    } catch (error) {
      logger.error({ error, videoId }, "Failed to fetch Bilibili metadata via REST");
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchSubtitlesViaRest(videoId: string, maxLength: number): Promise<string | undefined> {
    const metadata = await this.fetchMetadataViaRest(videoId);
    if (!metadata) {
      return undefined;
    }
    const cid = metadata.extra["cid"] as number | undefined;
    if (!cid) {
      return undefined;
    }

    const playerUrl = `https://api.bilibili.com/x/player/v2?bvid=${videoId}&cid=${cid}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REST_API_TIMEOUT);
    try {
      const response = await fetch(playerUrl, {
        headers: { ...BILIBILI_API_HEADERS, Cookie: this.buildCookie() },
        signal: controller.signal,
      });
      if (!response.ok) {
        return undefined;
      }
      const json = (await response.json()) as BilibiliApiResponse<{
        readonly subtitle?: { readonly subtitles?: ReadonlyArray<BilibiliSubtitleItem> };
      }>;
      if (json.code !== 0) {
        return undefined;
      }
      const subtitles = json.data?.subtitle?.subtitles ?? [];
      if (subtitles.length === 0) {
        return undefined;
      }

      let subtitleUrl = "";
      for (const sub of subtitles) {
        const lang = sub.lan ?? "";
        if (lang.startsWith("zh") || lang.toLowerCase().includes("ai")) {
          subtitleUrl = sub.subtitle_url ?? "";
          break;
        }
      }
      if (!subtitleUrl) {
        subtitleUrl = subtitles[0]?.subtitle_url ?? "";
      }
      if (!subtitleUrl) {
        return undefined;
      }
      if (subtitleUrl.startsWith("//")) {
        subtitleUrl = `https:${subtitleUrl}`;
      }
      return this.downloadAndParseSubtitle(subtitleUrl, maxLength);
    } catch (error) {
      logger.error({ error, videoId }, "Failed to fetch Bilibili subtitles via REST");
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async downloadAndParseSubtitle(subtitleUrl: string, maxLength: number): Promise<string | undefined> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REST_API_TIMEOUT);
    try {
      const response = await fetch(subtitleUrl, {
        headers: BILIBILI_API_HEADERS,
        signal: controller.signal,
      });
      if (!response.ok) {
        return undefined;
      }
      const json = (await response.json()) as { readonly body?: ReadonlyArray<{ readonly content?: string }> };
      const body = json.body ?? [];
      if (body.length === 0) {
        return undefined;
      }
      const lines = body.map((item) => item.content ?? "").filter(Boolean);
      let fullText = lines.join("\n");
      if (!fullText) {
        return undefined;
      }
      if (fullText.length > maxLength) {
        fullText = fullText.slice(0, maxLength) + "\n...(字幕已截断)";
        logger.info({ maxLength }, "Subtitle truncated");
      }
      return fullText;
    } catch (error) {
      logger.error({ error, subtitleUrl }, "Failed to download/parse subtitle");
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildCookie(): string {
    const parts: string[] = [];
    if (this.sessdata) {
      parts.push(`SESSDATA=${this.sessdata}`);
    }
    if (this.biliJct) {
      parts.push(`bili_jct=${this.biliJct}`);
    }
    return parts.join("; ");
  }

  private async resolveYtDlpBinary(): Promise<string | undefined> {
    return new Promise((resolve) => {
      const proc = spawn("which", ["yt-dlp"], { stdio: "pipe" });
      let stdout = "";
      proc.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      proc.on("close", (code) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          resolve(undefined);
        }
      });
      proc.on("error", () => resolve(undefined));
    });
  }
}
