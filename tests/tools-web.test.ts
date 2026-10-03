import { describe, expect, it, vi } from "vitest";
import { assertPublicUrl, createPublicPageRequest, createWebFetchTool, createWebSearchTool, fetchPublicPage, isBlockedAddress, resolvePublicAddresses } from "../src/tools/web.js";

describe("public webpage access", () => {
  it.each(["127.0.0.1", "10.0.0.1", "172.20.0.1", "192.168.0.1", "169.254.169.254", "100.64.0.1", "224.0.0.1", "0.0.0.0", "198.18.0.1", "::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "2002:7f00:1::", "2001:db8::1"])("blocks %s", (ip) => {
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
    await expect(fetchPublicPage("https://example.com", { request })).rejects.toThrow("内网");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("follows relative redirects and limits loops", async () => {
    const request = vi.fn(async (url: URL) => url.pathname === "/next"
      ? { status: 200, headers: {}, body: "ok" }
      : { status: 302, headers: { location: "/next" }, body: "" });
    expect((await fetchPublicPage("https://example.com", { request })).url).toBe("https://example.com/next");
    await expect(fetchPublicPage("https://example.com", { request: async () => ({ status: 302, headers: { location: "/loop" }, body: "" }) })).rejects.toThrow("5 次");
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
    await expect(createWebSearchTool().execute("1", { query: "q" })).rejects.toThrow("配置");
    await expect(createWebSearchTool({ provider: "unsupported" as "brave" }).execute("1", { query: "q" })).rejects.toThrow("不支持");
    const tool = createWebSearchTool({ provider: "brave", apiKey: "test" }, { fetch: async () => new Response("secret", { status: 403 }) });
    await expect(tool.execute("1", { query: "q" })).rejects.toThrow("HTTP 403");
  });
});
