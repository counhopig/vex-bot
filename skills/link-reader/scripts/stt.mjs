import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { hostMatches, importCompiled, mapLimited } from "./shared.mjs";

const execFileAsync = promisify(execFile);
const CONCURRENCY = 3;
const DEFAULT_CHUNK_MINUTES = 10;
// MiMo accepts at most 10 MB of Base64 audio per request; 15 minutes at 48 kbps stays under it.
const MIMO_MAX_CHUNK_MINUTES = 15;
const DEFAULT_MAX_MINUTES = 90;
const MAX_DOWNLOAD_BYTES = 300_000_000;
const MAX_REDIRECTS = 5;
const AUDIO_HOSTS = ["bilivideo.com", "bilivideo.cn", "akamaized.net", "hdslb.com"];

export async function run(command, args, { signal, timeoutMs = 600_000 } = {}) {
  try {
    await execFileAsync(command, args, { signal, timeout: timeoutMs, maxBuffer: 10_000_000 });
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`${command} was not found; install it to transcribe audio`);
    const detail = String(error.stderr ?? error.message).trim().split("\n").slice(-3).join(" ");
    throw new Error(`${command} failed: ${detail}`);
  }
}

export async function transcribeFile(path, stt, options = {}) {
  return stt.provider === "mimo" ? transcribeMimo(path, stt, options) : transcribeOpenAI(path, stt, options);
}

