import { firstUrl, hostMatches, MOBILE_UA, parseJson } from "./shared.mjs";

const HOSTS = ["xiaohongshu.com", "xhslink.com", "xhslink.cn"];
const NOTE_ID = /\/(?:explore|discovery\/item|note|item)\/([0-9a-f]{24})/;

function findNote(html, id) {
  const raw = /window\.__INITIAL_STATE__\s*=\s*([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (!raw) return undefined;
  const state = parseJson(raw.trim().replace(/;$/, "").replace(/\bundefined\b/g, "null"), "小红书");
  const details = state.note?.noteDetailMap;
  const entry = (id ? details?.[id] : undefined) ?? Object.values(details ?? {}).find((item) => item.note?.title || item.note?.desc);
  return entry?.note ?? state.noteData?.data?.noteData;
}

export const xiaohongshu = {
  name: "小红书",
  hosts: HOSTS,
  match: (text) => hostMatches(firstUrl(text) ?? "", HOSTS),
  async read(text, http) {
    const start = firstUrl(text);
    if (!start) throw new Error("没有找到小红书链接");
    const page = await http.get(start, { "User-Agent": MOBILE_UA });
    const id = NOTE_ID.exec(page.url)?.[1] ?? NOTE_ID.exec(start)?.[1];
    const note = findNote(page.body, id);
    if (!note || !(note.title || note.desc)) throw new Error("小红书没有返回笔记内容（可能需要登录，或链接已失效）");
    const tags = (note.tagList ?? []).map((tag) => tag.name).filter(Boolean);
    const counts = note.interactInfo;
    const extra = [
      ...(note.type === "video" ? ["视频笔记"] : []),
      ...(tags.length ? [`话题 ${tags.join("、")}`] : []),
      ...(counts ? [`点赞 ${counts.likedCount ?? 0}`, `收藏 ${counts.collectedCount ?? 0}`, `评论 ${counts.commentCount ?? 0}`] : []),
    ];
    const body = note.desc?.trim();
    return {
      platform: "小红书",
      title: note.title ?? "",
      author: note.user?.nickName ?? note.user?.nickname ?? "",
      url: id ? `https://www.xiaohongshu.com/explore/${id}` : page.url,
      durationSeconds: note.video?.capa?.duration,
      cover: note.imageList?.[0]?.urlDefault ?? note.imageList?.[0]?.url,
      extra: extra.length ? extra : undefined,
      ...(body ? { text: body, textKind: "正文" } : {}),
    };
  },
};
