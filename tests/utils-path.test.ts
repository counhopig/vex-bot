/**
 * Path utilities tests — expandHomePath, isPathInside.
 */

import { describe, it, expect } from "vitest";
import * as os from "os";
import * as path from "path";

describe("expandHomePath", () => {
  let expandHomePath: (p: string) => string;

  beforeAll(async () => {
    ({ expandHomePath } = await import("../src/utils/path.js"));
  });

  it("expands bare ~ to homedir", () => {
    expect(expandHomePath("~")).toBe(os.homedir());
  });

  it("expands ~/foo to homedir/foo", () => {
    expect(expandHomePath("~/foo")).toBe(os.homedir() + "/foo");
  });

  it("expands ~/foo (the canonical form on every platform)", () => {
    // On every platform, ~/foo expands to <homedir>/foo — path.join
    // uses the platform separator on output, but the *input* form
    // is always forward-slash. (The ~ + path.sep branch only matters
    // when a user has backslash-style paths on Windows.)
    expect(expandHomePath("~/foo")).toBe(path.join(os.homedir(), "foo"));
  });

  it("expands ~\\foo only when ~\\ is the platform separator", () => {
    // On Linux path.sep is '/' so ~\\foo does NOT match ~/; it's left as-is.
    // On Windows path.sep is '\\' so ~\\foo matches and gets expanded.
    if (path.sep === "/") {
      expect(expandHomePath("~\\foo")).toBe("~\\foo");
    } else {
      expect(expandHomePath("~\\foo")).toBe(path.join(os.homedir(), "foo"));
    }
  });

  it("passes through absolute paths unchanged", () => {
    expect(expandHomePath("/etc/passwd")).toBe("/etc/passwd");
  });

  it("passes through relative paths unchanged", () => {
    expect(expandHomePath("foo/bar")).toBe("foo/bar");
  });

  it("does not expand ~ inside a path (only leading ~)", () => {
    expect(expandHomePath("/foo/~bar")).toBe("/foo/~bar");
  });
});

describe("isPathInside", () => {
  let isPathInside: (parent: string, child: string) => boolean;

  beforeAll(async () => {
    ({ isPathInside } = await import("../src/utils/path.js"));
  });

  it("returns true when child equals parent", () => {
    expect(isPathInside("/foo", "/foo")).toBe(true);
  });

  it("returns true when child is inside parent", () => {
    expect(isPathInside("/foo", "/foo/bar")).toBe(true);
  });

  it("returns false when child is a sibling", () => {
    expect(isPathInside("/foo", "/bar")).toBe(false);
  });

  it("returns false when child escapes parent with ..", () => {
    expect(isPathInside("/foo", "/foo/../bar")).toBe(false);
  });

  it("returns false when child is a prefix-but-not-subpath", () => {
    expect(isPathInside("/foobar", "/foo")).toBe(false);
  });
});