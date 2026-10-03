import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { PageInit, PageRequest, PageResponse } from "../src/tools/web.js";
import { fetchPublicPage } from "../src/tools/web.js";

const skill = (name: string) => import(pathToFileURL(join(process.cwd(), "skills/link-reader/scripts", name)).href);
const { readLink, findPlatform } = await skill("read.mjs");
const { signWbi } = await skill("bilibili.mjs");
const { decodeEntities, parseTimedText } = await skill("youtube.mjs");
const { summarizeText } = await skill("summarize.mjs");

type Route = (url: URL, init: PageInit | undefined) => PageResponse | undefined;
const ok = (body: string): PageResponse => ({ status: 200, headers: {}, body });
const redirect = (location: string): PageResponse => ({ status: 302, headers: { location }, body: "" });
const json = (value: unknown) => ok(JSON.stringify(value));

function fake(route: Route) {
  const calls: { url: string; init: PageInit | undefined }[] = [];
  const request: PageRequest = async (url, _signal, init) => {
    calls.push({ url: url.href, init });
    const response = route(url, init);
    if (!response) throw new Error(`unexpected request ${url.href}`);
    return response;
  };
  return { request, calls };
}

const answer = () => vi.fn(async (_prompt: string) => "摘要内容");
function run(request: PageRequest, input: string, options: { ask?: (prompt: string) => Promise<string>; raw?: boolean; sessdata?: string } = {}): Promise<string> {
  return readLink(input, { fetchPublicPage, request, ask: options.ask ?? answer(), raw: options.raw, sessdata: options.sessdata });
}

const bilibiliRoute: Route = (url) => {
  if (url.pathname === "/x/web-interface/nav") return json({ data: { wbi_img: { img_url: "https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png", sub_url: "https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png" } } });
  if (url.pathname === "/x/web-interface/wbi/view") return json({ code: 0, data: { title: "测试视频", desc: "简介内容", duration: 3725, pic: "https://i0.hdslb.com/pic.jpg", owner: { name: "UP主" }, pages: [{ cid: 99 }] } });
  if (url.pathname === "/x/player/wbi/v2") return json({ code: 0, data: { subtitle: { subtitles: [{ lan: "en", subtitle_url: "//aisubtitle.hdslb.com/en.json" }, { lan: "ai-zh", subtitle_url: "//aisubtitle.hdslb.com/zh.json" }] } } });
  if (url.hostname === "aisubtitle.hdslb.com") return json({ body: [{ content: url.pathname === "/zh.json" ? "第一句" : "first" }, { content: "第二句" }] });
  if (url.hostname === "b23.tv") return redirect("https://www.bilibili.com/video/BV1xx411c7mD?share_source=copy");
  if (url.hostname === "www.bilibili.com") return ok("<html></html>");
  return undefined;
};

describe("Bilibili", () => {
  it("signs parameters with the mixin key", () => {
    const query = signWbi({ bvid: "BV1", note: "a!b'c(d)e*f" }, "mixin", 1700000000);
    const unsigned = "bvid=BV1&note=abcdef&wts=1700000000";
    expect(query).toBe(`${unsigned}&w_rid=${createHash("md5").update(`${unsigned}mixin`).digest("hex")}`);
  });

  it("reads metadata and the Chinese subtitle, sending the cookie only to the API", async () => {
    const { request, calls } = fake(bilibiliRoute);
    const output = await run(request, "看这个 https://www.bilibili.com/video/BV1xx411c7mD/ 不错", { raw: true, sessdata: "SESS" });
    expect(output).toContain("平台：B站");
    expect(output).toContain("标题：测试视频");
    expect(output).toContain("作者：UP主");
    expect(output).toContain("时长：1小时2分5秒");
    expect(output).toContain("字幕原文：\n第一句\n第二句");
    const api = calls.filter((call) => call.url.includes("api.bilibili.com"));
    expect(api.length).toBe(3);
    expect(api.filter((call) => call.init?.headers?.Cookie === "SESSDATA=SESS").length).toBe(2);
    expect(api.find((call) => call.url.includes("/wbi/view"))?.url).toMatch(/w_rid=[0-9a-f]{32}/);
    expect(calls.find((call) => call.url.includes("hdslb.com/zh.json"))?.init?.headers?.Cookie).toBeUndefined();
  });

  it("resolves b23.tv short links and refuses redirects elsewhere", async () => {
    const { request } = fake(bilibiliRoute);
    expect(await run(request, "https://b23.tv/abc", { raw: true })).toContain("链接：https://www.bilibili.com/video/BV1xx411c7mD");
    const hostile = fake((url) => url.hostname === "b23.tv" ? redirect("https://example.com/") : undefined);
    await expect(run(hostile.request, "https://b23.tv/abc")).rejects.toThrow("不支持访问 example.com");
  });

  it("reports an API error", async () => {
    const { request } = fake((url) => url.pathname.endsWith("/view") ? json({ code: -404, message: "啥都木有" }) : bilibiliRoute(url, undefined));
    await expect(run(request, "BV1xx411c7mD")).rejects.toThrow("啥都木有");
  });
});

