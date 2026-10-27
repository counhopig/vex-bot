import { describe, expect, it } from "vitest";
import { createHeartbeatReportTool, heartbeatMessage, type HeartbeatOutcome } from "../src/tools/heartbeat.js";

describe("heartbeat outcome", () => {
  it("follows the report tool, whatever the reply says", async () => {
    const outcome: HeartbeatOutcome = {};
    const tool = createHeartbeatReportTool(outcome);
    await tool.execute("1", { notify: false });
    expect(heartbeatMessage(outcome, "All checked, nothing urgent. Have a good day!")).toBeNull();
    await tool.execute("2", { notify: true, message: " 下午三点开会 " });
    expect(heartbeatMessage(outcome, "HEARTBEAT_OK")).toBe("下午三点开会");
  });

  it("refuses a notification without a message", async () => {
    const tool = createHeartbeatReportTool({});
    await expect(tool.execute("1", { notify: true })).rejects.toThrow("message is required");
  });

  it("falls back to the reply when the tool was never called", () => {
    expect(heartbeatMessage({}, "HEARTBEAT_OK")).toBeNull();
    expect(heartbeatMessage({}, " **heartbeat_ok.** ")).toBeNull();
    expect(heartbeatMessage({}, "  ")).toBeNull();
    expect(heartbeatMessage({}, "今天有预约")).toBe("今天有预约");
    // A reminder that mentions the token is still a reminder.
    const reminder = "Reminder: the tax filing is due tomorrow at 9:00. Everything else: HEARTBEAT_OK";
    expect(heartbeatMessage({}, reminder)).toBe(reminder);
  });
});
