import { firstUrl, hostMatches, MOBILE_UA, parseJson } from "./shared.mjs";

const HOSTS = ["xiaohongshu.com", "xhslink.com", "xhslink.cn"];
const NOTE_ID = /\/(?:explore|discovery\/item|note|item)\/([0-9a-f]{24})/;

function findNote(html, id) {
  const raw = /window\.__INITIAL_STATE__\s*=\s*([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (!raw) return undefined;
  const state = parseJson(raw.trim().replace(/;$/, "").replace(/\bundefined\b/g, "null"), "Xiaohongshu");
  const details = state.note?.noteDetailMap;
  const entry = (id ? details?.[id] : undefined) ?? Object.values(details ?? {}).find((item) => item.note?.title || item.note?.desc);
  return entry?.note ?? state.noteData?.data?.noteData;
}

export const xiaohongshu = {
  name: "Xiaohongshu",
  hosts: HOSTS,
  match: (text) => hostMatches(firstUrl(text) ?? "", HOSTS),
  async read(text, http) {
    const start = firstUrl(text);
    if (!start) throw new Error("No Xiaohongshu link was found");
    const page = await http.get(start, { "User-Agent": MOBILE_UA });
    const id = NOTE_ID.exec(page.url)?.[1] ?? NOTE_ID.exec(start)?.[1];
    const note = findNote(page.body, id);
    if (!note || !(note.title || note.desc)) throw new Error("Xiaohongshu returned no note content (a login may be required, or the link has expired)");
    const tags = (note.tagList ?? []).map((tag) => tag.name).filter(Boolean);
    const counts = note.interactInfo;
    const extra = [
      ...(note.type === "video" ? ["Video note"] : []),
      ...(tags.length ? [`Topics ${tags.join(", ")}`] : []),
      ...(counts ? [`Likes ${counts.likedCount ?? 0}`, `Saves ${counts.collectedCount ?? 0}`, `Comments ${counts.commentCount ?? 0}`] : []),
    ];
    const body = note.desc?.trim();
    return {
      platform: "Xiaohongshu",
      title: note.title ?? "",
      author: note.user?.nickName ?? note.user?.nickname ?? "",
      url: id ? `https://www.xiaohongshu.com/explore/${id}` : page.url,
      durationSeconds: note.video?.capa?.duration,
      cover: note.imageList?.[0]?.urlDefault ?? note.imageList?.[0]?.url,
      extra: extra.length ? extra : undefined,
      ...(body ? { text: body, textKind: "text" } : {}),
    };
  },
};
