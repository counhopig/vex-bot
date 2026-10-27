/**
 * A URL as written in chat. It ends at whitespace, quotes, angle brackets, CJK text or full-width
 * punctuation, so "https://a.example/x帮我存一下" yields the link alone.
 */
export const URL_IN_TEXT = /https?:\/\/[^\s<>"'　-〿぀-ヿ㐀-䶿一-鿿가-힯豈-﫿＀-￯]+/g;

/** The distinct links in a message, without trailing sentence punctuation. */
export function extractUrls(text: string): string[] {
  return [...new Set((text.match(URL_IN_TEXT) ?? []).map((url) => url.replace(/[),.!?]+$/, "")))];
}
