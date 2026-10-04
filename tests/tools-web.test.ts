import { describe, expect, it, vi } from "vitest";
import { assertPublicUrl, createPublicPageRequest, decodeBody, createWebFetchTool, createWebSearchTool, fetchPublicPage, isBlockedAddress, resolvePublicAddresses } from "../src/tools/web.js";

describe("public webpage access", () => {
  it("allows public addresses inside 192.0.0.0/16", () => {
    expect(isBlockedAddress("192.0.78.9")).toBe(false);
  });
  it("decodes bodies with the declared charset and falls back to UTF-8", () => {
    const gbk = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]);
    expect(decodeBody(gbk, "text/html; charset=GBK")).toBe("你好");
    expect(decodeBody(Buffer.from("你好"), "text/html; charset=utf-8")).toBe("你好");
    expect(decodeBody(Buffer.from("你好"), "text/html; charset=nonsense")).toBe("你好");
    expect(decodeBody(Buffer.from("你好"))).toBe("你好");
  });
  it.each(["127.0.0.1", "10.0.0.1", "172.20.0.1", "192.168.0.1", "169.254.169.254", "100.64.0.1", "224.0.0.1", "0.0.0.0", "198.18.0.1", "192.0.0.1", "192.0.2.1", "::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "2002:7f00:1::", "2001:db8::1"])("blocks %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });
  it.each(["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111"])("allows %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
  it.each(["file:///etc/passwd", "http://localhost/", "http://localhost./", "http://metadata.google.internal/", "http://2130706433/", "http://0x7f000001/", "http://[::ffff:7f00:1]/", "https://user:password@example.com/"])("rejects %s", (url) => {
    expect(() => assertPublicUrl(new URL(url))).toThrow();
  });
  it("rejects mixed DNS results and validates the connection lookup", async () => {
    await expect(resolvePublicAddresses("example.com", async () => [
      { address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 },
    ])).rejects.toThrow("DNS");
    await expect(resolvePublicAddresses("example.com", async () => [{ address: "8.8.8.8", family: 4 }])).resolves.toHaveLength(1);
    await expect(resolvePublicAddresses("example.com", async () => [])).rejects.toThrow("DNS");
  });
  it("enforces DNS checks within the native socket connection", async () => {
    const resolver = vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]);
    const request = createPublicPageRequest(resolver);
    await expect(request(new URL("http://ssrf-test.example/"), AbortSignal.timeout(1000))).rejects.toThrow("DNS");
    expect(resolver).toHaveBeenCalledWith("ssrf-test.example");
  });
  it("blocks redirects to internal hosts before making a second request", async () => {
    const request = vi.fn(async () => ({ status: 302, headers: { location: "http://127.0.0.1/private" }, body: "" }));
    await expect(fetchPublicPage("https://example.com", { request })).rejects.toThrow("private");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("follows relative redirects and limits loops", async () => {
    const request = vi.fn(async (url: URL) => url.pathname === "/next"
      ? { status: 200, headers: {}, body: "ok" }
      : { status: 302, headers: { location: "/next" }, body: "" });
    expect((await fetchPublicPage("https://example.com", { request })).url).toBe("https://example.com/next");
    await expect(fetchPublicPage("https://example.com", { request: async () => ({ status: 302, headers: { location: "/loop" }, body: "" }) })).rejects.toThrow("5 times");
  });
  it("converts headings, links and code to Markdown without scripts", async () => {
    const tool = createWebFetchTool({ request: async () => ({ status: 200, headers: { "content-type": "text/html" },
      body: '<h1>Hello</h1><p><a href="https://example.org">Link</a></p><pre><code>hello()</code></pre><script>alert(1)</script><style>bad</style>',
    }) });
    const result = await tool.execute("1", { url: "https://example.com" });
    expect(result.content).toEqual([{ type: "text", text: "# Hello\n\n[Link](https://example.org)\n\n```\nhello()\n```" }]);
  });
  it("caps output and surfaces HTTP errors and cancellation", async () => {
    const tool = createWebFetchTool({ request: async () => ({ status: 200, headers: { "content-type": "text/plain" }, body: "x".repeat(200) }) });
    expect(await tool.execute("1", { url: "https://example.com", maxLength: 100 })).toMatchObject({ details: { truncated: true } });
    await expect(fetchPublicPage("https://example.com", { request: async () => ({ status: 500, headers: {}, body: "fail" }) })).rejects.toThrow("HTTP 500");
    await expect(tool.execute("2", { url: "https://example.com" }, AbortSignal.abort())).rejects.toThrow();
  });
});

