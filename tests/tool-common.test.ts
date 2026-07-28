/**
 * Tool common utilities tests — result builders, param readers, truncation.
 */

import { describe, it, expect } from "vitest";

describe("jsonResult", () => {
  it("returns a JSON-formatted text result", async () => {
    const { jsonResult } = await import("../src/tools/common.js");
    const r = jsonResult({ key: "value" });
    expect(r.content).toEqual([{ type: "text", text: '{\n  "key": "value"\n}' }]);
    expect(r.details).toEqual({ key: "value" });
    expect(r.isError).toBe(false);
  });

  it("marks isError when true", async () => {
    const { jsonResult } = await import("../src/tools/common.js");
    const r = jsonResult({ error: "fail" }, true);
    expect(r.isError).toBe(true);
  });
});

describe("textResult", () => {
  it("returns plain text content", async () => {
    const { textResult } = await import("../src/tools/common.js");
    const r = textResult("plain text", { lines: 10 });
    expect(r.content).toEqual([{ type: "text", text: "plain text" }]);
    expect(r.details).toEqual({ lines: 10 });
    expect(r.isError).toBe(false);
  });

  it("defaults details to {} when omitted", async () => {
    const { textResult } = await import("../src/tools/common.js");
    const r = textResult("no details");
    expect(r.details).toEqual({});
  });

  it("marks isError when true", async () => {
    const { textResult } = await import("../src/tools/common.js");
    const r = textResult("fail", {}, true);
    expect(r.isError).toBe(true);
  });
});

describe("errorResult", () => {
  it("returns structured error from string", async () => {
    const { errorResult } = await import("../src/tools/common.js");
    const r = errorResult("timeout");
    expect(r.isError).toBe(true);
    expect(r.details).toEqual({ status: "error", error: "timeout" });
    expect(r.content[0]?.text).toContain('"status": "error"');
  });

  it("extracts message from Error instance", async () => {
    const { errorResult } = await import("../src/tools/common.js");
    const r = errorResult(new Error("boom"));
    expect(r.details).toEqual({ status: "error", error: "boom" });
  });
});

