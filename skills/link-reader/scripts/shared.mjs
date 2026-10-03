export const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
export const MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";

export function firstUrl(text) {
  return /https?:\/\/[^\s"'<>，。！？、）)]+/.exec(text)?.[0];
}

export function hostMatches(url, suffixes) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}

export function parseJson(body, what) {
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${what}返回的内容无法解析`);
  }
}

export async function mapLimited(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index], index);
    }
  }));
  return results;
}
