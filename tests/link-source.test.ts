import { describe, expect, it } from "vitest";
import { readGenericOriginalSource, readPlatformOriginalSource } from "../src/links/source.js";
import type { PageRequest } from "../src/tools/web.js";

describe("programmatic original source", () => {
  it("loads the bundled platform reader and returns an XHS body without a summary call", async () => {
    const id = "64a1b2c3d4e5f60718293a4b";
    const state = { note: { noteDetailMap: { [id]: { note: { title: "探店", desc: "完整原文", type: "normal", user: { nickName: "作者" } } } } } };
    const calls: string[] = [];
    const request: PageRequest = async (url) => {
      calls.push(url.href);
      return { status: 200, headers: { "content-type": "text/html" }, body: `<script>window.__INITIAL_STATE__=${JSON.stringify(state)}</script>` };
    };
    const source = await readPlatformOriginalSource(`https://www.xiaohongshu.com/explore/${id}`, { signal: AbortSignal.timeout(2_000), request });
    expect(source).toMatchObject({ requestedUrl: `https://www.xiaohongshu.com/explore/${id}`, canonicalUrl: `https://www.xiaohongshu.com/explore/${id}`, title: "探店", text: "完整原文", textKind: "text", truncated: false });
    expect(calls).toEqual([`https://www.xiaohongshu.com/explore/${id}`]);
  });

  it("caps generic extracted text at 500,000 characters and marks it truncated", async () => {
    const source = await readGenericOriginalSource("https://example.com/article", {
      signal: AbortSignal.timeout(2_000),
      request: async () => ({ status: 200, headers: { "content-type": "text/plain" }, body: "x".repeat(500_001) }),
    });
    expect(source.text).toHaveLength(500_000);
    expect(source.truncated).toBe(true);
  });

  it("validates redirects and propagates cancellation", async () => {
    const redirect: PageRequest = async () => ({ status: 302, headers: { location: "http://127.0.0.1/private" }, body: "" });
    await expect(readGenericOriginalSource("https://example.com", { signal: AbortSignal.timeout(2_000), request: redirect })).rejects.toThrow("private");
    const controller = new AbortController();
    controller.abort();
    await expect(readGenericOriginalSource("https://example.com", { signal: controller.signal, request: async () => { throw new Error("should not run"); } })).rejects.toMatchObject({ name: "AbortError" });
  });
});
