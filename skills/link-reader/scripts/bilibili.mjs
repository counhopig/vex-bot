import { createHash } from "node:crypto";
import { BROWSER_UA, firstUrl, hostMatches, parseJson } from "./shared.mjs";

const BVID = /BV[0-9A-Za-z]{10}/;
const HOSTS = ["bilibili.com", "b23.tv", "hdslb.com"];
const MIXIN_ORDER = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];

const keyName = (url) => url.slice(url.lastIndexOf("/") + 1, url.lastIndexOf("."));

async function mixinKey(http, headers) {
  const nav = parseJson((await http.get("https://api.bilibili.com/x/web-interface/nav", headers)).body, "Bilibili");
  const images = nav.data?.wbi_img;
  if (!images?.img_url || !images.sub_url) throw new Error("Bilibili returned no signing keys");
  const raw = keyName(images.img_url) + keyName(images.sub_url);
  return MIXIN_ORDER.map((index) => raw[index]).join("").slice(0, 32);
}

export function signWbi(params, mixin, timestamp = Math.floor(Date.now() / 1000)) {
  const all = { ...params, wts: timestamp };
  const query = Object.keys(all).sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(String(all[key]).replace(/[!'()*]/g, ""))}`)
    .join("&");
  return `${query}&w_rid=${createHash("md5").update(query + mixin).digest("hex")}`;
}

function pickSubtitle(tracks) {
  const usable = tracks.filter((track) => track.subtitle_url);
  const chosen = usable.find((track) => track.lan?.startsWith("zh")) ?? usable.find((track) => track.lan?.startsWith("ai-")) ?? usable[0];
  if (!chosen) return undefined;
  return chosen.subtitle_url.startsWith("//") ? `https:${chosen.subtitle_url}` : chosen.subtitle_url;
}

export const bilibili = {
  name: "Bilibili",
  hosts: HOSTS,
  match: (text) => BVID.test(text) || hostMatches(firstUrl(text) ?? "", HOSTS),
  async read(text, http, options) {
    let target = firstUrl(text) ?? text;
    if (!BVID.test(target) && hostMatches(target, ["b23.tv"])) target = (await http.get(target, { "User-Agent": BROWSER_UA })).url;
    const bvid = BVID.exec(target)?.[0];
    if (!bvid) throw new Error("Could not recognise a Bilibili video id (BV number)");

    const headers = { "User-Agent": BROWSER_UA, Referer: "https://www.bilibili.com/" };
    const authed = options.sessdata ? { ...headers, Cookie: `SESSDATA=${options.sessdata}` } : headers;
    const mixin = await mixinKey(http, headers);
    const view = parseJson((await http.get(`https://api.bilibili.com/x/web-interface/wbi/view?${signWbi({ bvid }, mixin)}`, authed)).body, "Bilibili");
    if (view.code !== 0 || !view.data) throw new Error(`Bilibili replied: ${view.message ?? view.code}`);
    const info = view.data;
    const content = {
      platform: "Bilibili",
      title: info.title ?? "",
      author: info.owner?.name ?? "",
      url: `https://www.bilibili.com/video/${bvid}`,
      durationSeconds: info.duration,
      description: info.desc,
      cover: info.pic,
    };
    const cid = info.pages?.[0]?.cid;
    if (!cid) return content;

    content.audioSource = async () => {
      const playurl = parseJson((await http.get(`https://api.bilibili.com/x/player/wbi/playurl?${signWbi({ bvid, cid, fnval: 16, fnver: 0, fourk: 1 }, mixin)}`, authed)).body, "Bilibili");
      const tracks = playurl.data?.dash?.audio ?? [];
      const best = tracks.reduce((chosen, track) => (!chosen || track.bandwidth < chosen.bandwidth ? track : chosen), undefined);
      if (!best?.baseUrl) throw new Error(`Bilibili returned no audio address: ${playurl.message ?? playurl.code}`);
      return { url: best.baseUrl, headers: { "User-Agent": BROWSER_UA, Referer: "https://www.bilibili.com/" } };
    };

    const player = parseJson((await http.get(`https://api.bilibili.com/x/player/wbi/v2?${signWbi({ bvid, cid }, mixin)}`, authed)).body, "Bilibili");
    const subtitleUrl = pickSubtitle(player.data?.subtitle?.subtitles ?? []);
    if (!subtitleUrl || !subtitleUrl.startsWith("https:") || !hostMatches(subtitleUrl, ["hdslb.com", "bilibili.com"])) return content;
    const subtitle = parseJson((await http.get(subtitleUrl, { "User-Agent": BROWSER_UA })).body, "Bilibili subtitles");
    const lines = (subtitle.body ?? []).map((item) => item.content ?? "").filter(Boolean);
    if (lines.length) { content.text = lines.join("\n"); content.textKind = "subtitles"; }
    return content;
  },
};
