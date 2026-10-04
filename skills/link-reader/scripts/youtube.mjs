import { firstUrl, hostMatches, parseJson } from "./shared.mjs";

const HOSTS = ["youtube.com", "youtu.be"];
const VIDEO_ID = /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:[^#\s]*&)?v=|shorts\/|embed\/|live\/))([A-Za-z0-9_-]{11})/;
const ANDROID = { clientName: "ANDROID", clientVersion: "20.10.38", hl: "en" };
const ANDROID_UA = "com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip";
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code) => {
    if (code.startsWith("#x") || code.startsWith("#X")) return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
    if (code.startsWith("#")) return String.fromCodePoint(Number(code.slice(1)));
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

export function parseTimedText(xml) {
  const lines = [];
  for (const match of xml.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)) {
    const text = decodeEntities((match[1] ?? "").replace(/<[^>]+>/g, "")).trim();
    if (text) lines.push(text);
  }
  return lines.join("\n");
}

function pickTrack(tracks) {
  const usable = tracks.filter((track) => track.baseUrl);
  const prefer = (test) => usable.find((track) => test(track) && track.kind !== "asr") ?? usable.find(test);
  return prefer((track) => track.languageCode?.startsWith("zh")) ?? prefer((track) => track.languageCode?.startsWith("en")) ?? usable[0];
}

export const youtube = {
  name: "YouTube",
  hosts: HOSTS,
  match: (text) => hostMatches(firstUrl(text) ?? "", HOSTS) && VIDEO_ID.test(firstUrl(text) ?? ""),
  async read(text, http) {
    const id = VIDEO_ID.exec(firstUrl(text) ?? text)?.[1];
    if (!id) throw new Error("Could not recognise a YouTube video id");
    const reply = parseJson((await http.post(
      "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
      { context: { client: ANDROID }, videoId: id },
      { "User-Agent": ANDROID_UA },
    )).body, "YouTube");
    if (reply.playabilityStatus?.status !== "OK") throw new Error(`YouTube replied: ${reply.playabilityStatus?.reason ?? reply.playabilityStatus?.status ?? "cannot be played"}`);
    const details = reply.videoDetails ?? {};
    const content = {
      platform: "YouTube",
      title: details.title ?? "",
      author: details.author ?? "",
      url: `https://www.youtube.com/watch?v=${id}`,
      durationSeconds: Number(details.lengthSeconds) || undefined,
      description: details.shortDescription,
      cover: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    };
    const track = pickTrack(reply.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []);
    if (!track?.baseUrl || !hostMatches(track.baseUrl, ["youtube.com"])) return content;
    const transcript = parseTimedText((await http.get(track.baseUrl, { "User-Agent": ANDROID_UA })).body);
    if (transcript) { content.text = transcript; content.textKind = "subtitles"; }
    return content;
  },
};
