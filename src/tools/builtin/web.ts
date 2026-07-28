/**
 * Built-in tools — Web search and fetch.
 *
 * SSRF protection preserved exactly from _archive/src/tools/builtin/web.ts:
 *   - isBlockedAddress — rejects private/reserved/link-local/multicast IPs
 *   - assertWebFetchUrlAllowed — rejects non-http(s) and blocked hosts
 *   - guardedLookup — DNS-level block via undici Agent connect option
 *   - safeWebFetch — manual redirect following with per-hop re-validation
 *
 * Any model-supplied URL is hostile until proven otherwise. The SSRF
 * guards here are not optional — they're the defense-in-depth layer
 * between an LLM that can ask to fetch any URL and the network.
 */

import { Type, type Static } from "@sinclair/typebox";
import { isIP } from "net";
import { lookup as dnsLookup } from "dns";
import type { AgentToolResult } from "@mariozechner/pi-coding-agent";
import type { Dispatcher } from "undici";
import { request as undiciRequest, Agent } from "undici";
import type { Tool } from "../types.js";
import {
  jsonResult,
  errorResult,
  readStringParam,
  readNumberParam,
} from "../common.js";
import { getChildLogger } from "../../utils/logger.js";

const logger = getChildLogger("web-tools");

// ============================================================================
// Brave Search
// ============================================================================

const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const DEFAULT_SEARCH_COUNT = 5;
const MAX_SEARCH_COUNT = 10;
const DEFAULT_TIMEOUT_MS = 30000;

/** Search result cache (TTL 5 minutes). Module-level cache is acceptable
 *  because search results are not user-scoped — same query yields same data. */
const searchCache = new Map<string, { data: unknown; timestamp: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

type BraveSearchResult = {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
};

type BraveSearchResponse = {
  web?: { results?: BraveSearchResult[] };
};

function getSearchApiKey(): string | undefined {
  return process.env.BRAVE_API_KEY?.trim() || undefined;
}

function extractSiteName(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function generateCacheKey(
  query: string,
  count: number,
  country?: string,
): string {
  return `${query}:${count}:${country || "default"}`.toLowerCase();
}

function readCache(key: string): unknown | undefined {
  const entry = searchCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    searchCache.delete(key);
    return undefined;
  }
  return entry.data;
}

function writeCache(key: string, data: unknown): void {
  const now = Date.now();
  for (const [k, v] of searchCache) {
    if (now - v.timestamp > CACHE_TTL_MS) searchCache.delete(k);
  }
  searchCache.set(key, { data, timestamp: now });
}

async function runBraveSearch(params: {
  query: string;
  count: number;
  apiKey: string;
  country?: string;
}): Promise<{
  query: string;
  count: number;
  results: Array<{
    title: string;
    url: string;
    description: string;
    published?: string;
    siteName?: string;
  }>;
  tookMs: number;
}> {
  const { query, count, apiKey, country } = params;
  const startTime = Date.now();

  const url = new URL(BRAVE_SEARCH_ENDPOINT);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(count));
  if (country) url.searchParams.set("country", country);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `Brave Search API error (${response.status}): ${text || response.statusText}`,
      );
    }

    const data = (await response.json()) as BraveSearchResponse;
    const rawResults = Array.isArray(data.web?.results)
      ? data.web.results
      : [];

    const results = rawResults.map((entry) => ({
      title: entry.title ?? "",
      url: entry.url ?? "",
      description: entry.description ?? "",
      published: entry.age,
      siteName: extractSiteName(entry.url),
    }));

    return {
      query,
      count: results.length,
      results,
      tookMs: Date.now() - startTime,
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ============================================================================
// web_search tool
// ============================================================================

export function createWebSearchTool(): Tool {
  const parameters = Type.Object({
    query: Type.String({ description: "Search query" }),
    count: Type.Optional(
      Type.Number({
        description: "Number of results (1-10, default: 5)",
        minimum: 1,
        maximum: MAX_SEARCH_COUNT,
      }),
    ),
    country: Type.Optional(
      Type.String({
        description:
          "2-letter country code for region-specific results (e.g., 'CN', 'US')",
      }),
    ),
  });

  return {
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web using Brave Search API. Returns titles, URLs, and snippets for research. Set BRAVE_API_KEY environment variable to enable.",
    parameters,
    execute: async (_toolCallId, args, _signal, _onUpdate, _ctx) => {
      const params = args as Static<typeof parameters>;
      const query = params.query;
      const count = Math.min(
        MAX_SEARCH_COUNT,
        Math.max(
          1,
          params.count ?? DEFAULT_SEARCH_COUNT,
        ),
      );
      const country = params.country;

      const apiKey = getSearchApiKey();
      if (!apiKey) {
        return jsonResult({
          error: "missing_api_key",
          message:
            "web_search requires BRAVE_API_KEY environment variable. Get a free API key at https://brave.com/search/api/",
        });
      }

      const cacheKey = generateCacheKey(query, count, country);
      const cached = readCache(cacheKey);
      if (cached) {
        logger.debug({ query }, "Returning cached search results");
        return jsonResult({ ...(cached as object), cached: true });
      }

      try {
        const result = await runBraveSearch({ query, count, apiKey, country });
        writeCache(cacheKey, result);
        logger.info(
          { query, count: result.count, tookMs: result.tookMs },
          "Web search completed",
        );
        return jsonResult(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ query, error: message }, "Web search failed");
        return errorResult(`Search failed: ${message}`);
      }
    },
  };
}

