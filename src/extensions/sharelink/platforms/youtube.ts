/**
 * YouTube 平台适配器
 */

import { BasePlatformAdapter, type VideoMetadata } from "./base.js";
import { getChildLogger } from "../../../utils/logger.js";
import { spawn } from "child_process";
import { existsSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const logger = getChildLogger("sharelink-youtube");

const DEFAULT_SUBTITLE_MAX_LENGTH = 4000;
const MAX_DESCRIPTION_LENGTH = 500;
const AUDIO_DOWNLOAD_TIMEOUT_DEFAULT = 300_000;
const AUDIO_QUALITY = "192";
const SOCKET_TIMEOUT = 30;

const YOUTUBE_URL_PATTERNS = [
  /youtube\.com\/watch\?.*v=([a-zA-Z0-9_-]{11})/,
  /youtu\.be\/([a-zA-Z0-9_-]{11})/,
  /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
  /youtube\.com\/live\/([a-zA-Z0-9_-]{11})/,
];

const SUBTITLE_LANGUAGE_PRIORITY = [
  "zh-Hans",
  "zh-CN",
  "zh-TW",
  "zh-Hant",
  "zh",
  "en",
  "en-US",
  "en-GB",
];

interface YouTubeTimedTextResponse {
  readonly events?: ReadonlyArray<{
    readonly segs?: ReadonlyArray<{ readonly utf8?: string }>;
  }>;
}

interface YtDlpInfo {
  readonly title?: string;
  readonly description?: string;
  readonly duration?: number;
  readonly uploader?: string;
  readonly thumbnail?: string;
}

export class YouTubeAdapter extends BasePlatformAdapter {
  readonly name = "youtube";
  readonly displayName = "YouTube";

  match(url: string): boolean {
    for (const pattern of YOUTUBE_URL_PATTERNS) {
      if (pattern.test(url)) {
        return true;
      }
    }
    if (/^[a-zA-Z0-9_-]{11}$/.test(url)) {
      return true;
    }
    return false;
  }

  extractId(url: string): string | undefined {
    for (const pattern of YOUTUBE_URL_PATTERNS) {
      const match = pattern.exec(url);
      if (match?.[1]) {
        return match[1];
      }
    }
    if (/^[a-zA-Z0-9_-]{11}$/.test(url)) {
      return url;
    }
    return undefined;
  }

  async fetchMetadata(videoId: string): Promise<VideoMetadata | undefined> {
    return this.fetchMetadataViaYtDlp(videoId);
  }

  async fetchSubtitles(videoId: string, maxLength = DEFAULT_SUBTITLE_MAX_LENGTH): Promise<string | undefined> {
    // Try timedtext endpoint first (no external deps)
    const timedText = await this.fetchTimedText(videoId, maxLength);
    if (timedText) {
      return timedText;
    }
    // Fallback to yt-dlp subtitle extraction
    return this.fetchSubtitlesViaYtDlp(videoId, maxLength);
  }

  getVideoUrl(videoId: string): string {
    return `https://www.youtube.com/watch?v=${videoId}`;
  }

  async downloadAudio(videoId: string, timeout = AUDIO_DOWNLOAD_TIMEOUT_DEFAULT): Promise<string | undefined> {
    const binary = await this.resolveYtDlpBinary();
    if (!binary) {
      logger.error("yt-dlp not found in PATH");
      return undefined;
    }

    const videoUrl = this.getVideoUrl(videoId);
    const outputTemplate = join(tmpdir(), `youtube_audio_${videoId}.%(ext)s`);
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
        const expectedPath = join(tmpdir(), `youtube_audio_${videoId}.mp3`);
        if (existsSync(expectedPath)) {
          resolve(expectedPath);
          return;
        }
        try {
          const { readdirSync } = require("fs");
          const files = readdirSync(tmpdir());
          for (const fname of files) {
            if (fname.startsWith(`youtube_audio_${videoId}`)) {
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

  get idLabel(): string {
    return "Video ID";
  }

  // ── timedtext endpoint ─────────────────────────────────────────────

  private async fetchTimedText(videoId: string, maxLength: number): Promise<string | undefined> {
    for (const lang of SUBTITLE_LANGUAGE_PRIORITY) {
      const url = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${lang}&fmt=json3`;
      try {
        const response = await fetch(url, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
              "AppleWebKit/537.36 (KHTML, like Gecko) " +
              "Chrome/120.0.0.0 Safari/537.36",
            Accept: "application/json",
          },
        });
        if (!response.ok) {
          continue;
        }
        const json = (await response.json()) as YouTubeTimedTextResponse;
        const events = json.events ?? [];
        const lines: string[] = [];
        for (const event of events) {
          const segs = event.segs ?? [];
          const text = segs.map((s) => s.utf8 ?? "").join("").trim();
          if (text) {
            lines.push(text);
          }
        }
        let fullText = lines.join("\n");
        if (!fullText) {
          continue;
        }
        if (fullText.length > maxLength) {
          fullText = fullText.slice(0, maxLength) + "\n...(字幕已截断)";
          logger.info({ maxLength }, "YouTube subtitle truncated");
        }
        logger.info({ videoId, lang, length: fullText.length }, "YouTube subtitle fetched via timedtext");
        return fullText;
      } catch (error) {
        logger.debug({ error, videoId, lang }, "Timedtext fetch failed for language");
      }
    }
    return undefined;
  }

  // ── yt-dlp metadata fallback ───────────────────────────────────────

  private async fetchMetadataViaYtDlp(videoId: string): Promise<VideoMetadata | undefined> {
    const binary = await this.resolveYtDlpBinary();
    if (!binary) {
      logger.warn("yt-dlp not found; cannot fetch YouTube metadata");
      return undefined;
    }

    const videoUrl = this.getVideoUrl(videoId);
    const args = [
      "--dump-json",
      "--skip-download",
      "--quiet",
      "--no-warnings",
      videoUrl,
    ];

    return new Promise((resolve) => {
      const proc = spawn(binary, args, { stdio: "pipe" });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      proc.on("error", (error) => {
        logger.error({ error, videoId }, "yt-dlp metadata spawn error");
        resolve(undefined);
      });
      proc.on("close", (code) => {
        if (code !== 0) {
          logger.error({ code, stderr, videoId }, "yt-dlp metadata failed");
          resolve(undefined);
          return;
        }
        try {
          const info = JSON.parse(stdout) as YtDlpInfo;
          resolve({
            videoId,
            title: info.title ?? "",
            platform: this.name,
            description: (info.description ?? "").slice(0, MAX_DESCRIPTION_LENGTH),
            duration: info.duration ?? 0,
            owner: info.uploader ?? "",
            thumbnailUrl: info.thumbnail ?? "",
            extra: {},
          });
        } catch (error) {
          logger.error({ error, videoId }, "Failed to parse yt-dlp metadata JSON");
          resolve(undefined);
        }
      });
    });
  }

  // ── yt-dlp subtitle fallback ───────────────────────────────────────

  private async fetchSubtitlesViaYtDlp(videoId: string, maxLength: number): Promise<string | undefined> {
    const binary = await this.resolveYtDlpBinary();
    if (!binary) {
      return undefined;
    }

    const videoUrl = this.getVideoUrl(videoId);
    const args = [
      "--list-subs",
      "--skip-download",
      "--quiet",
      "--no-warnings",
      videoUrl,
    ];

    return new Promise((resolve) => {
      const proc = spawn(binary, args, { stdio: "pipe" });
      let stdout = "";
      proc.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      proc.on("error", () => resolve(undefined));
      proc.on("close", async (code) => {
        if (code !== 0) {
          resolve(undefined);
          return;
        }
        // Parse available subtitle languages from stdout
        const lines = stdout.split("\n");
        let inAvailable = false;
        const availableLangs: string[] = [];
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("Language") || trimmed.startsWith("---")) {
            inAvailable = true;
            continue;
          }
          if (inAvailable && trimmed.length > 0 && !trimmed.startsWith("(")) {
            const lang = trimmed.split(" ")[0];
            if (lang) {
              availableLangs.push(lang);
            }
          }
        }

        let chosenLang: string | undefined;
        for (const priority of SUBTITLE_LANGUAGE_PRIORITY) {
          if (availableLangs.includes(priority)) {
            chosenLang = priority;
            break;
          }
        }
        if (!chosenLang && availableLangs.length > 0) {
          chosenLang = availableLangs[0];
        }
        if (!chosenLang) {
          resolve(undefined);
          return;
        }

        // Download subtitle
        const subArgs = [
          "--write-sub",
          "--sub-langs", chosenLang,
          "--skip-download",
          "--quiet",
          "--no-warnings",
          "--output", join(tmpdir(), `youtube_sub_${videoId}`),
          videoUrl,
        ];

        const subProc = spawn(binary, subArgs, { stdio: "ignore" });
        subProc.on("error", () => resolve(undefined));
        subProc.on("close", async (subCode) => {
          if (subCode !== 0) {
            resolve(undefined);
            return;
          }
          try {
            const { readFileSync } = await import("fs");
            const subPath = join(tmpdir(), `youtube_sub_${videoId}.${chosenLang}.vtt`);
            if (!existsSync(subPath)) {
              resolve(undefined);
              return;
            }
            const content = readFileSync(subPath, "utf-8");
            // Simple VTT text extraction
            const textLines = content
              .split("\n")
              .map((l) => l.trim())
              .filter((l) => l.length > 0 && !l.startsWith("WEBVTT") && !l.startsWith("NOTE") && !/^\d{2}:/.test(l) && !l.includes("-->"));
            let fullText = textLines.join("\n");
            if (fullText.length > maxLength) {
              fullText = fullText.slice(0, maxLength) + "\n...(字幕已截断)";
            }
            // Clean up subtitle file
            try {
              unlinkSync(subPath);
            } catch {
              // ignore
            }
            resolve(fullText);
          } catch (error) {
            logger.error({ error, videoId }, "Failed to read yt-dlp subtitle");
            resolve(undefined);
          }
        });
      });
    });
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