const xml = `<?xml version="1.0"?><timedtext format="3"><body><p t="1" d="2">We&#39;re &amp; <s>no</s> strangers</p><p t="3">second&#10;line</p></body></timedtext>`;
const youtubeRoute = (tracks: unknown[], status = "OK"): Route => (url, init) => {
  if (url.pathname === "/youtubei/v1/player") {
    expect(init?.method).toBe("POST");
    return json({ playabilityStatus: { status, reason: "Video unavailable" }, videoDetails: { title: "T", author: "A", lengthSeconds: "213", shortDescription: "D" }, captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks } } });
  }
  if (url.pathname === "/api/timedtext") return ok(url.searchParams.get("lang") === "en" ? xml : "<body></body>");
  return undefined;
};

describe("YouTube", () => {
  it("decodes timed text", () => {
    expect(decodeEntities("a &amp; b &#39;c&#x41; &unknown;")).toBe("a & b 'cA &unknown;");
    expect(parseTimedText(xml)).toBe("We're & no strangers\nsecond\nline");
  });

  it("posts the Android player request and prefers a manual track in the owner's language", async () => {
    const tracks = [{ baseUrl: "https://www.youtube.com/api/timedtext?lang=en&kind=asr", languageCode: "en", kind: "asr" }, { baseUrl: "https://www.youtube.com/api/timedtext?lang=en", languageCode: "en" }];
    const { request, calls } = fake(youtubeRoute(tracks));
    const output = await run(request, "https://youtu.be/dQw4w9WgXcQ?t=5", { raw: true });
    expect(output).toContain("标题：T");
    expect(output).toContain("时长：3分33秒");
    expect(output).toContain("字幕原文：\nWe're & no strangers\nsecond\nline");
    expect(JSON.parse(calls[0]!.init!.body!)).toMatchObject({ videoId: "dQw4w9WgXcQ", context: { client: { clientName: "ANDROID" } } });
    expect(calls[1]!.url).toContain("lang=en");
    expect(calls[1]!.url).not.toContain("kind=asr");
  });

  it("surfaces an unplayable video and tolerates missing captions", async () => {
    await expect(run(fake(youtubeRoute([], "ERROR")).request, "https://www.youtube.com/watch?v=dQw4w9WgXcQ")).rejects.toThrow("Video unavailable");
    const output = await run(fake(youtubeRoute([])).request, "https://www.youtube.com/shorts/dQw4w9WgXcQ");
    expect(output).toContain("没有可读取的字幕或正文");
  });
});

const page = (state: unknown, variable: string) => ok(`<html><script>${variable}=${JSON.stringify(state)}</script></html>`);

describe("Douyin", () => {
  const id = "7300000000000000001";
  const item = { desc: "今天的猫\n#猫", author: { nickname: "猫主人" }, video: { duration: 15000, cover: { url_list: ["https://p.douyinpic.com/c.jpg"] } }, statistics: { digg_count: 10, comment_count: 2, share_count: 1, collect_count: 3 } };
  const route: Route = (url) => {
    if (url.hostname === "v.douyin.com") return redirect(`https://www.iesdouyin.com/share/video/${id}/?region=CN`);
    if (url.pathname === `/share/video/${id}/`) return page({ loaderData: { "video_(id)/page": { videoInfoRes: { item_list: [item] } } } }, "window._ROUTER_DATA ");
    return undefined;
  };

  it("reads a share text with a short link", async () => {
    const output = await run(fake(route).request, "7.43 复制打开抖音 https://v.douyin.com/AbCd/ 看看猫");
    expect(output).toContain("平台：抖音");
    expect(output).toContain("作者：猫主人");
    expect(output).toContain("时长：0分15秒");
    expect(output).toContain("简介：今天的猫 #猫");
    expect(output).toContain("其他：点赞 10；评论 2；收藏 3；分享 1");
    expect(output).toContain("没有可读取的字幕或正文");
  });

  it("falls back to the note page and reports a missing work", async () => {
    const note: Route = (url) => url.pathname.startsWith("/share/note/") ? page({ loaderData: { x: { videoInfoRes: { item_list: [item] } } } }, "window._ROUTER_DATA ") : ok("<html></html>");
    expect(await run(fake(note).request, `https://www.douyin.com/note/${id}`)).toContain("猫主人");
    await expect(run(fake(() => ok("<html></html>")).request, `https://www.douyin.com/video/${id}`)).rejects.toThrow("没有返回作品内容");
  });
});

