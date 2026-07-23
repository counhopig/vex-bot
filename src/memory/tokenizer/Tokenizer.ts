/**
 * Tokenizer interface
 *
 * Abstracts text tokenization for memory search and embedding. The primary
 * implementation (CJKTokenizer) handles both Latin whitespace-split and CJK
 * bigram strategies so that Chinese/Japanese/Korean text is not silently
 * collapsed into a single useless token like the old split(/\s+/) did.
 */

export interface Tokenizer {
  /** Split text into tokens. */
  tokenize(text: string): string[];
}
