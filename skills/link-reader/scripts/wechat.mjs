import TurndownService from "turndown";
import { BROWSER_UA, firstUrl, hostMatches } from "./shared.mjs";

const HOSTS = ["mp.weixin.qq.com"];

export const wechat = {
  name: "WeChat",
  hosts: HOSTS,
  match: (text) => hostMatches(firstUrl(text) ?? "", HOSTS),
  async read(text, http) {
    const page = await http.get(firstUrl(text), { "User-Agent": BROWSER_UA });
    const converter = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
    converter.remove(["script", "style", "noscript", "iframe"]);
    const fields = {};
    converter.addRule("articleFields", {
      filter: (node) => ["js_content", "activity-name", "js_name", "js_author_name"].includes(node.id),
      replacement: (content, node) => {
        fields[node.id] = node.id === "js_content" ? content.trim() : node.textContent.trim();
        return content;
      },
    });
    converter.turndown(page.body);
    if (!fields.js_content) throw new Error("WeChat article has no readable body; it may require verification, be deleted or be unavailable");
    return {
      platform: "WeChat",
      title: fields["activity-name"] ?? "",
      author: fields.js_name ?? fields.js_author_name ?? "",
      url: page.url,
      text: fields.js_content,
      textKind: "article",
    };
  },
};
