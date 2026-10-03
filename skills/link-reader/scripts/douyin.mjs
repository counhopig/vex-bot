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

export const douyin = {
  name: "抖音",
  hosts: HOSTS,
  match: (text) => hostMatches(firstUrl(text) ?? "", HOSTS),
  async read(text, http) {
    const start = firstUrl(text);
    if (!start) throw new Error("没有找到抖音链接");
    let id = AWEME_ID.exec(start)?.[1];
    if (!id) id = AWEME_ID.exec((await http.get(start, { "User-Agent": MOBILE_UA })).url)?.[1];
    if (!id) throw new Error("没有识别出抖音作品号");

    let item;
    for (const kind of ["video", "note"]) {
      item = findItem((await http.get(`https://www.iesdouyin.com/share/${kind}/${id}/`, { "User-Agent": MOBILE_UA })).body);
      if (item) break;
    }
    if (!item) throw new Error("抖音没有返回作品内容（链接可能已失效）");
    const stats = item.statistics;
    return {
      platform: "抖音",
      title: (item.desc ?? "").split("\n")[0]?.slice(0, 60) ?? "",
      author: item.author?.nickname ?? "",
      url: `https://www.douyin.com/video/${id}`,
      durationSeconds: seconds(item.video?.duration),
      description: item.desc,
      cover: item.video?.cover?.url_list?.[0],
      extra: stats ? [`点赞 ${stats.digg_count ?? 0}`, `评论 ${stats.comment_count ?? 0}`, `收藏 ${stats.collect_count ?? 0}`, `分享 ${stats.share_count ?? 0}`] : undefined,
    };
  },
};
