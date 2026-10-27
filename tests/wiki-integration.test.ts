import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalManager } from "../src/policy/approvals.js";
import { createToolGate } from "../src/policy/gate.js";
import { ToolPolicy } from "../src/policy/policy.js";
import { Session } from "../src/core/session.js";
import { runGit, type GitRunner } from "../src/vault/git.js";
import { fingerprint } from "../src/vault/wiki/marker.js";
import { Wiki, type WikiOptions, type WikiRunContext } from "../src/vault/wiki/service.js";
import { createWikiInteractiveTools } from "../src/vault/wiki/tools.js";
import { createFaux, fauxStreamFn } from "./helpers/faux.js";
import { commit, git, makeRemote } from "./helpers/gitRemote.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

let dir: string;
beforeEach(async () => {
  dir = await makeTmpDir();
});
afterEach(async () => {
  await removeTmpDir(dir);
});

const key = (url: string, branch?: string): string =>
  createHash("sha256").update(`${url}\n${branch ?? ""}`).digest("hex").slice(0, 12);

/** WikiRepo isolates HOME and sets GIT_ALLOW_PROTOCOL=http:https; allow the file transport for local test remotes. */
const fileRun: GitRunner = (args, options) => runGit(args, { ...options, env: { ...options.env, GIT_ALLOW_PROTOCOL: "file:http:https" } });

function makeWiki(home: string, url: string, overrides: Partial<WikiOptions> = {}): Wiki {
  return new Wiki({
    home,
    vault: { url },
    maxNotesPerRun: 20,
    notifyEnabled: false,
    notify: async () => {},
    runAgent: async () => "ok",
    run: fileRun,
    ...overrides,
  });
}

/** A bare remote seeded with wiki/a.md, plus the local Wiki rooted at it. */
async function seed(home: string, overrides: Partial<WikiOptions> = {}): Promise<{ wiki: Wiki; root: string; remote: string }> {
  const { remote, work } = makeRemote(join(dir, "seed"));
  commit(work, { "wiki/a.md": "v1" }, "2026-10-01T10:00:00+0000");
  const wiki = makeWiki(home, remote, overrides);
  return { wiki, root: join(home, "wiki", key(remote)), remote };
}

/** Counts commits on the bare remote whose body carries a Vex-Batch trailer. */
function remoteBatchCommits(remote: string): number {
  return (git(remote, ["log", "main", "--format=%B"]).match(/Vex-Batch:/g) ?? []).length;
}

/** Writes wiki/n.md inside the run and records the marker's intent/after for it. */
async function compileNewPage(context: WikiRunContext): Promise<string> {
  const abs = join(context.repo.root, "wiki/n.md");
  await context.marker.recordIntent("wiki/n.md", await fingerprint(abs));
  writeFileSync(abs, "compiled");
  await context.marker.recordAfter("wiki/n.md", await fingerprint(abs));
  return "ok";
}

