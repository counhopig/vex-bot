import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryManager } from "../src/memory/index.js";
import { createMemoryTools } from "../src/tools/builtin/memory.js";

vi.mock("../src/utils/logger.js", () => ({
  getChildLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "vex-memory-tools-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("memory tools isolation", () => {
  it("keeps each tool set bound to its own memory manager", async () => {
    const firstManager = createMemoryManager({ directory: tempDir() });
    const secondManager = createMemoryManager({ directory: tempDir() });
    const firstTools = createMemoryTools({ manager: firstManager });
    const secondTools = createMemoryTools({ manager: secondManager });
    const firstStore = firstTools.find((tool) => tool.name === "memory_store");
    const firstList = firstTools.find((tool) => tool.name === "memory_list");
    const secondStore = secondTools.find((tool) => tool.name === "memory_store");
    const secondList = secondTools.find((tool) => tool.name === "memory_list");

    await firstStore?.execute("call-1", { content: "first user's fact", type: "fact" }, undefined);
    await secondStore?.execute("call-2", { content: "second user's fact", type: "fact" }, undefined);

    const firstResult = await firstList?.execute("call-3", { limit: 10 }, undefined);
    const secondResult = await secondList?.execute("call-4", { limit: 10 }, undefined);

    expect(firstResult?.details).toMatchObject({
      count: 1,
      entries: [expect.objectContaining({ content: "first user's fact" })],
    });
    expect(secondResult?.details).toMatchObject({
      count: 1,
      entries: [expect.objectContaining({ content: "second user's fact" })],
    });
  });
});
