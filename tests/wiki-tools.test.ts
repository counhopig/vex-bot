import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WikiRepo } from "../src/wiki/git.js";
import { MarkerStore, type FileFingerprint, type InFlightMarker } from "../src/wiki/marker.js";
import type { Wiki } from "../src/wiki/service.js";
import { createWikiInteractiveTools, createWikiWriteTools } from "../src/wiki/tools.js";
import { commit, makeRemote } from "./helpers/gitRemote.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

let dir: string;
beforeEach(async () => {
  dir = await makeTmpDir();
});
afterEach(async () => {
  await removeTmpDir(dir);
});

function fileHash(text: string): FileFingerprint {
  return { type: "file", hash: createHash("sha256").update(text).digest("hex") };
}

function writingMarker(baseHead: string): InFlightMarker {
  return { batchId: "b1", kind: "on-demand", advancesScan: false, scanBase: null, baseHead, phase: "writing", commit: null, touched: [] };
}

function toolNamed(tools: AgentTool<any>[], name: string): AgentTool<any> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

interface Setup {
  repo: WikiRepo;
  root: string;
  marker: MarkerStore;
  tools: AgentTool<any>[];
}

async function setup(files: Record<string, string>): Promise<Setup> {
  const { remote, work } = makeRemote(join(dir, "seed"));
  commit(work, files, "2026-10-01T10:00:00+0000");
  const repo = new WikiRepo({ home: join(dir, "home"), url: remote, protocols: "file" });
  const root = await repo.open();
  const marker = new MarkerStore(join(root, ".git"));
  await marker.begin(writingMarker(await repo.head()));
  const roots = { wiki: join(root, "wiki"), raw: join(root, "raw") };
  mkdirSync(roots.wiki, { recursive: true });
  mkdirSync(roots.raw, { recursive: true });
  return { repo, root, marker, tools: createWikiWriteTools({ repo, marker, roots }) };
}

describe("wiki_write", () => {
  it("rejects a path outside wiki/ and raw/ before writing", async () => {
    const { root, tools } = await setup({ "wiki/a.md": "a" });
    await expect(toolNamed(tools, "wiki_write").execute("1", { path: "notes/x.md", content: "hi" })).rejects.toThrow(/must start with wiki\/ or raw\//);
    expect(existsSync(join(root, "notes"))).toBe(false);
  });

  it("does not write when persisting the intent fails", async () => {
    const { root, repo } = await setup({ "wiki/a.md": "a" });
    const marker = {
      read: async () => writingMarker(await repo.head()),
      recordIntent: async () => {
        throw new Error("marker full");
      },
      recordAfter: async () => undefined,
    } as unknown as MarkerStore;
    const tools = createWikiWriteTools({ repo, marker, roots: { wiki: join(root, "wiki"), raw: join(root, "raw") } });
    await expect(toolNamed(tools, "wiki_write").execute("1", { path: "wiki/new.md", content: "hi" })).rejects.toThrow("marker full");
    expect(existsSync(join(root, "wiki", "new.md"))).toBe(false);
  });

  it("aborts when the target changed since the last write", async () => {
    const { root, tools } = await setup({ "raw/seed.md": "seed" });
    const write = toolNamed(tools, "wiki_write");
    await write.execute("1", { path: "wiki/new.md", content: "A" });
    writeFileSync(join(root, "wiki", "new.md"), "B");
    await expect(write.execute("1", { path: "wiki/new.md", content: "C" })).rejects.toThrow(/changed since/);
    expect(readFileSync(join(root, "wiki", "new.md"), "utf8")).toBe("B");
  });

  it("records fingerprints for a new file", async () => {
    const { marker, tools } = await setup({ "raw/seed.md": "seed" });
    await toolNamed(tools, "wiki_write").execute("1", { path: "wiki/new.md", content: "hello" });
    const touched = (await marker.read())?.touched.find((entry) => entry.path === "wiki/new.md");
    expect(touched?.expectedBefore).toEqual({ type: "absent", hash: null });
    expect(touched?.after).toEqual(fileHash("hello"));
  });
});

describe("wiki_edit", () => {
  it("replaces only the matched text", async () => {
    const { root, tools } = await setup({ "wiki/a.md": "alpha beta gamma" });
    await toolNamed(tools, "wiki_edit").execute("1", { path: "wiki/a.md", oldText: "beta", newText: "BETA" });
    expect(readFileSync(join(root, "wiki", "a.md"), "utf8")).toBe("alpha BETA gamma");
  });
});

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content[0]?.text ?? "";
}

