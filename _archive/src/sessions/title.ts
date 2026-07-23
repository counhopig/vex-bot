/**
 * Session title generation.
 *
 * After the first exchange in a WebChat session we ask the agent's default model
 * for a short summary to use as the sidebar title. Kept separate from the WS
 * handler so the pure formatting (`sanitizeTitle`) and the LLM call are testable
 * in isolation.
 */

import type { ProviderId } from "../types/index.js";
import { llmComplete } from "../providers/llm.js";
import { getChildLogger } from "../utils/logger.js";

const logger = getChildLogger("session-title");

const DEFAULT_MAX_LEN = 30;

/** Trim model output into a clean one-line title (no fences, quotes, or newlines). */
export function sanitizeTitle(raw: string, maxLen: number = DEFAULT_MAX_LEN): string {
  let s = (raw ?? "").trim();
  if (!s) return "";
  // Unwrap a ```...``` code fence if the model wrapped the title in one.
  const fence = s.match(/```(?:[a-zA-Z]*)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1]!.trim();
  // Strip one layer of surrounding quotes (ASCII and CJK).
  s = s.replace(/^["'“”「」『』]+|["'“”「」『』]+$/g, "").trim();
  // Collapse all internal whitespace (incl. newlines) to single spaces.
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}

export interface GenerateTitleOptions {
  provider: ProviderId;
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
 * Generate a session title from the first exchange. Returns null on any failure
 * or an empty result so the caller can simply leave the session untitled.
 */
export async function generateSessionTitle(opts: GenerateTitleOptions): Promise<string | null> {
  try {
    const result = await llmComplete({
      providerId: opts.provider,
      model: opts.model,
      prompt: buildTitlePrompt(opts.userText, opts.assistantText),
      temperature: 0.3,
      maxTokens: 32,
    });
    const title = sanitizeTitle(result.text, opts.maxLen ?? DEFAULT_MAX_LEN);
    return title.length > 0 ? title : null;
  } catch (error) {
    logger.debug({ error: error instanceof Error ? error.message : String(error) }, "Session title generation failed");
    return null;
  }
}
