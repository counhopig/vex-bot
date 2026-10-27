import { expect, it } from "vitest";
import { runSessionKey, scheduleTargetKey, scheduleTargetOf, webSessionId, webSessionKey } from "../src/core/sessionKey.js";

it("builds and parses WebChat and run keys", () => {
  expect(webSessionKey("abc")).toBe("web:abc");
  expect(webSessionId("web:abc")).toBe("abc");
  expect(webSessionId("wechat")).toBeUndefined();
  expect(webSessionId(runSessionKey("x"))).toBeUndefined();
});

it("maps schedule targets to session keys and back", () => {
  expect(scheduleTargetKey("wechat")).toBe("wechat");
  expect(scheduleTargetKey("device")).toBe("device");
  expect(scheduleTargetKey("abc")).toBe("web:abc");
  expect(scheduleTargetKey("web:abc")).toBe("web:abc");
  expect(scheduleTargetOf("web:abc")).toBe("abc");
  expect(scheduleTargetOf("device")).toBe("device");
  expect(scheduleTargetOf("wechat")).toBe("wechat");
  expect(scheduleTargetOf(runSessionKey("x"))).toBe("wechat");
});