describe("configured Tavily and SearXNG search", () => {
  it("posts the query to Tavily with a bearer key and normalizes the results", async () => {
    const fetchFn = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response(JSON.stringify({ results: [{ title: "T", url: "https://t.example", content: "内容摘要", published_date: "2026-10-01" }] })));
    const result = await createWebSearchTool({ provider: "tavily", apiKey: "tvly-test" }, { fetch: fetchFn as never }).execute("1", { query: "测试", count: 4 });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(String(url)).toBe("https://api.tavily.com/search");
    expect(init!.method).toBe("POST");
    expect(init!.headers).toMatchObject({ Authorization: "Bearer tvly-test" });
    expect(JSON.parse(init!.body as string)).toMatchObject({ query: "测试", max_results: 4 });
    expect(JSON.parse((result.content[0] as { text: string }).text).results).toEqual([{ title: "T", url: "https://t.example", description: "内容摘要", published: "2026-10-01" }]);
    await expect(createWebSearchTool({ provider: "tavily" }, { fetch: fetchFn as never }).execute("1", { query: "q" })).rejects.toThrow("TAVILY_API_KEY");
    await expect(createWebSearchTool({ provider: "tavily", apiKey: "k" }, { fetch: async () => new Response("", { status: 401 }) }).execute("1", { query: "q" })).rejects.toThrow("HTTP 401");
  });

  it("queries SearXNG for JSON and explains the common setup problems", async () => {
    const fetchFn = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response(JSON.stringify({ results: [{ title: "A", url: "https://a.example", content: "摘要", publishedDate: null }, { title: "B", url: "https://b.example", content: "二" }] })));
    const result = await createWebSearchTool({ provider: "searxng", baseUrl: "http://searxng:8080/" }, { fetch: fetchFn as never }).execute("1", { query: "咖啡", count: 1, country: "CN" });
    const url = fetchFn.mock.calls[0]![0] as URL;
    expect(url.origin + url.pathname).toBe("http://searxng:8080/search");
    expect(url.searchParams.get("q")).toBe("咖啡");
    expect(url.searchParams.get("format")).toBe("json");
    expect(url.searchParams.get("language")).toBe("cn");
    expect(JSON.parse((result.content[0] as { text: string }).text).results).toHaveLength(1);
    await expect(createWebSearchTool({ provider: "searxng" }).execute("1", { query: "q" })).rejects.toThrow("baseUrl");
    await expect(createWebSearchTool({ provider: "searxng", baseUrl: "not a url" }).execute("1", { query: "q" })).rejects.toThrow("valid address");
    await expect(createWebSearchTool({ provider: "searxng", baseUrl: "http://s" }, { fetch: async () => new Response("", { status: 403 }) }).execute("1", { query: "q" })).rejects.toThrow("search.formats");
    await expect(createWebSearchTool({ provider: "searxng", baseUrl: "http://127.0.0.1:1" }).execute("1", { query: "q" })).rejects.toThrow("Cannot reach the search service (searxng)");
  });
});

describe("configured Brave search", () => {
  it("uses configured API credentials and normalizes search results", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ web: { results: [{ title: "Title", url: "https://example.com", description: "Snippet", age: "today" }] } }), { status: 200 }));
    const result = await createWebSearchTool({ provider: "brave", apiKey: "local-test" }, { fetch: fetchFn }).execute("1", { query: "测试", count: 3, country: "CN" });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.searchParams.get("q")).toBe("测试");
    expect(url.searchParams.get("count")).toBe("3");
    expect(init.headers).toMatchObject({ "X-Subscription-Token": "local-test" });
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Snippet") });
  });
  it("reports missing config, unsupported providers and HTTP failure", async () => {
    await expect(createWebSearchTool().execute("1", { query: "q" })).rejects.toThrow("Configure");
    await expect(createWebSearchTool({ provider: "unsupported" as "brave" }).execute("1", { query: "q" })).rejects.toThrow("brave, tavily, searxng");
    const tool = createWebSearchTool({ provider: "brave", apiKey: "test" }, { fetch: async () => new Response("secret", { status: 403 }) });
    await expect(tool.execute("1", { query: "q" })).rejects.toThrow("HTTP 403");
  });
});
