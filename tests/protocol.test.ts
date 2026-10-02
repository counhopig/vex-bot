import { describe, expect, it } from "vitest";
import { parseClientMessage } from "../src/protocol/messages.js";

describe("parseClientMessage", () => {
  it("accepts every client message shape", () => {
    const valid = [
      { type: "open", sessionId: "s" },
      { type: "send", sessionId: "s", text: "你好" },
      { type: "stop", sessionId: "s" },
      { type: "create_session" },
      { type: "rename_session", sessionId: "s", title: "t" },
      { type: "delete_session", sessionId: "s" },
      { type: "approve", id: "a", answer: "allow_session" },
      { type: "get_config" },
      { type: "save_config", text: "model: {}" },
    ];
    for (const message of valid) expect(parseClientMessage(JSON.stringify(message))).toEqual(message);
  });

  it("rejects malformed input", () => {
    expect(parseClientMessage("not json")).toBeUndefined();
    expect(parseClientMessage(JSON.stringify({ type: "send", sessionId: "s", text: "" }))).toBeUndefined();
    expect(parseClientMessage(JSON.stringify({ type: "approve", id: "a", answer: "maybe" }))).toBeUndefined();
    expect(parseClientMessage(JSON.stringify({ type: "unknown" }))).toBeUndefined();
  });
});
