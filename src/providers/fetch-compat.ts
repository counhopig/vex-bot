/**
 * fetch-compat — non-ASCII HTTP response header workaround.
 *
 * Some Chinese API providers (MiniMax, Zhipu) return HTTP response headers
 * containing non-ASCII characters (e.g. Chinese error messages). Node's
 * undici (used by Node 24+) enforces ByteString (ISO-8859-1) on header
 * values, throwing "Cannot convert argument to a ByteString" errors.
 *
 * Ported from archive's cli/fetch-patch.ts. Moved to providers/ because this
 * is a provider-layer compatibility concern, not a CLI concern.
 */

const originalFetch = globalThis.fetch;

export function applyFetchCompatPatch(): void {
  globalThis.fetch = async function patchedFetch(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    try {
      return await originalFetch(input, init);
    } catch (err: unknown) {
      if (err instanceof TypeError && err.message.includes("ByteString")) {
        console.error(`[fetch-compat] ByteString error for ${url}, retrying with node:https`);
        return rawFetch(url, init);
      }
      throw err;
    }
  };
}

async function rawFetch(url: string, init?: RequestInit): Promise<Response> {
  const mod = url.startsWith("https") ? await import("node:https") : await import("node:http");
  const parsedUrl = new URL(url);

  return new Promise<Response>((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((v: string, k: string) => {
          headers[k] = v;
        });
      } else if (Array.isArray(init.headers)) {
        for (const pair of init.headers) {
          if (pair[0] !== undefined && pair[1] !== undefined) {
            headers[pair[0]] = pair[1];
          }
        }
      } else {
        for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
          if (v !== undefined) headers[k] = v;
        }
      }
    }

    const bodyStr = typeof init?.body === "string" ? init.body : undefined;
    const bodyBuf = bodyStr ? Buffer.from(bodyStr, "utf-8") : undefined;
    if (bodyBuf) {
      headers["content-length"] = String(bodyBuf.length);
    }

    const req = mod.request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: init?.method ?? "POST",
        headers,
      },
      (res: import("node:http").IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          const safeHeaders = new Headers();
          if (res.headers) {
            for (const [key, value] of Object.entries(res.headers)) {
              if (value === undefined) continue;
              const vals = Array.isArray(value) ? value : [value];
              for (const v of vals) {
                safeHeaders.append(key, v.replace(/[^\x00-\xff]/g, "?"));
              }
            }
          }
          resolve(
            new Response(body, {
              status: res.statusCode ?? 200,
              statusText: res.statusMessage ?? "OK",
              headers: safeHeaders,
            }),
          );
        });
        res.on("error", reject);
      },
    );

    req.on("error", reject);
    if (init?.signal) {
      init.signal.addEventListener("abort", () => req.destroy());
    }
    if (bodyBuf) {
      req.write(bodyBuf);
    }
    req.end();
  });
}
