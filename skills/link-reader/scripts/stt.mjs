import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { hostMatches, mapLimited } from "./shared.mjs";

const execFileAsync = promisify(execFile);
const CONCURRENCY = 3;
const DEFAULT_CHUNK_MINUTES = 10;
const DEFAULT_MAX_MINUTES = 90;
const MAX_DOWNLOAD_BYTES = 300_000_000;
const AUDIO_HOSTS = ["bilivideo.com", "bilivideo.cn", "akamaized.net", "hdslb.com"];

export async function run(command, args, { signal, timeoutMs = 600_000 } = {}) {
  try {
    await execFileAsync(command, args, { signal, timeout: timeoutMs, maxBuffer: 10_000_000 });
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`没有找到 ${command}，转写音频需要先安装它`);
    const detail = String(error.stderr ?? error.message).trim().split("\n").slice(-3).join(" ");
    throw new Error(`${command} 运行失败：${detail}`);
  }
}

export async function transcribeFile(path, stt, { fetchFn = fetch, signal } = {}) {
  const form = new FormData();
  form.set("file", new Blob([await readFile(path)], { type: "audio/mpeg" }), basename(path));
  form.set("model", stt.model);
  form.set("response_format", "json");
  if (stt.language) form.set("language", stt.language);
  const response = await fetchFn(`${stt.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`, {
    method: "POST",
    headers: stt.apiKey ? { Authorization: `Bearer ${stt.apiKey}` } : {},
    body: form,
    signal: AbortSignal.any([AbortSignal.timeout(300_000), ...(signal ? [signal] : [])]),
  });
  if (!response.ok) throw new Error(`语音转写服务返回 HTTP ${response.status}：${(await response.text()).slice(0, 200)}`);
  const data = await response.json();
  return String(data.text ?? "").trim();
}

async function downloadAudio({ url, headers }, target, { fetchFn = fetch, signal }) {
  if (!url.startsWith("https:") || !hostMatches(url, AUDIO_HOSTS)) throw new Error("音频地址不在允许的域名内");
  const response = await fetchFn(url, { headers, signal: AbortSignal.any([AbortSignal.timeout(600_000), ...(signal ? [signal] : [])]) });
  if (!response.ok || !response.body) throw new Error(`下载音频失败：HTTP ${response.status}`);
  if (Number(response.headers.get("content-length")) > MAX_DOWNLOAD_BYTES) throw new Error("音频文件过大");
  await pipeline(Readable.fromWeb(response.body), createWriteStream(target));
}

/**
 * Gets the audio of a platform video (from the platform's own audio address, or through yt-dlp),
 * re-encodes it to small mono MP3 parts the service accepts and transcribes them in order.
 */
export async function transcribeVideo(content, stt, { runCommand = run, fetchFn, signal } = {}) {
  const maxMinutes = stt.maxMinutes ?? DEFAULT_MAX_MINUTES;
  if (content.durationSeconds && content.durationSeconds > maxMinutes * 60) throw new Error(`视频时长超过 ${maxMinutes} 分钟上限，不转写`);
  const dir = await mkdtemp(join(tmpdir(), "vex-stt-"));
  try {
    if (content.audioSource) {
      await downloadAudio(await content.audioSource(), join(dir, "source.m4a"), { fetchFn, signal });
    } else {
      await runCommand("yt-dlp", ["--no-playlist", "--no-progress", "-q", "-f", "bestaudio/best", "--js-runtimes", "node", "-o", join(dir, "source.%(ext)s"), content.url], { signal });
    }
    const source = (await readdir(dir)).find((name) => name.startsWith("source."));
    if (!source) throw new Error("没有取到音频");
    const chunkSeconds = (stt.chunkMinutes ?? DEFAULT_CHUNK_MINUTES) * 60;
    await runCommand("ffmpeg", ["-v", "error", "-i", join(dir, source), "-vn", "-ac", "1", "-b:a", "48k", "-f", "segment", "-segment_time", String(chunkSeconds), join(dir, "part%03d.mp3")], { signal });
    const parts = (await readdir(dir)).filter((name) => /^part\d+\.mp3$/.test(name)).sort();
    if (!parts.length) throw new Error("没有取到音频");
    const texts = await mapLimited(parts, CONCURRENCY, (name) => transcribeFile(join(dir, name), stt, { fetchFn, signal }));
    return texts.filter(Boolean).join("\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
