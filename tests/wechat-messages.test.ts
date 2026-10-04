import { describe, expect, it } from "vitest";
import {
  extractText,
  formatApprovalPrompt,
  formatClock,
  parseCommand,
  splitMessage,
} from "../src/channels/wechat/messages.js";
import type { ApprovalRequest } from "../src/policy/approvals.js";

describe("extractText", () => {
  it("joins text and labels media", () => {
    expect(
      extractText([
        { type: 1, text_item: { text: "看这个" } },
        { type: 2 },
        { type: 3, voice_item: { text: "语音转文字" } },
        { type: 3 },
        { type: 4 },
        { type: 5 },
        { type: 99 },
        { type: 1, text_item: { text: "  " } },
      ]),
    ).toBe("看这个\n[image]\n语音转文字\n[voice]\n[file]\n[video]");
  });
});

describe("parseCommand", () => {
  it("recognizes owner commands with either slash", () => {
    expect(parseCommand("/stop")).toEqual({ kind: "stop" });
    expect(parseCommand(" /Y ")).toEqual({ kind: "approve", answer: "allow" });
    expect(parseCommand("／ya")).toEqual({ kind: "approve", answer: "allow_session" });
    expect(parseCommand("/n")).toEqual({ kind: "approve", answer: "deny" });
  });

  it("treats everything else as chat", () => {
    expect(parseCommand("/yes please")).toEqual({ kind: "chat", text: "/yes please" });
    expect(parseCommand("你好")).toEqual({ kind: "chat", text: "你好" });
  });
});

describe("splitMessage", () => {
  it("keeps short text whole and drops blank text", () => {
    expect(splitMessage("  短消息 ")).toEqual(["短消息"]);
    expect(splitMessage("   ")).toEqual([]);
  });

  it("prefers line breaks and never exceeds the limit", () => {
    const text = `${"a".repeat(8)}\n${"b".repeat(8)}\n${"c".repeat(3)}`;
    expect(splitMessage(text, 10)).toEqual(["aaaaaaaa", "bbbbbbbb", "ccc"]);
    expect(splitMessage("x".repeat(25), 10)).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
  });

  it("never splits a surrogate pair when cutting at max", () => {
    const text = "x".repeat(9) + "😀" + "y";
    const chunks = splitMessage(text, 10);
    // The emoji spans indices 9-10.
    expect(chunks.every(chunk => chunk.length <= 10)).toBe(true);
    expect(chunks.join("")).toBe(text);
    const loneSurrogateRegex = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(chunks.every(chunk => !loneSurrogateRegex.test(chunk))).toBe(true);
  });

  it("always makes progress, even when a surrogate pair exceeds max", () => {
    expect(splitMessage("😀a", 1)).toEqual(["😀", "a"]);
    expect(splitMessage("abc", 1)).toEqual(["a", "b", "c"]);
  });
});

describe("formatApprovalPrompt", () => {
  const request: ApprovalRequest = {
    id: "a1",
    sessionKey: "web:1",
    windowLabel: "WebChat conversation 'Tidy'",
    toolName: "bash",
    summary: "ls",
    detail: "ls -la",
    createdAt: Date.UTC(2026, 9, 3, 6, 0),
    expiresAt: Date.UTC(2026, 9, 3, 6, 10),
  };

  it("names the source, tool, command and deadline", () => {
    expect(formatApprovalPrompt(request, 1, "Asia/Shanghai")).toBe(
      "[Approval needed] WebChat conversation 'Tidy' wants to run bash:\nls -la\nReply /y to allow, /ya to always allow in this conversation, /n to deny (denied automatically if there is no answer by 14:10)",
    );
  });

  it("mentions the queue and truncates long details", () => {
    const text = formatApprovalPrompt({ ...request, detail: "x".repeat(2000) }, 3, "Asia/Shanghai");
    expect(text).toContain(`${"x".repeat(1500)}\n… (content too long; see the full text in WebChat)`);
    expect(text.endsWith("(3 approvals are pending; they are handled in order)")).toBe(true);
    expect(text.length).toBeLessThan(2000);
  });

  it("formats clock times in 24-hour form", () => {
    expect(formatClock(Date.UTC(2026, 9, 3, 16, 5), "Asia/Shanghai")).toBe("00:05");
  });

  it("never splits a surrogate pair when truncating detail at 1500", () => {
    // The emoji spans indices 1499-1500.
    const detail = "a".repeat(1499) + "😀" + "b".repeat(100);
    const text = formatApprovalPrompt({ ...request, detail }, 1, "Asia/Shanghai");
    const loneSurrogateRegex = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(loneSurrogateRegex.test(text)).toBe(false);
  });
});
