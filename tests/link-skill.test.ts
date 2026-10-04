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
    expect(output).toContain("Platform: Bilibili");
    expect(output).toContain("Title: 测试视频");
    expect(output).toContain("Author: UP主");
    expect(output).toContain("Duration: 1h 2m 5s");
    expect(output).toContain("Original subtitles:\n第一句\n第二句");
    const api = calls.filter((call) => call.url.includes("api.bilibili.com"));
    expect(api.length).toBe(3);
    expect(api.filter((call) => call.init?.headers?.Cookie === "SESSDATA=SESS").length).toBe(2);
    expect(api.find((call) => call.url.includes("/wbi/view"))?.url).toMatch(/w_rid=[0-9a-f]{32}/);
    expect(calls.find((call) => call.url.includes("hdslb.com/zh.json"))?.init?.headers?.Cookie).toBeUndefined();
  });

  it("resolves b23.tv short links and refuses redirects elsewhere", async () => {
    const { request } = fake(bilibiliRoute);
    expect(await run(request, "https://b23.tv/abc", { raw: true })).toContain("Link: https://www.bilibili.com/video/BV1xx411c7mD");
    const hostile = fake((url) => url.hostname === "b23.tv" ? redirect("https://example.com/") : undefined);
    await expect(run(hostile.request, "https://b23.tv/abc")).rejects.toThrow("Access to example.com is not supported");
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
    expect(output).toContain("Title: T");
    expect(output).toContain("Duration: 3m 33s");
    expect(output).toContain("Original subtitles:\nWe're & no strangers\nsecond\nline");
    expect(JSON.parse(calls[0]!.init!.body!)).toMatchObject({ videoId: "dQw4w9WgXcQ", context: { client: { clientName: "ANDROID" } } });
    expect(calls[1]!.url).toContain("lang=en");
    expect(calls[1]!.url).not.toContain("kind=asr");
  });

  it("surfaces an unplayable video and tolerates missing captions", async () => {
    await expect(run(fake(youtubeRoute([], "ERROR")).request, "https://www.youtube.com/watch?v=dQw4w9WgXcQ")).rejects.toThrow("Video unavailable");
    const output = await run(fake(youtubeRoute([])).request, "https://www.youtube.com/shorts/dQw4w9WgXcQ");
    expect(output).toContain("no readable subtitles or text");
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
    expect(output).toContain("Platform: Douyin");
    expect(output).toContain("Author: 猫主人");
    expect(output).toContain("Duration: 0m 15s");
    expect(output).toContain("Description: 今天的猫 #猫");
    expect(output).toContain("More: Likes 10; Comments 2; Saves 3; Shares 1");
    expect(output).toContain("no readable subtitles or text");
  });

  it("reads the share page directly for a work address", async () => {
    const { request, calls } = fake(route);
    expect(await run(request, `https://www.douyin.com/video/${id}`)).toContain("猫主人");
    expect(calls[0]!.url).toBe(`https://www.iesdouyin.com/share/video/${id}/`);
  });

  it("falls back to the share text and page summary, and reports a missing work", async () => {
    const bare = fake((url) => url.hostname === "v.douyin.com" ? redirect(`https://www.iesdouyin.com/share/video/${id}/?x=1`) : ok('<meta name="description" content="于20261003发布在抖音，已经收获了7个喜欢，来抖音，记录美好生活！"/>'));
    const output = await run(bare.request, "5.38 复制打开抖音，看看【yy.的作品】感谢大哥领航😭 甩丢我三次都被我追上了# 京港澳高... https://v.douyin.com/IMJC/ Kws:/ 01/04");
    expect(output).toContain("Author: yy.");
    expect(output).toContain("Description: 感谢大哥领航😭 甩丢我三次都被我追上了# 京港澳高...");
    expect(output).toContain("More: Published 2026-10-03; Likes 7; Note: Douyin's work details need a login");
    await expect(run(fake(() => ok("<html></html>")).request, `https://www.douyin.com/video/${id}`)).rejects.toThrow("returned no content for this work");
  });
});

