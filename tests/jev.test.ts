import { expect, it, vi } from "vitest";
import { Jev } from "../src/providers/jev.js";

it("uses the official typed API and keeps the key out of the payload", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ answers: { next_tool: { type: "choice", choice: "web_fetch", confidence: 0.95 } } }));
  const jev = new Jev({ apiKey: "secret-key" }, request);
  expect(await jev.route({ request: "read this link" }, [{ name: "web_fetch", description: "Read web pages" }])).toEqual({ tool: "web_fetch", confidence: 0.95 });
  const [url, init] = request.mock.calls[0]!;
  expect(url).toBe("https://api.typesafe.ai/v1/systemone");
  expect(init?.headers).toMatchObject({ Authorization: "Bearer secret-key" });
  expect(init?.body).not.toContain("secret-key");
  expect(JSON.parse(init!.body as string)).toMatchObject({ model: "jev-latest", questions: { next_tool: { type: "choice", criteria: { web_fetch: "Read web pages" } } } });
});
it("validates evidence probabilities and rejects invalid responses", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ answers: { unsupported: { type: "noul", noul: 0.96 } } })).mockResolvedValueOnce(Response.json({ answers: { unsupported: { type: "noul", noul: 2 } } }));
  const jev = new Jev({ apiKey: "key" }, request);
  expect(await jev.unsupported({ reply: "failed" })).toBe(0.96);
  await expect(jev.unsupported({})).rejects.toThrow("invalid evidence");
});
it("rejects unknown tools and never exposes API error bodies", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ answers: { next_tool: { type: "choice", choice: "unknown", confidence: 1 } } })).mockResolvedValueOnce(new Response("secret-key", { status: 401 }));
  const jev = new Jev({ apiKey: "secret-key" }, request);
  await expect(jev.route({}, [])).rejects.toThrow("invalid tool route");
  await expect(jev.unsupported({})).rejects.toThrow("TypeSafe evaluation failed");
});
it("cancels a request on owner interruption", async () => {
  const controller = new AbortController();
  const request: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    controller.abort(new Error("owner stopped"));
  });
  await expect(new Jev({ apiKey: "key" }, request).unsupported({}, controller.signal)).rejects.toThrow("owner stopped");
});
it("bounds API calls with a timeout", async () => {
  const request: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(new Error("timed out")), { once: true });
  });
  await expect(new Jev({ apiKey: "key", timeoutMs: 20 }, request).unsupported({})).rejects.toThrow("TypeSafe evaluation failed");
});

it("keeps general tool routing advisory", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ answers: {
    next_tool: { type: "choice", choice: "wiki_ingest", confidence: 0.98 },
  } }));
  const logged = vi.fn();
  const state = { request: "check https://example.com", urls: ["https://example.com"] };
  const result = await new Jev({ apiKey: "secret-key" }, request, logged).route(state, [{ name: "wiki_ingest", description: "Archive source" }]);
  expect(result).toEqual({ tool: "wiki_ingest", confidence: 0.98 });
  const body = JSON.parse(request.mock.calls[0]![1]!.body as string);
  expect(body.questions.archive_shared_links).toBeUndefined();
  expect(JSON.stringify(logged.mock.calls)).not.toContain("secret-key");
  expect(logged).toHaveBeenCalledWith(expect.objectContaining({ question: "next_tool", tool: "wiki_ingest" }));
});

