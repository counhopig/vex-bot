import { firstUrl, hostMatches, MOBILE_UA, parseJson } from "./shared.mjs";

const HOSTS = ["douyin.com", "iesdouyin.com"];
const AWEME_ID = /(?:\/(?:video|note|slides)\/|modal_id=)(\d{8,})/;

function findItem(html) {
  const raw = /window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*<\/script>/.exec(html)?.[1];
  if (!raw) return undefined;
  const data = parseJson(raw, "抖音");
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
  name: "抖音",
  hosts: HOSTS,
  match: (text) => hostMatches(firstUrl(text) ?? "", HOSTS),
  async read(text, http) {
    const start = firstUrl(text);
    if (!start) throw new Error("没有找到抖音链接");
    let id = AWEME_ID.exec(start)?.[1];
    let page = id ? undefined : await http.get(start, { "User-Agent": MOBILE_UA });
    id ??= AWEME_ID.exec(page.url)?.[1];
    if (!id) throw new Error("没有识别出抖音作品号");
    page ??= await http.get(`https://www.iesdouyin.com/share/video/${id}/`, { "User-Agent": MOBILE_UA });
    const url = `https://www.douyin.com/video/${id}`;

    const item = findItem(page.body);
    if (item) {
      const stats = item.statistics;
      return {
        platform: "抖音",
        title: (item.desc ?? "").split("\n")[0]?.slice(0, 60) ?? "",
        author: item.author?.nickname ?? "",
        url,
        durationSeconds: seconds(item.video?.duration),
        description: item.desc,
        cover: item.video?.cover?.url_list?.[0],
        extra: stats ? [`点赞 ${stats.digg_count ?? 0}`, `评论 ${stats.comment_count ?? 0}`, `收藏 ${stats.collect_count ?? 0}`, `分享 ${stats.share_count ?? 0}`] : undefined,
      };
    }

    // The share page no longer embeds the work; only its publish date and likes remain, so the pasted share text supplies the rest.
    const shared = fromShareText(text);
    const published = PUBLISHED.exec(page.body);
    if (!shared.author && !shared.caption && !published) throw new Error("抖音没有返回作品内容（链接可能已失效）");
    return {
      platform: "抖音",
      title: shared.caption.slice(0, 60) || "（未取得标题）",
      author: shared.author ?? "",
      url,
      description: shared.caption || undefined,
      extra: [
        ...(published ? [`发布于 ${published[1]}-${published[2]}-${published[3]}`, `喜欢 ${published[4]}`] : []),
        "说明：抖音的作品详情需要登录态，只能提供分享文字里的文案和作者，文案可能被截断",
      ],
    };
  },
};