// ============================================================================
// SSRF protection for web_fetch
// ============================================================================

const MAX_REDIRECTS = 5;
const MAX_FETCH_BYTES = 5 * 1024 * 1024; // hard ceiling on downloaded bytes
const METADATA_HOSTS = new Set(["metadata.google.internal", "metadata.goog"]);

/**
 * Is this IP in a private/reserved/link-local range that must not be
 * reachable via a model-supplied URL? Covers the cloud-metadata address
 * (169.254.169.254) and the RFC1918 / loopback / CGNAT / IPv6 ULA +
 * link-local ranges.
 */
export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    const p = ip.split(".").map(Number);
    if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
    if (p[0] === 0) return true; // "this" network
    if (p[0] === 10) return true; // private
    if (p[0] === 127) return true; // loopback
    if (p[0] === 169 && p[1] === 254) return true; // link-local (incl. cloud metadata)
    if (p[0] === 172 && p[1]! >= 16 && p[1]! <= 31) return true; // private
    if (p[0] === 192 && p[1] === 168) return true; // private
    if (p[0] === 100 && p[1]! >= 64 && p[1]! <= 127) return true; // CGNAT 100.64/10
    if (p[0]! >= 224) return true; // multicast / reserved
    return false;
  }
  if (family === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true; // loopback / unspecified
    if (lower.startsWith("fe80")) return true; // link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA fc00::/7
    const mapped = lower.match(
      /::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/,
    ); // IPv4-mapped
    if (mapped?.[1]) return isBlockedAddress(mapped[1]);
    return false;
  }
  return false;
}

