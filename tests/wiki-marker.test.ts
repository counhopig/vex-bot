import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertUnchanged,
  expectedBeforeFor,
  fingerprint,
  MarkerStore,
  type FileFingerprint,
  type InFlightMarker,
} from "../src/wiki/marker.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

let dir: string;
let gitDir: string;
let store: MarkerStore;

beforeEach(async () => {
  dir = await makeTmpDir();
  gitDir = join(dir, ".git");
  mkdirSync(gitDir, { recursive: true });
  store = new MarkerStore(gitDir);
});

afterEach(async () => {
  await removeTmpDir(dir);
});

function marker(overrides: Partial<InFlightMarker> = {}): InFlightMarker {
  return {
    batchId: "b1",
    kind: "scheduled",
    advancesScan: true,
    scanBase: null,
    baseHead: "a".repeat(40),
    phase: "writing",
    commit: null,
    touched: [],
    ...overrides,
  };
}

function write(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

function fileHash(text: string): FileFingerprint {
  return { type: "file", hash: createHash("sha256").update(text).digest("hex") };
}

describe("fingerprint", () => {
  it("reports a missing file as absent and hashes a file's bytes with sha256", async () => {
    const abs = join(dir, "wiki", "a.md");
    expect(await fingerprint(abs)).toEqual({ type: "absent", hash: null });
    write(abs, "hello");
    expect(await fingerprint(abs)).toEqual(fileHash("hello"));
  });
});

describe("assertUnchanged", () => {
  it("resolves while the file still matches the recorded fingerprint", async () => {
    const abs = join(dir, "wiki", "a.md");
    write(abs, "A");
    const a = await fingerprint(abs);
    await expect(assertUnchanged(abs, a)).resolves.toBeUndefined();
    await expect(assertUnchanged(abs, { type: "absent", hash: null })).rejects.toThrow();
  });

  it("throws when an external edit intervenes between recording and overwriting", async () => {
    const abs = join(dir, "wiki", "a.md");
    await store.begin(marker());
    write(abs, "A");
    const a = await fingerprint(abs);
    await store.recordIntent(abs, { type: "absent", hash: null });
    await store.recordAfter(abs, a);
    write(abs, "B");
    await expect(assertUnchanged(abs, a)).rejects.toThrow();
  });
});

describe("MarkerStore", () => {
  it("records the intent before a write and the after fingerprint afterwards", async () => {
    const abs = join(dir, "wiki", "a.md");
    await store.begin(marker());
    expect((await store.read())?.phase).toBe("writing");
    await store.recordIntent(abs, { type: "absent", hash: null });
    write(abs, "A");
    const after = fileHash("A");
    await store.recordAfter(abs, after);
    expect((await store.read())?.touched).toEqual([{ path: abs, expectedBefore: { type: "absent", hash: null }, after }]);
  });

  it("keeps an intent with no after distinguishable from a completed write", async () => {
    const abs = join(dir, "wiki", "a.md");
    await store.begin(marker());
    await store.recordIntent(abs, { type: "absent", hash: null });
    const read = await store.read();
    expect(read?.touched).toEqual([{ path: abs, expectedBefore: { type: "absent", hash: null } }]);
    expect(read?.touched[0]?.after).toBeUndefined();
  });

  it("upserts one entry per path", async () => {
    const abs = join(dir, "wiki", "a.md");
    await store.begin(marker());
    await store.recordIntent(abs, { type: "absent", hash: null });
    write(abs, "A");
    await store.recordAfter(abs, fileHash("A"));
    await store.recordIntent(abs, { type: "file", hash: "replacement" });
    expect((await store.read())?.touched).toEqual([{ path: abs, expectedBefore: { type: "file", hash: "replacement" } }]);
  });

  it("round-trips begin, setCommitted and remove", async () => {
    const m = marker();
    await store.begin(m);
    expect(await store.read()).toEqual(m);
    await store.setCommitted("c".repeat(40));
    const committed = await store.read();
    expect(committed?.phase).toBe("committed");
    expect(committed?.commit).toBe("c".repeat(40));
    await store.remove();
    expect(await store.read()).toBeNull();
  });

  it("reads a missing or corrupt marker file as null", async () => {
    expect(await store.read()).toBeNull();
    writeFileSync(join(gitDir, "vex-wiki-inflight.json"), "{not json");
    expect(await store.read()).toBeNull();
  });
});

describe("expectedBeforeFor", () => {
  it("uses the baseline for the first touch and the last recorded after later", async () => {
    const abs = join(dir, "wiki", "a.md");
    const baseline: FileFingerprint = { type: "file", hash: "baseline" };
    expect(expectedBeforeFor(marker(), abs, baseline)).toEqual(baseline);
    await store.begin(marker());
    await store.recordIntent(abs, baseline);
    const after = fileHash("A");
    await store.recordAfter(abs, after);
    expect(expectedBeforeFor((await store.read())!, abs, baseline)).toEqual(after);
  });

  it("refuses to infer the next expected version from baseline after an incomplete intent", async () => {
    const abs = join(dir, "wiki", "a.md");
    const baseline: FileFingerprint = { type: "file", hash: "baseline" };
    await store.begin(marker());
    await store.recordIntent(abs, baseline);
    const current = (await store.read())!;
    expect(() => expectedBeforeFor(current, abs, baseline)).toThrow("incomplete write intent");
  });
});
