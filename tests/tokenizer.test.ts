/**
 * Tokenizer tests — CJK bigram + whitespace Latin tokenization.
 *
 * The CJKTokenizer must correctly handle:
 *   - Latin text: split on whitespace, lowercase
 *   - CJK text: overlapping character bigrams for 3+ char runs
 *   - Mixed Latin + CJK: both strategies combined
 *   - Edge cases: empty string, single chars, 2-char CJK
 */

import { describe, it, expect } from "vitest";
import { CJKTokenizer } from "../src/memory/tokenizer/CJKTokenizer.js";

describe("CJKTokenizer", () => {
  const t = new CJKTokenizer();

  it("splits Latin text on whitespace and lowercases", () => {
    expect(t.tokenize("hello world")).toEqual(["hello", "world"]);
    expect(t.tokenize("Hello World")).toEqual(["hello", "world"]);
  });

  it("generates overlapping bigrams for 3+ char CJK text", () => {
    // "用户名字" (4 CJK chars) → ["用户", "户名", "名字"]
    const result = t.tokenize("用户名字");
    expect(result).toEqual(["用户", "户名", "名字"]);
  });

  it("preserves 2-char CJK as a single token", () => {
    expect(t.tokenize("用户")).toEqual(["用户"]);
  });

  it("preserves 1-char CJK as a single token", () => {
    expect(t.tokenize("我")).toEqual(["我"]);
  });

  it("handles mixed Latin and CJK text", () => {
    const result = t.tokenize("hello 用户名字 world");
    expect(result).toEqual(["hello", "用户", "户名", "名字", "world"]);
  });

  it("returns empty array for empty string", () => {
    expect(t.tokenize("")).toEqual([]);
  });

  it("handles CJK-only longer text with proper bigrams", () => {
    // "你好世界" (4 CJK chars) → ["你好", "好世", "世界"]
    expect(t.tokenize("你好世界")).toEqual(["你好", "好世", "世界"]);
  });

  it("strips non-alphanumeric non-CJK punctuation from Latin tokens", () => {
    const result = t.tokenize("hello!!!");
    // "hello" is a Latin word — punctuation should be separated or stripped
    expect(result).toContain("hello");
    expect(result).not.toContain("hello!!!");
  });

  it("handles text with multiple spaces between words", () => {
    expect(t.tokenize("hello   world")).toEqual(["hello", "world"]);
  });

  it("handles CJK and Latin without space between them", () => {
    // No space between Latin and CJK — mixed token
    const result = t.tokenize("hello用户");
    expect(result).toContain("hello");
    // "用户" is 2 CJK chars
    expect(result).toContain("用户");
  });

  it("strips Latin punctuation while preserving CJK integrity", () => {
    const result = t.tokenize("hello, world! 用户名字？");
    // "hello," → "hello" (comma stripped), "world!" → "world"
    // "用户名字" → bigrams, "？" stripped
    expect(result).toContain("hello");
    expect(result).toContain("world");
    expect(result).toContain("用户");
    expect(result).toContain("户名");
    expect(result).toContain("名字");
    expect(result).not.toContain("？");
  });
});
