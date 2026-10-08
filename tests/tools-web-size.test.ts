import { EventEmitter } from "node:events";
import { request as httpsRequest } from "node:https";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPublicPage } from "../src/tools/web.js";

vi.mock("node:https", () => ({ request: vi.fn() }));

function serve(bytes: number) {
  vi.mocked(httpsRequest).mockImplementation(((_url: URL, _options: unknown, receive: (response: unknown) => void) => {
    const request = new EventEmitter() as EventEmitter & { end: () => void };
    request.end = () => queueMicrotask(() => {
      const response = Object.assign(new PassThrough(), { statusCode: 200, headers: { "content-type": "text/plain" } });
      receive(response);
      response.end(Buffer.alloc(bytes, "a"));
    });
    return request;
  }) as typeof httpsRequest);
}

describe("page download size limits", () => {
  beforeEach(() => vi.resetAllMocks());

  it("keeps the default 2 MB cap", async () => {
    serve(2_000_000);
    expect((await fetchPublicPage("https://example.com")).body.length).toBe(2_000_000);
    serve(2_000_001);
    await expect(fetchPublicPage("https://example.com")).rejects.toThrow("2 MB limit");
  });

  it("allows a large article with an explicit cap and rejects a page above that cap", async () => {
    serve(3_600_000);
    expect((await fetchPublicPage("https://mp.weixin.qq.com/s/article", { maxBytes: 10_000_000 })).body.length).toBe(3_600_000);
    serve(10_000_001);
    await expect(fetchPublicPage("https://mp.weixin.qq.com/s/article", { maxBytes: 10_000_000 })).rejects.toThrow("10 MB limit");
  });

  it.each([0, -1, 10_000_001, Infinity, 1.5])("rejects invalid size cap %s", async (maxBytes) => {
    await expect(fetchPublicPage("https://example.com", { maxBytes })).rejects.toThrow("Page size limit");
    expect(httpsRequest).not.toHaveBeenCalled();
  });
});
