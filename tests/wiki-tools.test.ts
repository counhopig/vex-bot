import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WikiRepo } from "../src/wiki/git.js";
import { MarkerStore, type FileFingerprint, type InFlightMarker } from "../src/wiki/marker.js";
import { createWikiWriteTools } from "../src/wiki/tools.js";
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