describe("imageResult", () => {
  it("returns text prefix + image content block", async () => {
    const { imageResult } = await import("../src/tools/common.js");
    const r = imageResult({
      label: "screenshot",
      base64: "aGVsbG8=",
      mimeType: "image/png",
      extraText: "Here is a screenshot",
      details: { width: 100 },
    });
    expect(r.content).toEqual([
      { type: "text", text: "Here is a screenshot" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    ]);
    expect(r.details).toEqual({ width: 100 });
  });

  it("uses default label text when extraText is omitted", async () => {
    const { imageResult } = await import("../src/tools/common.js");
    const r = imageResult({ label: "pic", base64: "x", mimeType: "image/jpeg" });
    expect(r.content[0]).toEqual({ type: "text", text: "[Image: pic]" });
  });
});

describe("param readers", () => {
  describe("readStringParam", () => {
    let readStringParam: (p: Record<string, unknown>, k: string, o?: { required?: boolean; trim?: boolean; label?: string }) => string | undefined;

    it("reads a string value", async () => {
      ({ readStringParam } = await import("../src/tools/common.js"));
      expect(readStringParam({ name: "hello" }, "name")).toBe("hello");
    });

    it("trims by default", async () => {
      ({ readStringParam } = await import("../src/tools/common.js"));
      expect(readStringParam({ name: "  hello  " }, "name")).toBe("hello");
    });

    it("throws when required param is missing", async () => {
      ({ readStringParam } = await import("../src/tools/common.js"));
      expect(() => readStringParam({}, "name", { required: true }))
        .toThrow("name is required");
    });

    it("throws when required param is empty after trim", async () => {
      ({ readStringParam } = await import("../src/tools/common.js"));
      expect(() => readStringParam({ name: "  " }, "name", { required: true }))
        .toThrow("name is required");
    });

    it("uses label in error message when provided", async () => {
      ({ readStringParam } = await import("../src/tools/common.js"));
      expect(() => readStringParam({}, "url", { required: true, label: "URL" }))
        .toThrow("URL is required");
    });

    it("returns undefined for non-string value", async () => {
      ({ readStringParam } = await import("../src/tools/common.js"));
      expect(readStringParam({ name: 42 }, "name")).toBeUndefined();
    });

    it("keeps leading/trailing whitespace when trim is false", async () => {
      ({ readStringParam } = await import("../src/tools/common.js"));
      expect(readStringParam({ name: "  hi  " }, "name", { trim: false })).toBe("  hi  ");
    });
  });

  describe("readNumberParam", () => {
    let readNumberParam: (p: Record<string, unknown>, k: string, o?: { required?: boolean; min?: number; max?: number; label?: string }) => number | undefined;

    it("reads a number value", async () => {
      ({ readNumberParam } = await import("../src/tools/common.js"));
      expect(readNumberParam({ count: 5 }, "count")).toBe(5);
    });

    it("coerces string to number", async () => {
      ({ readNumberParam } = await import("../src/tools/common.js"));
      expect(readNumberParam({ count: "10" }, "count")).toBe(10);
    });

    it("throws when required param is missing", async () => {
      ({ readNumberParam } = await import("../src/tools/common.js"));
      expect(() => readNumberParam({}, "count", { required: true }))
        .toThrow("count is required");
    });

    it("throws when value is NaN", async () => {
      ({ readNumberParam } = await import("../src/tools/common.js"));
      expect(() => readNumberParam({ count: "abc" }, "count"))
        .toThrow("count must be a number");
    });

    it("validates min constraint", async () => {
      ({ readNumberParam } = await import("../src/tools/common.js"));
      expect(() => readNumberParam({ count: 0 }, "count", { min: 1 }))
        .toThrow("count must be >= 1");
    });

    it("validates max constraint", async () => {
      ({ readNumberParam } = await import("../src/tools/common.js"));
      expect(() => readNumberParam({ count: 11 }, "count", { max: 10 }))
        .toThrow("count must be <= 10");
    });

    it("returns undefined for undefined/null", async () => {
      ({ readNumberParam } = await import("../src/tools/common.js"));
      expect(readNumberParam({ count: undefined }, "count")).toBeUndefined();
      expect(readNumberParam({ count: null }, "count")).toBeUndefined();
    });
  });

  describe("readBooleanParam", () => {
    let readBooleanParam: (p: Record<string, unknown>, k: string, o?: { defaultValue?: boolean }) => boolean;

    it("reads true/false", async () => {
      ({ readBooleanParam } = await import("../src/tools/common.js"));
      expect(readBooleanParam({ flag: true }, "flag")).toBe(true);
      expect(readBooleanParam({ flag: false }, "flag")).toBe(false);
    });

    it("returns defaultValue for undefined", async () => {
      ({ readBooleanParam } = await import("../src/tools/common.js"));
      expect(readBooleanParam({}, "flag", { defaultValue: true })).toBe(true);
      expect(readBooleanParam({}, "flag")).toBe(false);
    });

    it("coerces 'true'/'1' strings", async () => {
      ({ readBooleanParam } = await import("../src/tools/common.js"));
      expect(readBooleanParam({ flag: "true" }, "flag")).toBe(true);
      expect(readBooleanParam({ flag: "1" }, "flag")).toBe(true);
      expect(readBooleanParam({ flag: "false" }, "flag")).toBe(false);
    });
  });

  describe("readStringArrayParam", () => {
    let readStringArrayParam: (p: Record<string, unknown>, k: string, o?: { required?: boolean; label?: string }) => string[] | undefined;

    it("reads a string array", async () => {
      ({ readStringArrayParam } = await import("../src/tools/common.js"));
      expect(readStringArrayParam({ tags: ["a", "b"] }, "tags")).toEqual(["a", "b"]);
    });

    it("splits comma-separated string", async () => {
      ({ readStringArrayParam } = await import("../src/tools/common.js"));
      expect(readStringArrayParam({ tags: "a, b, c" }, "tags")).toEqual(["a", "b", "c"]);
    });

    it("throws when required and missing", async () => {
      ({ readStringArrayParam } = await import("../src/tools/common.js"));
      expect(() => readStringArrayParam({}, "tags", { required: true })).toThrow("tags is required");
    });

    it("throws for non-array, non-string values", async () => {
      ({ readStringArrayParam } = await import("../src/tools/common.js"));
      expect(() => readStringArrayParam({ tags: 42 }, "tags")).toThrow("must be an array");
    });
  });
});

describe("truncateToolText", () => {
  it("returns text unchanged when within limit", async () => {
    const { truncateToolText } = await import("../src/tools/common.js");
    expect(truncateToolText("short", 8000)).toBe("short");
  });

  it("truncates long text and appends marker", async () => {
    const { truncateToolText } = await import("../src/tools/common.js");
    const long = "a".repeat(100);
    const r = truncateToolText(long, 50);
    expect(r).toHaveLength(50 + "\n...[truncated]".length);
    expect(r).toMatch(/\.\.\.\[truncated\]$/);
  });

  it("uses default maxLength of 8000", async () => {
    const { truncateToolText } = await import("../src/tools/common.js");
    const text = "x".repeat(9000);
    const r = truncateToolText(text);
    expect(r.length).toBeLessThan(9000);
    expect(r.length).toBe(8000 + "\n...[truncated]".length);
  });
});
