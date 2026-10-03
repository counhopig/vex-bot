const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|(?:(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])[\p{L}\p{N}_])+/gu;
const IS_CJK = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

// Indexing also emits single CJK characters so one-character queries match.
export function tokenize(text: string, unigrams = false): string[] {
  return [...text.matchAll(CJK)].flatMap(([word]) => {
    if (!IS_CJK.test(word)) return [word.toLowerCase()];
    const chars = [...word];
    if (chars.length === 1) return chars;
    const bigrams = chars.slice(0, -1).map((char, i) => char + chars[i + 1]);
    return unigrams ? [...bigrams, ...chars] : bigrams;
  });
}

export function markdownChunks(text: string): string[] {
  const chunks: string[] = [];
  let heading = "";
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) chunks.push([heading, paragraph.join("\n")].filter(Boolean).join("\n"));
    paragraph = [];
  };
  for (const line of text.split(/\r?\n/)) {
    if (/^#{1,6}\s/.test(line)) { flush(); heading = line; }
    else if (!line.trim()) flush();
    else paragraph.push(line);
  }
  flush();
  if (!chunks.length && heading) chunks.push(heading);
  return chunks;
}
