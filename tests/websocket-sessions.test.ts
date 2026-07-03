import { describe, expect, it } from "vitest";
import { filterWebChatSessions } from "../src/web/websocket.js";
import type { SessionListItem } from "../src/sessions/types.js";

describe("websocket sessions", () => {
  it("only exposes WebChat sessions to the webpage", () => {
    const sessions: SessionListItem[] = [
      {
        sessionKey: "weixin:user-1",
        sessionId: "wx-1",
        updatedAt: 300,
      },
      {
        sessionKey: "webchat:user-2",
        sessionId: "web-2",
        updatedAt: 200,
      },
      {
        sessionKey: "weixin:group-1",
        sessionId: "wx-2",
        updatedAt: 100,
      },
      {
        sessionKey: "webchat:user-3",
        sessionId: "web-3",
        updatedAt: 50,
      },
    ];

    expect(filterWebChatSessions(sessions)).toEqual([
      sessions[1],
      sessions[3],
    ]);
  });

  it("applies list limits after filtering non-WebChat sessions", () => {
    const sessions: SessionListItem[] = [
      {
        sessionKey: "weixin:newer",
        sessionId: "wx-1",
        updatedAt: 300,
      },
      {
        sessionKey: "webchat:first",
        sessionId: "web-1",
        updatedAt: 200,
      },
      {
        sessionKey: "webchat:second",
        sessionId: "web-2",
        updatedAt: 100,
      },
    ];

    expect(filterWebChatSessions(sessions, 1)).toEqual([sessions[1]]);
  });
});
