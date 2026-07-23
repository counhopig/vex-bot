/**
 * CJKTokenizer — CJK-aware tokenizer with bigram fallback.
 *
 * Problem: The old SimpleEmbedding used split(/\s+/) which collapses
 * Chinese text like "用户名字" into a single token that matches nothing.
 *
 * Solution: For each whitespace-delimited segment:
 *   1. Extract CJK character runs (U+4E00–U+9FFF).
 *   2. For runs ≥ 3 characters, generate overlapping character bigrams:
 *      "用户名字" → ["用户", "户名", "名字"]
 *   3. Runs of 1–2 characters are kept as-is.
 *   4. Non-CJK parts within a segment (Latin text, digits) are lowercased
 *      and kept as individual tokens after stripping punctuation.
 *
 * This ensures both "hello world" and "你好世界" produce useful tokens
 * for search and embedding.
 */

import type { Tokenizer } from "./Tokenizer.js";

// Regex: CJK Unified Ideographs block
const CJK_RE = /[\u4e00-\u9fff]/;

// Match one or more consecutive CJK characters.
const CJK_RUN_RE = /[\u4e00-\u9fff]+/g;

// Strip punctuation that is neither word character nor CJK — keeps
// CJK characters, Latin letters, digits, and whitespace.
const PUNCTUATION_RE = /[^\w\s\u4e00-\u9fff]/g;

export class CJKTokenizer implements Tokenizer {
  tokenize(text: string): string[] {
    if (!text) return [];

    const tokens: string[] = [];

    // Step 1: split on whitespace to isolate segments
    const segments = text.trim().split(/\s+/);

    for (const segment of segments) {
      if (!segment) continue;
      this.tokenizeSegment(segment, tokens);
    }

    return tokens;
  }

  private tokenizeSegment(segment: string, out: string[]): void {
    if (!CJK_RE.test(segment)) {
      // Pure non-CJK segment: lowercase and strip punctuation
      const cleaned = segment.toLowerCase().replace(PUNCTUATION_RE, "");
      if (cleaned) out.push(cleaned);
      return;
    }

    // Segment contains CJK — extract CJK runs and non-CJK parts separately.
    let lastEnd = 0;

    for (const match of segment.matchAll(CJK_RUN_RE)) {
      const cjkRun = match[0];
      const runStart = match.index!;

      // Emit any non-CJK text before this CJK run
      if (runStart > lastEnd) {
        const before = segment.slice(lastEnd, runStart);
        const cleaned = before.toLowerCase().replace(PUNCTUATION_RE, "");
        if (cleaned) out.push(cleaned);
      }

      // Emit the CJK run with bigram decomposition
      this.emitCJK(cjkRun, out);

      lastEnd = runStart + cjkRun.length;
    }

    // Emit any remaining non-CJK text after the last CJK run
    if (lastEnd < segment.length) {
      const after = segment.slice(lastEnd);
      const cleaned = after.toLowerCase().replace(PUNCTUATION_RE, "");
      if (cleaned) out.push(cleaned);
    }
  }

  private emitCJK(cjk: string, out: string[]): void {
    if (cjk.length <= 2) {
      // 1–2 character CJK: keep as a single token
      out.push(cjk);
      return;
    }

    // 3+ characters: generate overlapping character bigrams
    for (let i = 0; i < cjk.length - 1; i++) {
      out.push(cjk.slice(i, i + 2));
    }
  }
}

/** Convenience: one-shot tokenization without instantiating. */
export function tokenize(text: string): string[] {
  return new CJKTokenizer().tokenize(text);
}