describe("Wiki integration", () => {
  it("recovers a real bootstrap preview and publishes it only after the owner approves wiki_bootstrap", async () => {
    const home = join(dir, "home");
    const { wiki, remote } = await seed(home, {
      runAgent: async (_prompt, context) => {
        const abs = join(context.repo.root, "wiki/a.md");
        await context.marker.recordIntent("wiki/a.md", await fingerprint(abs));
        writeFileSync(abs, "preview content");
        await context.marker.recordAfter("wiki/a.md", await fingerprint(abs));
        return "compiled";
      },
    });
    commit(join(dir, "seed", "work"), { "notes/note.md": "new note" }, "2026-10-02T10:00:00+0000");
    await wiki.init();
    const remoteBefore = git(remote, ["rev-parse", "main"]).trim();
    const generated = await wiki.run({ kind: "bootstrap" }, new AbortController().signal);
    expect(generated.publication).toBe("preview");
    expect(git(remote, ["rev-parse", "main"]).trim()).toBe(remoteBefore);
    const preview = await wiki.preview();
    expect(preview).toMatchObject({ batchId: generated.batchId, commit: generated.commit, pages: ["wiki/a.md"] });
    await wiki.close();

    const recovered = makeWiki(home, remote);
    await recovered.init();
    expect(await recovered.status()).toMatchObject({ bootstrap: "awaiting-review", lastBatchId: generated.batchId });
    expect(await recovered.preview()).toEqual(preview);

    const approvals = new ApprovalManager({ timeoutMs: 10_000 });
    const faux = createFaux();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("wiki_bootstrap", { action: "approve" }, { id: "model-approve" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("The preview was published."),
    ]);
    const policy = new ToolPolicy({ workspace: dir, overrides: {} });
    const gate = createToolGate({ policy, approvals, sessionKey: "web:review", windowLabel: () => "WebChat" });
    const session = await Session.open({
      key: "web:review", transcriptPath: join(dir, "review.jsonl"), model: faux.getModel(),
      tools: createWikiInteractiveTools(recovered), streamFn: fauxStreamFn(faux), getApiKey: () => "test-key",
      buildSystemPrompt: async () => "SYSTEM", emit: () => {}, retry: { attempts: 1, baseDelayMs: 1 },
      beforeToolCall: gate,
    });
    session.send("Approve the preview.");
    await vi.waitFor(() => expect(approvals.pending()).toEqual([expect.objectContaining({ toolName: "wiki_bootstrap", windowLabel: "WebChat" })]));
    expect(git(remote, ["rev-parse", "main"]).trim()).toBe(remoteBefore);

    approvals.answer(approvals.pending()[0]!.id, "allow");
    await session.whenIdle();
    expect(git(remote, ["rev-parse", "main"]).trim()).not.toBe(remoteBefore);
    expect(await recovered.status()).toMatchObject({ bootstrap: "done" });
    await session.dispose();
    approvals.dispose();
    await recovered.close();
  });

  it("keeps the bootstrap preview when the owner denies wiki_bootstrap", async () => {
    const home = join(dir, "home");
    const { wiki, remote } = await seed(home, {
      runAgent: async (_prompt, context) => {
        const abs = join(context.repo.root, "wiki/a.md");
        await context.marker.recordIntent("wiki/a.md", await fingerprint(abs));
        writeFileSync(abs, "preview content");
        await context.marker.recordAfter("wiki/a.md", await fingerprint(abs));
        return "compiled";
      },
    });
    commit(join(dir, "seed", "work"), { "notes/note.md": "new note" }, "2026-10-02T10:00:00+0000");
    await wiki.init();
    const remoteBefore = git(remote, ["rev-parse", "main"]).trim();
    const generated = await wiki.run({ kind: "bootstrap" }, new AbortController().signal);
    expect(generated.publication).toBe("preview");

    const approvals = new ApprovalManager({ timeoutMs: 10_000 });
    const faux = createFaux();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("wiki_bootstrap", { action: "approve" }, { id: "model-approve" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("The owner declined the approval request."),
    ]);
    const policy = new ToolPolicy({ workspace: dir, overrides: {} });
    const gate = createToolGate({ policy, approvals, sessionKey: "web:review", windowLabel: () => "WebChat" });
    const session = await Session.open({
      key: "web:review", transcriptPath: join(dir, "deny-review.jsonl"), model: faux.getModel(),
      tools: createWikiInteractiveTools(wiki), streamFn: fauxStreamFn(faux), getApiKey: () => "test-key",
      buildSystemPrompt: async () => "SYSTEM", emit: () => {}, retry: { attempts: 1, baseDelayMs: 1 },
      beforeToolCall: gate,
    });
    session.send("Approve the preview.");
    await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1));
    approvals.answer(approvals.pending()[0]!.id, "deny");
    await session.whenIdle();
    expect(session.successfulReply).toContain("owner declined");
    expect(git(remote, ["rev-parse", "main"]).trim()).toBe(remoteBefore);
    expect(await wiki.status()).toMatchObject({ bootstrap: "awaiting-review" });

    await session.dispose();
    approvals.dispose();
    await wiki.close();
  });

  it("scheduled run commits once with a Vex-Batch trailer and notifies once", async () => {
    const home = join(dir, "home");
    let notified = 0;
    const { wiki, remote } = await seed(home, {
      notifyEnabled: true,
      notify: async () => { notified += 1; },
      runAgent: async (_prompt, context) => compileNewPage(context),
    });
    commit(join(dir, "seed", "work"), { "notes/n.md": "n1" }, "2026-10-02T10:00:00+0000");
    await wiki.init();
    const before = Number(git(remote, ["rev-list", "--count", "main"]).trim());

    const result = await wiki.run({ kind: "scheduled" }, new AbortController().signal);

    expect(result.publication).toBe("published");
    expect(Number(git(remote, ["rev-list", "--count", "main"]).trim())).toBe(before + 1);
    expect(remoteBatchCommits(remote)).toBe(1);
    expect(notified).toBe(1);
    await wiki.close();
  });

  it("withholds a bootstrap preview until approval publishes it", async () => {
    const home = join(dir, "home");
    const { wiki, remote } = await seed(home, {
      runAgent: async (_prompt, context) => {
        const abs = join(context.repo.root, "wiki/a.md");
        await context.marker.recordIntent("wiki/a.md", await fingerprint(abs));
        writeFileSync(abs, "v2");
        await context.marker.recordAfter("wiki/a.md", await fingerprint(abs));
        return "ok";
      },
    });
    commit(join(dir, "seed", "work"), { "notes/note.md": "n1" }, "2026-10-02T10:00:00+0000");
    await wiki.init();
    const originBefore = git(remote, ["rev-parse", "main"]).trim();

    const preview = await wiki.run({ kind: "bootstrap" }, new AbortController().signal);

    expect(preview.publication).toBe("preview");
    expect(git(remote, ["rev-parse", "main"]).trim()).toBe(originBefore);
    expect(remoteBatchCommits(remote)).toBe(0);
    expect((await wiki.status()).bootstrap).toBe("awaiting-review");

    const approved = await wiki.approveBootstrap(new AbortController().signal);

    expect(approved.pushed).toBe(true);
    expect(git(remote, ["rev-parse", "main"]).trim()).not.toBe(originBefore);
    expect(remoteBatchCommits(remote)).toBe(1);
    expect((await wiki.status()).bootstrap).toBe("done");
    await wiki.close();
  });

  it("state-file loss after a reverted batch does not regenerate the reverted page", async () => {
    const home = join(dir, "home");
    const { wiki, root, remote } = await seed(home, {
      runAgent: async (_prompt, context) => compileNewPage(context),
    });
    commit(join(dir, "seed", "work"), { "notes/n.md": "n1" }, "2026-10-02T10:00:00+0000");
    await wiki.init();
    await wiki.run({ kind: "scheduled" }, new AbortController().signal);
    expect(readFileSync(join(root, "wiki", "n.md"), "utf8")).toBe("compiled");

    const reverted = await wiki.rollback(new AbortController().signal);
    expect(reverted.reverted).toBe(true);
    expect(existsSync(join(root, "wiki", "n.md"))).toBe(false);

    rmSync(join(home, "state", "wiki.json"), { force: true });
    await wiki.status();
    let calls = 0;
    const fresh = makeWiki(home, remote, {
      runAgent: async () => { calls += 1; return "ok"; },
    });
    await fresh.init();
    await fresh.status();

    const result = await fresh.run({ kind: "scheduled" }, new AbortController().signal);

    expect(result).toMatchObject({ publication: "not-needed" });
    expect(calls).toBe(0);
    expect(existsSync(join(root, "wiki", "n.md"))).toBe(false);
    await fresh.close();
    await wiki.close();
  });

  it("state-file loss after a pushed batch recovers the scan cursor from trailers", async () => {
    const home = join(dir, "home");
    const { wiki, root, remote } = await seed(home, {
      runAgent: async (_prompt, context) => compileNewPage(context),
    });
    commit(join(dir, "seed", "work"), { "notes/n.md": "n1" }, "2026-10-02T10:00:00+0000");
    await wiki.init();
    await wiki.run({ kind: "scheduled" }, new AbortController().signal);
    const published = git(remote, ["log", "-1", "--format=%B", "main"]);
    expect(published).toContain("Vex-Scan-Base:");
    expect(published).not.toContain("Vex-Scan-Base: none");

    rmSync(join(home, "state", "wiki.json"), { force: true });
    let calls = 0;
    const fresh = makeWiki(home, remote, {
      runAgent: async () => { calls += 1; return "ok"; },
    });
    await fresh.init();
    await fresh.status();

    const result = await fresh.run({ kind: "scheduled" }, new AbortController().signal);

    expect(result).toMatchObject({ publication: "not-needed" });
    expect(calls).toBe(0);
    expect(readFileSync(join(root, "wiki", "n.md"), "utf8")).toBe("compiled");
    await fresh.close();
    await wiki.close();
  });
});