/** Reject non-http(s) schemes and (unless allowPrivate) private/metadata hosts. */
export function assertWebFetchUrlAllowed(
  url: URL,
  allowPrivate: boolean,
): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported URL scheme for web_fetch: ${url.protocol}`);
  }
  if (allowPrivate) return;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (METADATA_HOSTS.has(host)) {
    throw new Error(`Blocked request to metadata host: ${host}`);
  }
  if (isIP(host) && isBlockedAddress(host)) {
    throw new Error(`Blocked request to private/reserved address: ${host}`);
  }
}

/**
 * DNS lookup that rejects hostnames resolving to a blocked address (also
 * defeats DNS-rebinding, since the address actually connected to is validated).
 */
function guardedLookup(
  hostname: string,
  options: Parameters<typeof dnsLookup>[1],
  cb: (
    err: NodeJS.ErrnoException | null,
    ...args: unknown[]
  ) => void,
): void {
  dnsLookup(hostname, options as never, (err, address, family) => {
    if (err) return cb(err, address, family);
    const list = Array.isArray(address)
      ? address
      : [{ address: address as string, family }];
    for (const a of list) {
      if (isBlockedAddress(a.address)) {
        return cb(
          new Error(
            `Blocked private/reserved address for ${hostname}: ${a.address}`,
          ),
          address,
          family,
        );
      }
    }
    cb(null, address, family);
  });
}

export function allowPrivateNetwork(): boolean {
  const v = process.env.VEX_WEB_FETCH_ALLOW_PRIVATE?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** Read a response stream into text, stopping once maxChars is reached. */
async function readCapped(
  body: Dispatcher.ResponseData["body"],
  maxChars: number,
): Promise<{ text: string; truncated: boolean }> {
  let text = "";
  let bytes = 0;
  try {
    for await (const chunk of body) {
      bytes += chunk.length;
      text += chunk.toString("utf-8");
      if (text.length >= maxChars || bytes >= MAX_FETCH_BYTES) {
        body.destroy();
        return { text: text.slice(0, maxChars), truncated: true };
      }
    }
  } catch (error) {
    if (text.length >= maxChars)
      return { text: text.slice(0, maxChars), truncated: true };
    throw error;
  }
  return { text, truncated: false };
}

/**
 * Fetch a URL following redirects manually, re-validating every hop
 * against SSRF rules. undici.request does not follow redirects by default;
 * we follow manually (re-validating each hop) so redirect-to-internal
 * SSRF can't bypass checks.
 */
async function safeWebFetch(
  rawUrl: string,
  opts: { maxLength: number; timeoutMs: number },
): Promise<{
  finalUrl: string;
  statusCode: number;
  contentType: string;
  content: string;
  truncated: boolean;
}> {
  const allowPrivate = allowPrivateNetwork();
  const dispatcher = allowPrivate
    ? undefined
    : new Agent({ connect: { lookup: guardedLookup as never } });
  let current = new URL(rawUrl);

  for (let hop = 0; ; hop++) {
    assertWebFetchUrlAllowed(current, allowPrivate);

    const res = await undiciRequest(current, {
      method: "GET",
      dispatcher,
      signal: AbortSignal.timeout(opts.timeoutMs),
      headers: {
        "User-Agent": "Vexlla/5.0 (compatible; VexBot/1.0)",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    const location = res.headers.location;
    if (res.statusCode >= 300 && res.statusCode < 400 && location) {
      res.body.destroy();
      if (hop >= MAX_REDIRECTS) throw new Error("Too many redirects");
      const loc = Array.isArray(location) ? location[0]! : location;
      current = new URL(loc, current);
      continue;
    }

    const contentType = String(res.headers["content-type"] ?? "");
    const { text, truncated } = await readCapped(res.body, opts.maxLength);
    return {
      finalUrl: current.toString(),
      statusCode: res.statusCode,
      contentType,
      content: text,
      truncated,
    };
  }
}

// ============================================================================
// web_fetch tool
// ============================================================================

export function createWebFetchTool(): Tool {
  const parameters = Type.Object({
    url: Type.String({ description: "URL to fetch" }),
    maxLength: Type.Optional(
      Type.Number({ description: "Maximum content length (default: 10000)" }),
    ),
  });

  return {
    name: "web_fetch",
    label: "Web Fetch",
    description: "Fetch content from a URL. Returns the page content as text.",
    parameters,
    execute: async (_toolCallId, args, _signal, _onUpdate, _ctx) => {
      const params = args as Static<typeof parameters>;
      const url = params.url;
      const maxLength = Math.min(
        MAX_FETCH_BYTES,
        Math.max(100, params.maxLength ?? 10000),
      );

      try {
        new URL(url); // fail fast on unparseable input
        const res = await safeWebFetch(url, {
          maxLength,
          timeoutMs: DEFAULT_TIMEOUT_MS,
        });

        if (res.statusCode < 200 || res.statusCode >= 300) {
          return errorResult(`HTTP ${res.statusCode}`);
        }

        let content = res.content;
        if (res.contentType.includes("text/html")) {
          content = content
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim();
        }
        if (res.truncated) content += "\n...[truncated]";

        return jsonResult({
          status: "success",
          url: res.finalUrl,
          contentType: res.contentType,
          length: content.length,
          content,
        });
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  };
}
