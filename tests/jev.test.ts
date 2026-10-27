import { expect, it, vi } from "vitest";
import { Jev } from "../src/providers/jev.js";

const answer = (choice: string, confidence = 0.95) => Response.json({ answers: { link_0: { type: "choice", choice, confidence } } });

it("uses the official typed API and keeps the key out of the payload", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(answer("archive"));
  const jev = new Jev({ apiKey: "secret-key" }, request);
  expect(await jev.classifyLinks("save https://one.example", ["https://one.example"])).toEqual([{ url: "https://one.example", intent: "archive", confidence: 0.95 }]);
  const [url, init] = request.mock.calls[0]!;
  expect(url).toBe("https://api.typesafe.ai/v1/systemone");
  expect(init?.headers).toMatchObject({ Authorization: "Bearer secret-key" });
  expect(init?.body).not.toContain("secret-key");
  expect(JSON.parse(init!.body as string)).toMatchObject({ model: "jev-latest", questions: { link_0: { type: "choice", criteria: { archive: expect.any(String), read: expect.any(String), defer: expect.any(String) } } } });
});

it("rejects invalid intents and never exposes API error bodies", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(answer("delete", 1)).mockResolvedValueOnce(answer("archive", 2)).mockResolvedValueOnce(new Response("secret-key", { status: 401 }));
  const jev = new Jev({ apiKey: "secret-key" }, request);
  await expect(jev.classifyLinks("x", ["https://one.example"])).rejects.toThrow("invalid link intent");
  await expect(jev.classifyLinks("x", ["https://one.example"])).rejects.toThrow("invalid link intent");
  const failure = await jev.classifyLinks("x", ["https://one.example"]).catch((error: Error) => error.message);
  expect(failure).toContain("TypeSafe evaluation failed");
  expect(failure).not.toContain("secret-key");
});

it("cancels a request on owner interruption", async () => {
  const controller = new AbortController();
  const request: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    controller.abort(new Error("owner stopped"));
  });
  await expect(new Jev({ apiKey: "key" }, request).classifyLinks("x", ["https://one.example"], controller.signal)).rejects.toThrow("owner stopped");
});

it("bounds API calls with a timeout", async () => {
  const request: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(new Error("timed out")), { once: true });
  });
  await expect(new Jev({ apiKey: "key", timeoutMs: 20 }, request).classifyLinks("x", ["https://one.example"])).rejects.toThrow("TypeSafe evaluation failed");
});

it("classifies each bounded owner URL with a typed intent and ignores untrusted returned URLs", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ answers: {
    link_0: { type: "choice", choice: "archive", confidence: 0.95 },
    link_1: { type: "choice", choice: "read", confidence: 0.9 },
  } }));
  const jev = new Jev({ apiKey: "key" }, request);
  const input = `please check https://one.example and do not save https://two.example ${"x".repeat(5000)}`;
  expect(await jev.classifyLinks(input, ["https://one.example", "https://two.example"])).toEqual([
    { url: "https://one.example", intent: "archive", confidence: 0.95 },
    { url: "https://two.example", intent: "read", confidence: 0.9 },
  ]);
  const body = JSON.parse(request.mock.calls[0]![1]!.body as string);
  expect(body.state.ownerInput).toHaveLength(4000);
  expect(body.state.urls).toEqual(["https://one.example", "https://two.example"]);
  expect(JSON.stringify(body)).not.toContain("secret-key");
});