describe("Xiaohongshu", () => {
  const id = "64a1b2c3d4e5f60718293a4b";
  const state = { note: { noteDetailMap: { [id]: { note: { title: "探店", desc: "今天去了一家咖啡店\n拿铁很好喝", type: "normal", user: { nickname: "小红" }, tagList: [{ name: "咖啡" }], imageList: [{ urlDefault: "https://sns-img.xhscdn.com/1.jpg" }], interactInfo: { likedCount: "12", collectedCount: "3", commentCount: "1" } } } } }, other: undefined };
  const route: Route = (url) => {
    if (url.hostname === "xhslink.com") return redirect(`https://www.xiaohongshu.com/discovery/item/${id}?xsec_token=T`);
    if (url.pathname === `/discovery/item/${id}`) return ok(`<script>window.__INITIAL_STATE__=${JSON.stringify(state).replace("null", "undefined")}</script>`);
    return undefined;
  };

  it("reads the note body and summarises it", async () => {
    const ask = answer();
    const output = await run(fake(route).request, "58 小红 发布了笔记 http://xhslink.com/a/AbCd 复制本条信息", { ask });
    expect(output).toContain("标题：探店");
    expect(output).toContain("作者：小红");
    expect(output).toContain("其他：话题 咖啡；点赞 12；收藏 3；评论 1");
    expect(output).toContain("正文摘要：\n摘要内容");
    expect(output).toContain(`链接：https://www.xiaohongshu.com/explore/${id}`);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("explains a page without note data", async () => {
    await expect(run(fake(() => ok("<html>请登录</html>")).request, `https://www.xiaohongshu.com/explore/${id}`)).rejects.toThrow("没有返回笔记内容");
  });
});

describe("matching", () => {
  it.each([
    ["https://www.bilibili.com/video/BV1xx411c7mD", "B站"],
    ["BV1xx411c7mD", "B站"],
    ["https://b23.tv/abc", "B站"],
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "YouTube"],
    ["https://youtu.be/dQw4w9WgXcQ", "YouTube"],
    ["看 https://v.douyin.com/abc/ 这个", "抖音"],
    ["http://xhslink.com/a/abc", "小红书"],
  ])("%s is %s", (input, name) => expect(findPlatform(input)?.name).toBe(name));

  it("ignores other links", async () => {
    expect(findPlatform("https://example.com/video/BV")).toBeUndefined();
    expect(findPlatform("https://www.youtube.com/feed")).toBeUndefined();
    await expect(run(fake(() => undefined).request, "https://example.com")).rejects.toThrow("目前支持：B站、YouTube、抖音、小红书");
  });
});

describe("summaries", () => {
  it("summarises short text in one call and long text in map and reduce steps", async () => {
    const short = vi.fn(async () => "概要");
    expect(await summarizeText("短字幕", "字幕", short)).toBe("概要");
    expect(short).toHaveBeenCalledTimes(1);
    const prompts: string[] = [];
    const long = async (prompt: string) => { prompts.push(prompt); return `要点${prompts.length}`; };
    await summarizeText("字".repeat(30_000), "字幕", long);
    expect(prompts).toHaveLength(5);
    expect(prompts[4]).toContain("【第 4 部分要点】");
  });

  it("falls back to truncated text when the model fails, and respects summarize=false", async () => {
    const route: Route = (url) => url.hostname === "xhslink.com" ? redirect("https://www.xiaohongshu.com/explore/64a1b2c3d4e5f60718293a4b") : ok(`<script>window.__INITIAL_STATE__={"noteData":{"data":{"noteData":{"title":"T","desc":"${"文".repeat(35_000)}"}}}}</script>`);
    const failing = async () => { throw new Error("模型不可用"); };
    const output = await run(fake(route).request, "http://xhslink.com/a/x", { ask: failing });
    expect(output).toContain("摘要失败：模型不可用");
    expect(output.match(/文{100,}/)?.[0].length).toBe(20_000);
    const raw = await run(fake(route).request, "http://xhslink.com/a/x", { raw: true });
    expect(raw).toContain("正文原文：");
    expect(raw).toContain("已截断，共 35000 字");
  });
});