describe("Xiaohongshu", () => {
  const id = "64a1b2c3d4e5f60718293a4b";
  const state = { note: { noteDetailMap: { [id]: { note: { title: "探店", desc: "今天去了一家咖啡店\n拿铁很好喝", type: "normal", user: { nickName: "小红" }, tagList: [{ name: "咖啡" }], imageList: [{ urlDefault: "https://sns-img.xhscdn.com/1.jpg" }], interactInfo: { likedCount: "12", collectedCount: "3", commentCount: "1" } } } } }, other: undefined };
  const route: Route = (url) => {
    if (url.hostname === "xhslink.com") return redirect(`https://www.xiaohongshu.com/discovery/item/${id}?xsec_token=T`);
    if (url.pathname === `/discovery/item/${id}`) return ok(`<script>window.__INITIAL_STATE__=${JSON.stringify(state).replace("null", "undefined")}</script>`);
    return undefined;
  };

  it("reads the note body and summarises it", async () => {
    const ask = answer();
    const output = await run(fake(route).request, "58 小红 发布了笔记 http://xhslink.com/a/AbCd 复制本条信息", { ask });
    expect(output).toContain("Title: 探店");
    expect(output).toContain("Author: 小红");
    expect(output).toContain("More: Topics 咖啡; Likes 12; Saves 3; Comments 1");
    expect(output).toContain("Summary of the text:\n摘要内容");
    expect(output).toContain(`Link: https://www.xiaohongshu.com/explore/${id}`);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("explains a page without note data", async () => {
    await expect(run(fake(() => ok("<html>请登录</html>")).request, `https://www.xiaohongshu.com/explore/${id}`)).rejects.toThrow("returned no note content");
  });
});

describe("matching", () => {
  it.each([
    ["https://www.bilibili.com/video/BV1xx411c7mD", "Bilibili"],
    ["BV1xx411c7mD", "Bilibili"],
    ["https://b23.tv/abc", "Bilibili"],
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "YouTube"],
    ["https://youtu.be/dQw4w9WgXcQ", "YouTube"],
    ["看 https://v.douyin.com/abc/ 这个", "Douyin"],
    ["http://xhslink.com/a/abc", "Xiaohongshu"],
    ["http://xhslink.cn/o/9H3n6pbqt30", "Xiaohongshu"],
  ])("%s is %s", (input, name) => expect(findPlatform(input)?.name).toBe(name));

  it("ignores other links", async () => {
    expect(findPlatform("https://example.com/video/BV")).toBeUndefined();
    expect(findPlatform("https://www.youtube.com/feed")).toBeUndefined();
    await expect(run(fake(() => undefined).request, "https://example.com")).rejects.toThrow("supported: Bilibili, YouTube, Douyin, Xiaohongshu");
  });
});

describe("summaries", () => {
  it("summarises short text in one call and long text in map and reduce steps", async () => {
    const short = vi.fn(async () => "概要");
    expect(await summarizeText("短字幕", "subtitles", short)).toBe("概要");
    expect(short).toHaveBeenCalledTimes(1);
    const prompts: string[] = [];
    const long = async (prompt: string) => { prompts.push(prompt); return `要点${prompts.length}`; };
    await summarizeText("字".repeat(30_000), "subtitles", long);
    expect(prompts).toHaveLength(5);
    expect(prompts[4]).toContain("[Points from part 4]");
  });

  it("falls back to truncated text when the model fails, and respects summarize=false", async () => {
    const route: Route = (url) => url.hostname === "xhslink.com" ? redirect("https://www.xiaohongshu.com/explore/64a1b2c3d4e5f60718293a4b") : ok(`<script>window.__INITIAL_STATE__={"noteData":{"data":{"noteData":{"title":"T","desc":"${"文".repeat(35_000)}"}}}}</script>`);
    const failing = async () => { throw new Error("模型不可用"); };
    const output = await run(fake(route).request, "http://xhslink.com/a/x", { ask: failing });
    expect(output).toContain("Summary failed: 模型不可用");
    expect(output.match(/文{100,}/)?.[0].length).toBe(20_000);
    const raw = await run(fake(route).request, "http://xhslink.com/a/x", { raw: true });
    expect(raw).toContain("Original text:");
    expect(raw).toContain("truncated; 35000 characters in total");
  });
});

const { transcribeFile, transcribeVideo } = await skill("stt.mjs");
const stt = { baseUrl: "https://stt.example/v1/", model: "whisper-1", apiKey: "KEY", language: "zh" };

const noSubtitles: Route = (url, init) => url.pathname === "/x/player/wbi/v2" ? json({ code: 0, data: { subtitle: { subtitles: [] } } }) : bilibiliRoute(url, init);
const playurl: Route = (url, init) => url.pathname === "/x/player/wbi/playurl"
  ? json({ code: 0, data: { dash: { audio: [{ bandwidth: 134695, baseUrl: "https://upos-hz-mirrorakam.akamaized.net/high.m4a" }, { bandwidth: 68646, baseUrl: "https://upos-sz-mirrorcosov.bilivideo.com/low.m4a" }] } } })
  : noSubtitles(url, init);

describe("speech to text", () => {
  function runner(parts: number) {
    const calls: { command: string; args: string[] }[] = [];
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      calls.push({ command, args });
      const { writeFile } = await import("node:fs/promises");
      if (command === "yt-dlp") {
        const template = args[args.indexOf("-o") + 1]!;
        await writeFile(template.replace("%(ext)s", "webm"), "audio");
      } else {
        const pattern = args.at(-1)!;
        for (let i = 0; i < parts; i++) await writeFile(pattern.replace("%03d", String(i).padStart(3, "0")), `p${i}`);
      }
    });
    return { runCommand, calls };
  }
  const requests: string[] = [];
  const router = vi.fn(async (url: string, init: RequestInit) => {
    requests.push(url);
    if (url.includes("/audio/transcriptions")) return new Response(JSON.stringify({ text: `文字-${((init.body as FormData).get("file") as File).name}` }));
    return new Response(Buffer.from("m4a-bytes"), { headers: { "content-length": "9" } });
  });

  it("posts the audio to an OpenAI compatible endpoint", async () => {
    const { writeFile, mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "stt-test-"));
    await writeFile(join(dir, "part000.mp3"), "bytes");
    const fetchFn = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ text: " 你好 " })));
    expect(await transcribeFile(join(dir, "part000.mp3"), stt, { fetchFn })).toBe("你好");
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://stt.example/v1/audio/transcriptions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer KEY");
    const form = init.body as FormData;
    expect(form.get("model")).toBe("whisper-1");
    expect(form.get("language")).toBe("zh");
    expect((form.get("file") as File).name).toBe("part000.mp3");
    await expect(transcribeFile(join(dir, "part000.mp3"), stt, { fetchFn: async () => new Response("quota", { status: 429 }) })).rejects.toThrow("HTTP 429: quota");
  });

  it("posts Base64 audio to MiMo chat completions", async () => {
    const { writeFile, mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "stt-test-"));
    await writeFile(join(dir, "part000.mp3"), "bytes");
    const fetchFn = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ choices: [{ message: { content: " 你好 " } }] })));
    const mimo = { provider: "mimo", baseUrl: "https://api.xiaomimimo.com/v1", model: "mimo-v2.5-asr", apiKey: "KEY", language: "zh" };
    expect(await transcribeFile(join(dir, "part000.mp3"), mimo, { fetchFn })).toBe("你好");
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://api.xiaomimimo.com/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer KEY");
    expect(JSON.parse(init.body as string)).toEqual({
      model: "mimo-v2.5-asr",
      messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: `data:audio/mpeg;base64,${Buffer.from("bytes").toString("base64")}` } }] }],
      asr_options: { language: "zh" },
    });
  });

  it("downloads through yt-dlp, cuts and transcribes the parts in order, then removes the temporary files", async () => {
    const { runCommand, calls } = runner(3);
    const text = await transcribeVideo({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", durationSeconds: 1500 }, { ...stt, chunkMinutes: 5 }, { runCommand, fetchFn: router });
    expect(text).toBe("文字-part000.mp3\n文字-part001.mp3\n文字-part002.mp3");
    expect(calls[0]!.command).toBe("yt-dlp");
    expect(calls[0]!.args.slice(-1)).toEqual(["https://www.youtube.com/watch?v=dQw4w9WgXcQ"]);
    expect(calls[0]!.args).toEqual(expect.arrayContaining(["--js-runtimes", "node"]));
    expect(calls[1]!.command).toBe("ffmpeg");
    expect(calls[1]!.args).toEqual(expect.arrayContaining(["-segment_time", "300", "-ac", "1", "48k"]));
    const { existsSync } = await import("node:fs");
    expect(existsSync(calls[1]!.args[calls[1]!.args.indexOf("-i") + 1]!.replace(/\/source\..*$/, ""))).toBe(false);
  });

  it("uses a platform audio address instead of yt-dlp and refuses other hosts", async () => {
    const { runCommand, calls } = runner(1);
    const text = await transcribeVideo({ url: "https://x", audioSource: async () => ({ url: "https://upos-sz.bilivideo.com/a.m4a", headers: { Referer: "r" } }) }, stt, { runCommand, fetchFn: router });
    expect(text).toBe("文字-part000.mp3");
    expect(calls.map((call) => call.command)).toEqual(["ffmpeg"]);
    expect(requests).toContain("https://upos-sz.bilivideo.com/a.m4a");
    await expect(transcribeVideo({ url: "https://x", audioSource: async () => ({ url: "https://evil.example/a.m4a", headers: {} }) }, stt, { runCommand, fetchFn: router })).rejects.toThrow("not on an allowed domain");
  });

  it("refuses videos over the length limit and reports a missing program", async () => {
    await expect(transcribeVideo({ url: "https://x", durationSeconds: 100 * 60 }, stt, { runCommand: runner(1).runCommand, fetchFn: router })).rejects.toThrow("90-minute limit");
    await expect(transcribeVideo({ url: "https://x", durationSeconds: 60 }, stt, { runCommand: async () => { throw new Error("yt-dlp was not found; install it to transcribe audio"); }, fetchFn: router })).rejects.toThrow("yt-dlp was not found");
  });

  it("transcribes a Bilibili video without subtitles from its own audio stream and summarises the transcript", async () => {
    const { runCommand, calls } = runner(2);
    const ask = answer();
    const output = await readLink("https://www.bilibili.com/video/BV1xx411c7mD", { fetchPublicPage, request: fake(playurl).request, ask, stt, runCommand, sttFetch: router });
    expect(output).toContain("Summary of the transcript:\n摘要内容");
    expect(ask.mock.calls[0]![0]).toContain("文字-part000.mp3\n文字-part001.mp3");
    expect(calls.map((call) => call.command)).toEqual(["ffmpeg"]);
    expect(requests).toContain("https://upos-sz-mirrorcosov.bilivideo.com/low.m4a");
  });

  it("explains why a subtitle-less video has no text", async () => {
    const unset = await readLink("BV1xx411c7mD", { fetchPublicPage, request: fake(noSubtitles).request, ask: answer() });
    expect(unset).toContain("Speech to text is not configured");
    const failing = await readLink("BV1xx411c7mD", { fetchPublicPage, request: fake(playurl).request, ask: answer(), stt, runCommand: async () => { throw new Error("ffmpeg failed: bad"); }, sttFetch: router });
    expect(failing).toContain("Speech to text failed: ffmpeg failed: bad");
  });
});
