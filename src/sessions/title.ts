/**
 * Session title generation.
 *
 * After the first exchange in a WebChat session we ask the agent's
 * default model for a short summary to use as the sidebar title.
 * `sanitizeTitle` is a pure formatter (no I/O) so it's straightforward
 * to test; `generateSessionTitle` delegates the actual LLM call to a
 * caller-injected function so the title module stays decoupled from
 * the ModelResolver wiring (which the web bootstrap will pass in).
 *
 * The default no-llm-injected path returns null — the caller can then
 * fall back to a derived title (e.g. first 30 chars of the user text).
 */

import { getChildLogger } from "../utils/logger.js";

const logger = getChildLogger("session-title");

/** Default max title length. */
export const DEFAULT_MAX_TITLE_LEN = 30;

/** Minimal LLM response shape this module consumes. */
export interface LlmCompleteResult {
  text: string;
}

/** Injection seam: any callable that takes a prompt and returns text. */
export type LlmCompleteLike = (opts: {
  provider: string;
  model: string;
  prompt: string;
  temperature: number;
  maxTokens: number;
}) => Promise<LlmCompleteResult>;

/** Trim model output into a clean one-line title (no fences, quotes, or newlines). */
export function sanitizeTitle(raw: string, maxLen: number = DEFAULT_MAX_TITLE_LEN): string {
  let s = (raw ?? "").trim();
  if (!s) return "";
  // Unwrap a ```...``` code fence if the model wrapped the title in one.
  const fence = s.match(/```(?:[a-zA-Z]*)?\s*([\s\S]*?)```/);
  if (fence && fence[1]) s = fence[1].trim();
  // Strip one layer of surrounding quotes (ASCII and CJK).
  s = s
    .replace(/^["'“”「」『』]+|["'“”「」『』]+$/g, "")
    .trim();
  // Collapse all internal whitespace (incl. newlines) to single spaces.
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}

export interface GenerateTitleOptions {
  provider: string;
  model: string;
  userText: string;
  assistantText: string;
  maxLen?: number;
}

function buildTitlePrompt(userText: string, assistantText: string): string {
  return [
    "为下面这段对话拟一个简短的标题（不超过16个字），概括聊天主题。",
    "要求：跟随对话使用的语言；只输出标题本身；不要引号、标点结尾、Markdown 或解释。",
    "",
    `用户：${userText}`,
    `助手：${assistantText}`,
  ].join("\n");
}

/**
 * Generate a session title from the first exchange. Returns null on any
 * failure, an empty sanitized result, or when no LLM function is injected
 * (caller then falls back to a derived default). The LLM function is
 * injected so the title module has no implicit dependency on the
 * ModelResolver or any provider internals.
 */
export async function generateSessionTitle(
  opts: GenerateTitleOptions,
  llm?: LlmCompleteLike,
): Promise<string | null> {
  if (!llm) return null;
  try {
    const result = await llm({
      provider: opts.provider,
      model: opts.model,
      prompt: buildTitlePrompt(opts.userText, opts.assistantText),
      temperature: 0.3,
      maxTokens: 32,
    });
    const title = sanitizeTitle(result.text, opts.maxLen ?? DEFAULT_MAX_TITLE_LEN);
    return title.length > 0 ? title : null;
  } catch (error) {
    logger.debug(
      { error: error instanceof Error ? error.message : String(error) },
      "Session title generation failed",
    );
    return null;
  }
}
