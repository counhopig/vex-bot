import { firstUrl, hostMatches, MOBILE_UA, parseJson } from "./shared.mjs";

const HOSTS = ["douyin.com", "iesdouyin.com"];
const AWEME_ID = /(?:\/(?:video|note|slides)\/|modal_id=)(\d{8,})/;

function findItem(html) {
  const raw = /window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*<\/script>/.exec(html)?.[1];
  if (!raw) return undefined;
  const data = parseJson(raw, "Douyin");
  for (const page of Object.values(data.loaderData ?? {})) {
    const item = page?.videoInfoRes?.item_list?.[0];
    if (item) return item;
  }
  return undefined;
}

const seconds = (duration) => (duration ? Math.round(duration > 3600 ? duration / 1000 : duration) : undefined);

const PUBLISHED = /于(\d{4})(\d{2})(\d{2})发布在抖音，已经收获了(\d+)个喜欢/;

function fromShareText(text) {
  const author = /【(.+?)的作品】/.exec(text)?.[1];
  const url = firstUrl(text);
  const before = url ? text.slice(0, text.indexOf(url)) : text;
  const caption = author ? before.slice(before.indexOf("】") + 1).trim() : "";
  return { author, caption };
}

export const douyin = {
  name: "Douyin",
  hosts: HOSTS,
  match: (text) => hostMatches(firstUrl(text) ?? "", HOSTS),
  async read(text, http) {
    const start = firstUrl(text);
    if (!start) throw new Error("No Douyin link was found");
    let id = AWEME_ID.exec(start)?.[1];
    let page = id ? undefined : await http.get(start, { "User-Agent": MOBILE_UA });
    id ??= AWEME_ID.exec(page.url)?.[1];
    if (!id) throw new Error("Could not recognise a Douyin work id");
    page ??= await http.get(`https://www.iesdouyin.com/share/video/${id}/`, { "User-Agent": MOBILE_UA });
    const url = `https://www.douyin.com/video/${id}`;

    const item = findItem(page.body);
    if (item) {
      const stats = item.statistics;
      return {
        platform: "Douyin",
        title: (item.desc ?? "").split("\n")[0]?.slice(0, 60) ?? "",
        author: item.author?.nickname ?? "",
        url,
        durationSeconds: seconds(item.video?.duration),
        description: item.desc,
        cover: item.video?.cover?.url_list?.[0],
        extra: stats ? [`Likes ${stats.digg_count ?? 0}`, `Comments ${stats.comment_count ?? 0}`, `Saves ${stats.collect_count ?? 0}`, `Shares ${stats.share_count ?? 0}`] : undefined,
      };
    }

    // The share page no longer embeds the work; only its publish date and likes remain, so the pasted share text supplies the rest.
    const shared = fromShareText(text);
    const published = PUBLISHED.exec(page.body);
    if (!shared.author && !shared.caption && !published) throw new Error("Douyin returned no content for this work (the link may have expired)");
    return {
      platform: "Douyin",
      title: shared.caption.slice(0, 60) || "(no title available)",
      author: shared.author ?? "",
      url,
      description: shared.caption || undefined,
      extra: [
        ...(published ? [`Published ${published[1]}-${published[2]}-${published[3]}`, `Likes ${published[4]}`] : []),
        "Note: Douyin's work details need a login, so only the author and caption from the share text are available, and the caption may be cut",
      ],
    };
  },
};
