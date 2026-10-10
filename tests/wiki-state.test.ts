import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyState, StateStore, type WikiState } from "../src/wiki/state.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

let dir: string;
let file: string;
let store: StateStore;

beforeEach(async () => {
  dir = await makeTmpDir();
  file = join(dir, "state", "wiki.json");
  store = new StateStore(file);
});

afterEach(async () => {
  await removeTmpDir(dir);
});

function state(overrides: Partial<WikiState> = {}): WikiState {
  return {
    lastScanCommit: "a".repeat(40),
    lastRunAt: 1_700_000_000_000,
    lastBatchId: "b1",
    bootstrap: "done",
    rollback: { targetBatchId: "b0", revertId: "r0" },
    nextAttemptAt: 1_700_000_100_000,
    failureStreak: 2,
    ...overrides,
  };
}

describe("emptyState", () => {
  it("returns a pending bootstrap with no cursor, rollback or failures", () => {
    expect(emptyState()).toEqual({
      lastScanCommit: null,
      lastRunAt: null,
      lastBatchId: null,
      bootstrap: "pending",
      rollback: null,
      nextAttemptAt: null,
      failureStreak: 0,
    });
  });
});

describe("StateStore", () => {
  it("reads a missing file as null", async () => {
    expect(await store.read()).toBeNull();
  });

  it("reads corrupt JSON as null", async () => {
    mkdirSync(join(dir, "state"), { recursive: true });
    writeFileSync(file, "{not json");
    expect(await store.read()).toBeNull();
  });

  it("reads a shape-invalid file as null", async () => {
    mkdirSync(join(dir, "state"), { recursive: true });
    writeFileSync(file, JSON.stringify({ bootstrap: "maybe", failureStreak: "nope" }));
    expect(await store.read()).toBeNull();
  });

  it("round-trips state written through the store", async () => {
    const value = state();
    await store.write(value);
    expect(await store.read()).toEqual(value);
  });

  it("ignores unknown extra keys when reading", async () => {
    mkdirSync(join(dir, "state"), { recursive: true });
    writeFileSync(file, JSON.stringify({ ...state(), surprise: true }));
    expect(await store.read()).toEqual(state());
  });
});