async function post(url, stt, body, headers, { fetchFn = fetch, signal }) {
  const response = await fetchFn(url, {
    method: "POST",
    headers: { ...headers, ...(stt.apiKey ? { Authorization: `Bearer ${stt.apiKey}` } : {}) },
    body,
    signal: AbortSignal.any([AbortSignal.timeout(300_000), ...(signal ? [signal] : [])]),
  });
  if (!response.ok) throw new Error(`The speech-to-text service returned HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return response.json();
}

const endpoint = (stt, path) => `${stt.baseUrl.replace(/\/+$/, "")}${path}`;

async function transcribeOpenAI(path, stt, options) {
  const form = new FormData();
  form.set("file", new Blob([await readFile(path)], { type: "audio/mpeg" }), basename(path));
  form.set("model", stt.model);
  form.set("response_format", "json");
  if (stt.language) form.set("language", stt.language);
  const data = await post(endpoint(stt, "/audio/transcriptions"), stt, form, {}, options);
  return String(data.text ?? "").trim();
}

async function transcribeMimo(path, stt, options) {
  const audio = (await readFile(path)).toString("base64");
  const body = {
    model: stt.model,
    messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: `data:audio/mpeg;base64,${audio}` } }] }],
    ...(stt.language ? { asr_options: { language: stt.language } } : {}),
  };
  const data = await post(endpoint(stt, "/chat/completions"), stt, JSON.stringify(body), { "Content-Type": "application/json" }, options);
  return String(data.choices?.[0]?.message?.content ?? "").trim();
}

function assertAudioUrl(url) {
  if (url.protocol !== "https:" || url.username || url.password || !hostMatches(url.href, AUDIO_HOSTS)) {
    throw new Error("The audio address is not on an allowed domain");
  }
}

/** One HTTPS request whose connection only reaches public addresses, checked at connect time like web pages. */
async function openPublic(url, headers, signal) {
  const { resolvePublicAddresses } = await importCompiled("tools/web.js");
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, {
      headers,
      signal,
      agent: false,
      lookup(hostname, options, callback) {
        resolvePublicAddresses(hostname).then((addresses) => {
          const family = typeof options === "object" ? options.family : options;
          const chosen = addresses.find((item) => !family || item.family === family);
          if (!chosen) throw new Error("DNS returned no usable address");
          if (typeof options === "object" && options.all) callback(null, addresses);
          else callback(null, chosen.address, chosen.family);
        }).catch((error) => callback(error, "", 4));
      },
    }, (response) => resolve({ status: response.statusCode ?? 0, location: response.headers.location, body: response }));
    request.on("error", reject);
    request.end();
  });
}

async function openWith(fetchFn, url, headers, signal) {
  const response = await fetchFn(url.href, { headers, redirect: "manual", signal });
  return { status: response.status, location: response.headers.get("location") ?? undefined, body: response.body ? Readable.fromWeb(response.body) : undefined };
}

/**
 * Downloads platform audio with the same boundaries as page reads: every redirect hop must
 * be HTTPS on an allowed host, and the byte limit is enforced on the data actually received.
 */
async function downloadAudio({ url, headers }, target, { fetchFn, signal, maxBytes = MAX_DOWNLOAD_BYTES }) {
  const timed = AbortSignal.any([AbortSignal.timeout(600_000), ...(signal ? [signal] : [])]);
  let address = new URL(url);
  for (let redirects = 0; ; redirects++) {
    assertAudioUrl(address);
    const response = fetchFn ? await openWith(fetchFn, address, headers, timed) : await openPublic(address, headers, timed);
    if (response.status >= 300 && response.status < 400 && response.location) {
      response.body?.destroy?.();
      if (redirects >= MAX_REDIRECTS) throw new Error(`The audio address redirected more than ${MAX_REDIRECTS} times`);
      address = new URL(response.location, address);
      continue;
    }
    if (response.status < 200 || response.status >= 300 || !response.body) {
      response.body?.destroy?.();
      throw new Error(`Downloading the audio failed: HTTP ${response.status}`);
    }
    let received = 0;
    await pipeline(response.body, async function* limit(source) {
      for await (const chunk of source) {
        received += chunk.length;
        if (received > maxBytes) throw new Error("The audio file is too large");
        yield chunk;
      }
    }, createWriteStream(target), { signal: timed });
    return;
  }
}

/**
 * Gets the audio of a platform video (from the platform's own audio address, or through yt-dlp),
 * re-encodes it to small mono MP3 parts the service accepts and transcribes them in order.
 */
export async function transcribeVideo(content, stt, { runCommand = run, fetchFn, signal, maxDownloadBytes = MAX_DOWNLOAD_BYTES } = {}) {
  const maxMinutes = stt.maxMinutes ?? DEFAULT_MAX_MINUTES;
  if (content.durationSeconds && content.durationSeconds > maxMinutes * 60) throw new Error(`The video is longer than the ${maxMinutes}-minute limit and is not transcribed`);
  const dir = await mkdtemp(join(tmpdir(), "vex-stt-"));
  try {
    if (content.audioSource) {
      await downloadAudio(await content.audioSource(), join(dir, "source.m4a"), { fetchFn, signal, maxBytes: maxDownloadBytes });
    } else {
      await runCommand("yt-dlp", ["--no-playlist", "--no-progress", "-q", "-f", "bestaudio/best", "--max-filesize", String(maxDownloadBytes), "--js-runtimes", "node", "-o", join(dir, "source.%(ext)s"), content.url], { signal });
    }
    const source = (await readdir(dir)).find((name) => name.startsWith("source."));
    if (!source) throw new Error("No audio was obtained");
    // yt-dlp skips files it knows are too large; this also catches a size it could not know in advance.
    if ((await stat(join(dir, source))).size > maxDownloadBytes) throw new Error("The audio file is too large");
    const chunkMinutes = stt.chunkMinutes ?? DEFAULT_CHUNK_MINUTES;
    const chunkSeconds = (stt.provider === "mimo" ? Math.min(chunkMinutes, MIMO_MAX_CHUNK_MINUTES) : chunkMinutes) * 60;
    await runCommand("ffmpeg", ["-v", "error", "-i", join(dir, source), "-vn", "-ac", "1", "-b:a", "48k", "-f", "segment", "-segment_time", String(chunkSeconds), join(dir, "part%03d.mp3")], { signal });
    const parts = (await readdir(dir)).filter((name) => /^part\d+\.mp3$/.test(name)).sort();
    if (!parts.length) throw new Error("No audio was obtained");
    const texts = await mapLimited(parts, CONCURRENCY, (name) => transcribeFile(join(dir, name), stt, { fetchFn, signal }));
    return texts.filter(Boolean).join("\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
