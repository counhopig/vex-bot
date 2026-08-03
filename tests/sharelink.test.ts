/**
 * ShareLink tool + interceptor tests.
 *
 * Covers: bilibili/youtube parsing, simple/detailed modes, interceptor
 * pass-through, autoDetect gating, LLM summarization fallback, cookie
 * redaction, short-content threshold, and instance isolation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { InboundMessageContext } from "../src/channels/ChannelAdapter.js";

vi.mock("child_process", async (importOriginal) => {
  const mod = await importOriginal<typeof import("child_process")>();
  return {
    ...mod,
    spawn: vi.fn(),
  };
});

import * as childProcess from "child_process";
import { BilibiliAdapter } from "../src/tools/builtin/sharelink/platforms/bilibili.js";

// Lazy-load the module under test so vi.stubGlobal takes effect before import.
async function loadModule() {
  return import("../src/tools/builtin/sharelink/index.js");
}

describe("sharelink", () => {
  let module: Awaited<ReturnType<typeof loadModule>>;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    module = await loadModule();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  function setupFetchMocks(
    ...responses: Array<{ urlPattern: RegExp; response: () => Response }>
  ) {
    mockFetch.mockImplementation((url: string) => {
      for (const { urlPattern, response } of responses) {
        if (urlPattern.test(url)) {
          return Promise.resolve(response());
        }
      }
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    });
  }

  it("rejects lookalike b23.tv hosts before fetching", async () => {
    const adapter = new BilibiliAdapter();
    expect(adapter.match("https://b23.tv.attacker.example/abc")).toBe(false);
    expect(await adapter.resolveUrl("https://b23.tv.attacker.example/abc")).toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("blocks b23.tv redirects to non-Bilibili hosts", async () => {
    mockFetch.mockResolvedValue(new Response(null, {
      status: 302,
      headers: { location: "https://attacker.example/internal" },
    }));
    const adapter = new BilibiliAdapter();
    expect(await adapter.resolveUrl("https://b23.tv/abc")).toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  function mockYtDlp(metadataJson?: string) {
    const mockedSpawn = vi.mocked(childProcess.spawn);
    mockedSpawn.mockImplementation(
      (command: string, args: readonly string[], _options: object) => {
        const isWhich = command === "which" && args[0] === "yt-dlp";
        const isYtDlp = command === "yt-dlp" || (isWhich ? false : command.includes("yt-dlp"));

        const mockProc = {
          stdout: {
            on: vi.fn((event: string, cb: (chunk: Buffer) => void) => {
              if (event === "data") {
                if (isWhich) {
                  cb(Buffer.from("/usr/bin/yt-dlp\n"));
                } else if (isYtDlp && args.includes("--dump-json") && metadataJson) {
                  cb(Buffer.from(metadataJson));
                }
              }
            }),
          },
          stderr: {
            on: vi.fn((event: string, cb: (chunk: Buffer) => void) => {
              if (event === "data") {
                cb(Buffer.from(""));
              }
            }),
          },
          on: vi.fn((event: string, cb: unknown) => {
            if (event === "error") {
              // no error
            } else if (event === "close") {
              setTimeout(() => {
                (cb as (code: number) => void)(0);
              }, 0);
            }
          }),
          kill: vi.fn(),
        } as unknown as childProcess.ChildProcess;

        return mockProc;
      },
    );
  }

  function makeCtx(content: string): InboundMessageContext {
    return {
      channelId: "webchat",
      messageId: "msg-1",
      chatId: "chat-1",
      chatType: "direct",
      senderId: "user-1",
      content,
      timestamp: Date.now(),
    };
  }

  // -----------------------------------------------------------------------
  // (a) bilibili URL parses in simple mode
  // -----------------------------------------------------------------------

  it("bilibili URL parses in simple mode", async () => {
    setupFetchMocks(
      {
        urlPattern: /api\.bilibili\.com\/x\/web-interface\/view/,
        response: () => new Response(
          JSON.stringify({
            code: 0,
            data: {
              title: "Test Bilibili Video",
              desc: "A test description",
              duration: 125,
              owner: { name: "TestUP" },
              pic: "https://example.com/pic.jpg",
              pages: [{ cid: 123456 }],
            },
          }),
          { status: 200 },
        ),
      },
      {
        urlPattern: /api\.bilibili\.com\/x\/player\/v2/,
        response: () => new Response(
          JSON.stringify({
            code: 0,
            data: {
              subtitle: {
                subtitles: [
                  { lan: "zh-CN", subtitle_url: "https://example.com/sub.json" },
                ],
              },
            },
          }),
          { status: 200 },
        ),
      },
      {
        urlPattern: /example\.com\/sub\.json/,
        response: () => new Response(
          JSON.stringify({
            body: [
              { content: "First line of subtitle." },
              { content: "Second line of subtitle." },
            ],
          }),
          { status: 200 },
        ),
      },
    );

    const tool = module.createShareLinkTool({
      config: {
        responseMode: "simple",
        includeDescription: false,
        includeCover: false,
        subtitleMaxLength: 5000,
      },
    });

    const result = await tool.execute("call-1", { url: "https://www.bilibili.com/video/BV1xx411c7mD" });
    expect(result.isError).toBe(false);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("解析结果");
    expect(text).toContain("标题: Test Bilibili Video");
    expect(text).toContain("作者: TestUP");
    expect(text).toContain("链接: https://www.bilibili.com/video/BV1xx411c7mD");
    expect(text).toContain("视频内容:");
    expect(text).toContain("First line of subtitle.");
  });

  // -----------------------------------------------------------------------
  // (b) youtube URL parses in detailed mode
  // -----------------------------------------------------------------------

  it("youtube URL parses in detailed mode", async () => {
    mockYtDlp(
      JSON.stringify({
        title: "Test YouTube Video",
        description: "A test description for YouTube",
        duration: 240,
        uploader: "TestChannel",
        thumbnail: "https://example.com/yt-thumb.jpg",
      }),
    );

    setupFetchMocks(
      {
        urlPattern: /youtube\.com\/api\/timedtext/,
        response: () => new Response(
          JSON.stringify({
            events: [
              { segs: [{ utf8: "Hello from YouTube." }] },
              { segs: [{ utf8: "Second segment here." }] },
            ],
          }),
          { status: 200 },
        ),
      },
    );

    const tool = module.createShareLinkTool({
      config: {
        responseMode: "detailed",
        includeDescription: true,
        includeCover: true,
        descriptionMaxLength: 120,
        subtitleMaxLength: 5000,
      },
    });

    const result = await tool.execute("call-1", { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
    expect(result.isError).toBe(false);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("解析结果");
    expect(text).toContain("平台: YouTube");
    expect(text).toContain("Video ID: dQw4w9WgXcQ");
    expect(text).toContain("规范链接: https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(text).toContain("视频内容:");
    expect(text).toContain("Hello from YouTube.");
  });

  // -----------------------------------------------------------------------
  // (c) interceptor returns null for a plain non-link message
  // -----------------------------------------------------------------------

  it("interceptor returns null for a plain non-link message", async () => {
    const interceptor = module.createShareLinkInterceptor({
      config: { autoDetect: true },
    });
    const result = await interceptor(makeCtx("Hello, how are you today?"));
    expect(result).toBeNull();
  });

  // -----------------------------------------------------------------------
  // (d) interceptor returns null when autoDetect is false
  // -----------------------------------------------------------------------

  it("interceptor returns null when autoDetect is false", async () => {
    setupFetchMocks(
      {
        urlPattern: /api\.bilibili\.com\/x\/web-interface\/view/,
        response: () => new Response(
          JSON.stringify({
            code: 0,
            data: {
              title: "Test",
              desc: "",
              duration: 60,
              owner: { name: "UP" },
              pic: "",
              pages: [{ cid: 1 }],
            },
          }),
          { status: 200 },
        ),
      },
      {
        urlPattern: /api\.bilibili\.com\/x\/player\/v2/,
        response: () => new Response(
          JSON.stringify({ code: 0, data: { subtitle: { subtitles: [] } } }),
          { status: 200 },
        ),
      },
    );

    const interceptor = module.createShareLinkInterceptor({
      config: { autoDetect: false },
    });
    const result = await interceptor(makeCtx("Check out https://www.bilibili.com/video/BV1xx411c7mD"));
    expect(result).toBeNull();
  });

  // -----------------------------------------------------------------------
  // (e) LLM fallback path when no complete injected
  // -----------------------------------------------------------------------

  it("LLM fallback path when no complete injected", async () => {
    setupFetchMocks(
      {
        urlPattern: /api\.bilibili\.com\/x\/web-interface\/view/,
        response: () => new Response(
          JSON.stringify({
            code: 0,
            data: {
              title: "Long Video",
              desc: "",
              duration: 3600,
              owner: { name: "UP" },
              pic: "",
              pages: [{ cid: 1 }],
            },
          }),
          { status: 200 },
        ),
      },
      {
        urlPattern: /api\.bilibili\.com\/x\/player\/v2/,
        response: () => new Response(
          JSON.stringify({
            code: 0,
            data: {
              subtitle: {
                subtitles: [
                  { lan: "zh-CN", subtitle_url: "https://example.com/long.json" },
                ],
              },
            },
          }),
          { status: 200 },
        ),
      },
      {
        urlPattern: /example\.com\/long\.json/,
        response: () => new Response(
          JSON.stringify({
            body: Array.from({ length: 100 }, (_, i) => ({ content: `Line ${i} of the subtitle content.` })),
          }),
          { status: 200 },
        ),
      },
    );

    const tool = module.createShareLinkTool({
      config: {
        responseMode: "simple",
        includeDescription: false,
        includeCover: false,
        subtitleMaxLength: 5000,
        llmShortContentThreshold: 50,
        llmChunkSize: 100,
      },
      // complete is intentionally undefined
    });

    const result = await tool.execute("call-1", { url: "BV1xx411c7mD" });
    expect(result.isError).toBe(false);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("视频内容:");
    // Without LLM, raw content should still be present (truncated to subtitleMaxLength)
    expect(text).toContain("Line 0 of the subtitle content.");
  });

  // -----------------------------------------------------------------------
  // (f) bilibili cookie value never appears in any returned content
  // -----------------------------------------------------------------------

  it("bilibili cookie value never appears in any returned content", async () => {
    const secretSessdata = "super_secret_sessdata_12345";
    const secretBiliJct = "super_secret_bili_jct_67890";

    setupFetchMocks(
      {
        urlPattern: /api\.bilibili\.com\/x\/web-interface\/view/,
        response: () => new Response(
          JSON.stringify({
            code: 0,
            data: {
              title: "Secret Video",
              desc: `This description contains ${secretSessdata} and ${secretBiliJct} accidentally.`,
              duration: 60,
              owner: { name: "UP" },
              pic: "",
              pages: [{ cid: 1 }],
            },
          }),
          { status: 200 },
        ),
      },
      {
        urlPattern: /api\.bilibili\.com\/x\/player\/v2/,
        response: () => new Response(
          JSON.stringify({
            code: 0,
            data: {
              subtitle: {
                subtitles: [
                  { lan: "zh-CN", subtitle_url: "https://example.com/secret.json" },
                ],
              },
            },
          }),
          { status: 200 },
        ),
      },
      {
        urlPattern: /example\.com\/secret\.json/,
        response: () => new Response(
          JSON.stringify({
            body: [{ content: `Subtitle also has ${secretSessdata} in it.` }],
          }),
          { status: 200 },
        ),
      },
    );

    const tool = module.createShareLinkTool({
      config: {
        responseMode: "detailed",
        includeDescription: true,
        includeCover: false,
        descriptionMaxLength: 200,
        subtitleMaxLength: 5000,
        bilibiliCookie: {
          sessdata: secretSessdata,
          biliJct: secretBiliJct,
        },
      },
    });

    const result = await tool.execute("call-1", { url: "BV1xx411c7mD" });
    expect(result.isError).toBe(false);
    const text = result.content[0]?.text ?? "";
    expect(text).not.toContain(secretSessdata);
    expect(text).not.toContain(secretBiliJct);
    expect(text).toContain("[REDACTED]");
  });

  // -----------------------------------------------------------------------
  // (g) short-content threshold skips the LLM
  // -----------------------------------------------------------------------

  it("short-content threshold skips the LLM", async () => {
    const complete = vi.fn().mockResolvedValue({ text: "LLM summary here." });

    setupFetchMocks(
      {
        urlPattern: /api\.bilibili\.com\/x\/web-interface\/view/,
        response: () => new Response(
          JSON.stringify({
            code: 0,
            data: {
              title: "Short Video",
              desc: "",
              duration: 30,
              owner: { name: "UP" },
              pic: "",
              pages: [{ cid: 1 }],
            },
          }),
          { status: 200 },
        ),
      },
      {
        urlPattern: /api\.bilibili\.com\/x\/player\/v2/,
        response: () => new Response(
          JSON.stringify({
            code: 0,
            data: {
              subtitle: {
                subtitles: [
                  { lan: "zh-CN", subtitle_url: "https://example.com/short.json" },
                ],
              },
            },
          }),
          { status: 200 },
        ),
      },
      {
        urlPattern: /example\.com\/short\.json/,
        response: () => new Response(
          JSON.stringify({
            body: [{ content: "Short subtitle." }],
          }),
          { status: 200 },
        ),
      },
    );

    const tool = module.createShareLinkTool({
      config: {
        responseMode: "simple",
        includeDescription: false,
        includeCover: false,
        subtitleMaxLength: 5000,
        llmShortContentThreshold: 100,
        llmChunkSize: 50,
      },
      complete: complete as unknown as import("../src/tools/builtin/sharelink/index.js").ShareLinkLlmComplete,
    });

    const result = await tool.execute("call-1", { url: "BV1xx411c7mD" });
    expect(result.isError).toBe(false);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Short subtitle.");
    expect(complete).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // (h) two independent instances do not share state
  // -----------------------------------------------------------------------

  it("two independent instances do not share state", async () => {
    setupFetchMocks(
      {
        urlPattern: /api\.bilibili\.com\/x\/web-interface\/view/,
        response: () => new Response(
          JSON.stringify({
            code: 0,
            data: {
              title: "Instance Test",
              desc: "",
              duration: 60,
              owner: { name: "UP" },
              pic: "",
              pages: [{ cid: 1 }],
            },
          }),
          { status: 200 },
        ),
      },
      {
        urlPattern: /api\.bilibili\.com\/x\/player\/v2/,
        response: () => new Response(
          JSON.stringify({
            code: 0,
            data: {
              subtitle: {
                subtitles: [
                  { lan: "zh-CN", subtitle_url: "https://example.com/inst.json" },
                ],
              },
            },
          }),
          { status: 200 },
        ),
      },
      {
        urlPattern: /example\.com\/inst\.json/,
        response: () => new Response(
          JSON.stringify({
            body: [{ content: "Instance subtitle." }],
          }),
          { status: 200 },
        ),
      },
    );

    const toolA = module.createShareLinkTool({
      config: { responseMode: "simple", includeDescription: false, includeCover: false },
    });

    const toolB = module.createShareLinkTool({
      config: { responseMode: "detailed", includeDescription: false, includeCover: false },
    });

    const resultA = await toolA.execute("call-a", { url: "BV1xx411c7mD" });
    const resultB = await toolB.execute("call-b", { url: "BV1xx411c7mD" });

    const textA = resultA.content[0]?.text ?? "";
    const textB = resultB.content[0]?.text ?? "";

    // A should be simple mode (no "平台:" line)
    expect(textA).not.toContain("平台:");
    // B should be detailed mode (has "平台:" line)
    expect(textB).toContain("平台:");
  });
});