interface FakeWiki {
  wiki: Wiki;
  status: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
  approveBootstrap: ReturnType<typeof vi.fn>;
  rejectBootstrap: ReturnType<typeof vi.fn>;
  rollback: ReturnType<typeof vi.fn>;
}

function fakeWiki(bootstrap: "pending" | "awaiting-review" | "done", overrides: Partial<FakeWiki> = {}): FakeWiki {
  const fake = {
    status: vi.fn(async () => ({ bootstrap, nextAttemptAt: null, lastBatchId: null })),
    run: vi.fn(async () => null),
    approveBootstrap: vi.fn(async () => ({ pushed: true, message: "bootstrap preview published" })),
    rejectBootstrap: vi.fn(async () => ({ discarded: true, message: "bootstrap preview discarded" })),
    rollback: vi.fn(async () => ({ reverted: true, commit: "abc", message: "reverted the last batch" })),
    ...overrides,
  } as FakeWiki;
  fake.wiki = fake as unknown as Wiki;
  return fake;
}

describe("wiki_ingest", () => {
  it("rejects empty text", async () => {
    const fake = fakeWiki("done");
    const ingest = toolNamed(createWikiInteractiveTools(fake.wiki), "wiki_ingest");
    await expect(ingest.execute("1", { text: "" })).rejects.toThrow(/empty/);
    expect(fake.run).not.toHaveBeenCalled();
  });

  it.each(["pending", "awaiting-review"] as const)("refuses while bootstrap is %s", async (bootstrap) => {
    const fake = fakeWiki(bootstrap);
    const ingest = toolNamed(createWikiInteractiveTools(fake.wiki), "wiki_ingest");
    await expect(ingest.execute("1", { text: "hello" })).rejects.toThrow("the wiki bootstrap is awaiting approval");
    expect(fake.run).not.toHaveBeenCalled();
  });

  it("delegates to run on-demand once the bootstrap is done", async () => {
    const fake = fakeWiki("done");
    const ingest = toolNamed(createWikiInteractiveTools(fake.wiki), "wiki_ingest");
    const result = await ingest.execute("1", { url: "https://example.com", title: "T", text: "hello" });
    expect(fake.run).toHaveBeenCalledWith({ kind: "on-demand", source: { url: "https://example.com", title: "T", text: "hello" } }, expect.any(AbortSignal));
    expect(textOf(result)).toContain("no changes");
  });
});

describe("wiki_bootstrap", () => {
  it("delegates approve to approveBootstrap", async () => {
    const fake = fakeWiki("awaiting-review");
    const bootstrap = toolNamed(createWikiInteractiveTools(fake.wiki), "wiki_bootstrap");
    const result = await bootstrap.execute("1", { action: "approve" });
    expect(fake.approveBootstrap).toHaveBeenCalledTimes(1);
    expect(textOf(result)).toBe("bootstrap preview published");
  });

  it("delegates reject to rejectBootstrap", async () => {
    const fake = fakeWiki("awaiting-review");
    const bootstrap = toolNamed(createWikiInteractiveTools(fake.wiki), "wiki_bootstrap");
    const result = await bootstrap.execute("1", { action: "reject" });
    expect(fake.rejectBootstrap).toHaveBeenCalledTimes(1);
    expect(textOf(result)).toBe("bootstrap preview discarded");
  });

  it("surfaces the service's nothing-to-approve message on a second approve", async () => {
    const fake = fakeWiki("awaiting-review");
    fake.approveBootstrap
      .mockResolvedValueOnce({ pushed: true, message: "bootstrap preview published" })
      .mockResolvedValueOnce({ pushed: false, message: "there is nothing to approve" });
    const bootstrap = toolNamed(createWikiInteractiveTools(fake.wiki), "wiki_bootstrap");
    await bootstrap.execute("1", { action: "approve" });
    const second = await bootstrap.execute("2", { action: "approve" });
    expect(textOf(second)).toBe("there is nothing to approve");
  });
});

describe("wiki_rollback", () => {
  it("refuses while the bootstrap is not done", async () => {
    const fake = fakeWiki("pending");
    const rollback = toolNamed(createWikiInteractiveTools(fake.wiki), "wiki_rollback");
    await expect(rollback.execute("1", {})).rejects.toThrow("the wiki bootstrap is awaiting approval");
    expect(fake.rollback).not.toHaveBeenCalled();
  });

  it("delegates once the bootstrap is done", async () => {
    const fake = fakeWiki("done");
    const rollback = toolNamed(createWikiInteractiveTools(fake.wiki), "wiki_rollback");
    const result = await rollback.execute("1", {});
    expect(fake.rollback).toHaveBeenCalledTimes(1);
    expect(textOf(result)).toBe("reverted the last batch");
  });
});
