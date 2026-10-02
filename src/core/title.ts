import type { Api, Model } from "@earendil-works/pi-ai";
import type { CompleteFn } from "../providers/models.js";

export function cleanTitle(raw: string): string {
  const firstLine = raw.trim().split("\n")[0] ?? "";
  return firstLine
    .replace(/^标题[:：]\s*/, "")
    .replace(/["'“”‘’「」《》]/g, "")
    .trim()
    .slice(0, 20);
}

export function createTitleGenerator(opts: {
  model: Model<Api>;
  complete: CompleteFn;
  getApiKey: (provider: string) => string | undefined;
}): (userText: string, assistantText: string) => Promise<string> {
  return async (userText, assistantText) => {
    const result = await opts.complete(
      opts.model,
      {
        systemPrompt: "你为一段对话起标题。只输出标题本身，不超过 12 个字，不加引号和句末标点。",
        messages: [
          {
            role: "user",
            content: `主人：${userText.slice(0, 500)}\n助手：${assistantText.slice(0, 500)}`,
            timestamp: Date.now(),
          },
        ],
      },
      { apiKey: opts.getApiKey(opts.model.provider), maxTokens: 256 },
    );
    if (result.stopReason === "error" || result.stopReason === "aborted") {
      throw new Error(`生成标题失败：${result.errorMessage ?? result.stopReason}`);
    }
    const title = cleanTitle(result.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join(""));
    if (!title) throw new Error("生成标题失败：模型返回为空");
    return title;
  };
}