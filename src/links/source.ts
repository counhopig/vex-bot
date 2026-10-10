import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { builtinSkillsDirectory } from "../skills/index.js";
import { assertPublicUrl, fetchPublicPage, htmlToMarkdown, type PageRequest } from "../tools/web.js";

export interface OriginalSource {
  requestedUrl: string;
  canonicalUrl: string;
  title: string;
  text: string;
  textKind: "text" | "article" | "subtitles" | "transcript";
  truncated: boolean;
}

export interface SourceResolverOptions {
  signal: AbortSignal;
  request?: PageRequest;
  sessdata?: string;
  stt?: { baseUrl: string; model: string; apiKey?: string };
}

type Reader = { readOriginalSource(input: string, options: Record<string, unknown>): Promise<unknown>; findPlatform(input: string): unknown; firstUrl(input: string): string };
let readerPromise: Promise<Reader> | undefined;

async function reader(): Promise<Reader> {
  readerPromise ??= import(pathToFileURL(join(builtinSkillsDirectory(), "link-reader", "scripts", "read.mjs")).href)
    .then((module: unknown) => {
      if (!module || typeof module !== "object" || typeof (module as Reader).readOriginalSource !== "function" || typeof (module as Reader).findPlatform !== "function" || typeof (module as Reader).firstUrl !== "function") {
        throw new Error("The bundled link reader has an invalid interface");
      }
      return module as Reader;
    });
  return readerPromise;
}

const isTextKind = (value: unknown): value is OriginalSource["textKind"] =>
  value === "text" || value === "article" || value === "subtitles" || value === "transcript";

export async function readPlatformOriginalSource(input: string, options: SourceResolverOptions): Promise<OriginalSource | undefined> {
  options.signal.throwIfAborted();
  const module = await reader();
  if (!module.findPlatform(input)) return undefined;
  options.signal.throwIfAborted();
  const value = await module.readOriginalSource(input, {
    fetchPublicPage,
    signal: options.signal,
    request: options.request,
    sessdata: options.sessdata,
    stt: options.stt,
  });
  options.signal.throwIfAborted();
  if (!value || typeof value !== "object") throw new Error("The link reader returned invalid source data");
  const source = value as Record<string, unknown>;
  let requestedUrl: URL;
  let canonicalUrl: URL;
  try {
    requestedUrl = new URL(String(source.requestedUrl));
    canonicalUrl = new URL(String(source.canonicalUrl));
    assertPublicUrl(requestedUrl);
    assertPublicUrl(canonicalUrl);
  }
  catch { throw new Error("The link reader returned an invalid public canonical URL"); }
  if (typeof source.requestedUrl !== "string" || source.requestedUrl !== module.firstUrl(input) || typeof source.title !== "string" ||
      typeof source.text !== "string" || source.text.length > 500_000 || !isTextKind(source.textKind) || typeof source.truncated !== "boolean") {
    throw new Error("The link reader returned invalid source data");
  }
  return {
    requestedUrl: requestedUrl.href,
    canonicalUrl: canonicalUrl.href,
    title: source.title,
    text: source.text,
    textKind: source.textKind,
    truncated: source.truncated,
  };
}

export async function readGenericOriginalSource(url: string, options: SourceResolverOptions): Promise<OriginalSource> {
  const page = await fetchPublicPage(url, { signal: options.signal, request: options.request, maxBytes: 2_000_000 });
  const type = page.headers["content-type"] ?? "";
  if (type && !/^text\/|^application\/(?:json|xhtml\+xml|xml)/i.test(type)) throw new Error("That address is not a text page");
  let text = page.body;
  if (/html/i.test(type)) text = htmlToMarkdown(text);
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(page.body)?.[1]?.replace(/<[^>]+>/g, "").trim() ?? "";
  const truncated = text.length > 500_000;
  return { requestedUrl: url, canonicalUrl: page.url, title, text: text.slice(0, 500_000), textKind: "text", truncated };
}

export async function readOriginalSource(url: string, options: SourceResolverOptions): Promise<OriginalSource> {
  return await readPlatformOriginalSource(url, options) ?? await readGenericOriginalSource(url, options);
}
