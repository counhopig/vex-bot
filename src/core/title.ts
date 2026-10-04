import type { Api, Model } from "@earendil-works/pi-ai";
import type { CompleteFn } from "../providers/models.js";

export function cleanTitle(raw: string): string {
  const firstLine = raw.trim().split("\n")[0] ?? "";
  return firstLine
    .replace(/^(?:标题|title)[:：]\s*/i, "")
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
        systemPrompt: "You title a conversation. Output only the title, in the language the conversation uses, at most 6 words (or 12 Chinese characters), without quotation marks or ending punctuation.",
        messages: [
          {
            role: "user",
            content: `Owner: ${userText.slice(0, 500)}\nAssistant: ${assistantText.slice(0, 500)}`,
            timestamp: Date.now(),
          },
        ],
      },
      { apiKey: opts.getApiKey(opts.model.provider), maxTokens: 256 },
    );
    if (result.stopReason === "error" || result.stopReason === "aborted") {
      throw new Error(`Title generation failed: ${result.errorMessage ?? result.stopReason}`);
    }
    const title = cleanTitle(result.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join(""));
    if (!title) throw new Error("Title generation failed: the model returned nothing");
    return title;
  };
}
