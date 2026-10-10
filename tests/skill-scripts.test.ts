import { mkdtemp, writeFile, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

const weather = await import(pathToFileURL(join(process.cwd(), "skills/weather/scripts/weather.mjs")).href);
const image = await import(pathToFileURL(join(process.cwd(), "skills/image/scripts/analyze.mjs")).href);

describe("builtin skill scripts", () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
  async function picture() {
    const root = await mkdtemp(join(tmpdir(), "vex-image-")); roots.push(root);
    const path = join(root, "photo.png");
    await writeFile(path, Buffer.from([137, 80, 78, 71]));
    return path;
  }

  it("queries weather with encoded location and produces current conditions", async () => {
    const fetchFn = vi.fn(async (_url: URL, _options?: RequestInit) => new Response(JSON.stringify({
      current_condition: [{ temp_C: "22", lang_zh: [{ value: "晴" }] }],
      weather: [{ date: "2026-10-03", mintempC: "20", maxtempC: "26" }],
    })));
    const result = await weather.queryWeather("香港", fetchFn);
    expect(result.current).toMatchObject({ temperatureC: "22", description: "晴" });
    const url = fetchFn.mock.calls[0]?.[0] as unknown as URL;
    expect(decodeURIComponent(url.pathname)).toBe("/香港");
    expect(url.searchParams.get("format")).toBe("j1");
    await expect(weather.queryWeather("", fetchFn)).rejects.toThrow("city name");
  });
  it("reports weather service failures without inventing a result", async () => {
    await expect(weather.queryWeather("Hong Kong", async () => new Response("error", { status: 503 }))).rejects.toThrow("503");
    await expect(weather.queryWeather("Hong Kong", async () => new Response("{}"))).rejects.toThrow("invalid");
  });
  it("uses the resolved image model and sends local image bytes", async () => {
    const completeSimple = vi.fn(async (_model: unknown, _context: unknown, _options?: unknown) => ({ stopReason: "stop", content: [{ type: "text", text: "一只猫" }] }));
    const registry = { resolve: vi.fn(() => ({ provider: "faux", input: ["text", "image"] })), getApiKey: () => "test", completeSimple };
    expect(await image.analyzeImage({ image: await picture(), prompt: "画面有什么？" }, registry, { provider: "faux", id: "vision" })).toBe("一只猫");
    expect(completeSimple.mock.calls[0]?.[1]).toMatchObject({ messages: [{ role: "user", content: [
      { type: "text", text: "画面有什么？" }, { type: "image", mimeType: "image/png" },
    ] }] });
  });
  it("rejects text-only models before invoking them", async () => {
    const completeSimple = vi.fn();
    const registry = { resolve: () => ({ input: ["text"] }), completeSimple };
    await expect(image.analyzeImage({ image: await picture() }, registry, { provider: "faux", id: "text" })).rejects.toThrow("does not accept image");
    expect(completeSimple).not.toHaveBeenCalled();
  });

  it.skipIf(process.env.VEX_VERIFY_DIST !== "1")( "loads the compiled CLI and bundled Wiki and link-reader assets", async () => {
    const dist = join(process.cwd(), "dist");
    expect((await stat(join(dist, "cli/index.js"))).isFile()).toBe(true);
    expect((await readFile(join(dist, "skills/llm-wiki/SKILL.md"), "utf8"))).toContain("# LLM Wiki");
    expect((await stat(join(dist, "skills/link-reader/scripts/read.mjs"))).isFile()).toBe(true);
    const built = await import(pathToFileURL(join(dist, "links/source.js")).href) as typeof import("../src/links/source.js");
    const id = "64a1b2c3d4e5f60718293a4b";
    const state = { note: { noteDetailMap: { [id]: { note: { title: "Note", desc: "Built bundle original", type: "normal" } } } } };
    const source = await built.readPlatformOriginalSource(`https://www.xiaohongshu.com/explore/${id}`, {
      signal: AbortSignal.timeout(2_000),
      request: async () => ({ status: 200, headers: { "content-type": "text/html" }, body: `<script>window.__INITIAL_STATE__=${JSON.stringify(state)}</script>` }),
    });
    expect(source).toMatchObject({ title: "Note", text: "Built bundle original", textKind: "text", truncated: false });
    const home = await mkdtemp(join(tmpdir(), "vex-built-cli-")); roots.push(home);
    const help = execFileSync(process.execPath, [join(dist, "cli/index.js")], {
      encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: home, VEX_HOME: home, NODE_ENV: "test" },
    });
    expect(help).toContain("Usage: vex <command>");
    expect(help).toContain("wechat login");
  });
});
