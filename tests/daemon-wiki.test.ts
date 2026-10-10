import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt, getCurrentTools, type FauxProviderHandle, type FauxResponseFactory, type ToolResultMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VexConfig } from "../src/config/schema.js";
import { startDaemon, type Daemon } from "../src/daemon.js";
import { createLogger } from "../src/logger.js";
import { resolvePaths, type VexPaths } from "../src/paths.js";
import { createModelRegistry } from "../src/providers/models.js";
import { runGit } from "../src/vault/git.js";
import { readOriginalSource } from "../src/links/source.js";
import type { PageRequest } from "../src/tools/web.js";
import type { DecisionJudge } from "../src/policy/judge.js";
import { fingerprint } from "../src/wiki/marker.js";
import { Wiki } from "../src/wiki/service.js";
import { createFaux, fauxModels, lastUserText } from "./helpers/faux.js";
import { FakeIlink, textMessage } from "./helpers/ilink.js";
import { commit, makeRemote } from "./helpers/gitRemote.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

let dir: string;
let paths: VexPaths;
let faux: FauxProviderHandle;
let ilink: FakeIlink;
let daemon: Daemon | undefined;

beforeEach(async () => {
  dir = await makeTmpDir();
  paths = resolvePaths(dir);
  faux = createFaux();
  ilink = new FakeIlink();
  await ilink.start();
});
afterEach(async () => {
  await daemon?.stop();
  await ilink.stop();
  await removeTmpDir(dir);
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } }).trim();
}

async function startScenario(responses: Parameters<FauxProviderHandle["setResponses"]>[0], scenarioOptions: { seed?: string; failPush?: boolean; scheduled?: boolean; ownerMessage?: string; deferOwnerMessage?: boolean; bootstrap?: "done" | "awaiting-review"; toolPolicy?: VexConfig["toolPolicy"]; mcpServers?: VexConfig["mcpServers"]; webPageRequest?: PageRequest; decisionJudge?: DecisionJudge; wikiSourceResolver?: (url: string, signal: AbortSignal) => ReturnType<typeof readOriginalSource> } = {}): Promise<{ remote: string; head: string; identity: string }> {
  const { remote, work } = makeRemote(join(dir, scenarioOptions.seed ?? "seed"));
  commit(work, { "wiki/Existing.md": "# Existing\n" }, "2026-10-01T10:00:00+0000");
  const head = git(work, ["rev-parse", "HEAD"]);
  if (scenarioOptions.scheduled) commit(work, { "notes/Pending.md": "# Pending\n" }, "2026-10-02T10:00:00+0000");
  const identity = createHash("sha256").update(`${remote}\n`).digest("hex").slice(0, 12);
  await mkdir(join(paths.home, "state"), { recursive: true });
  await writeFile(join(paths.home, "state", "wiki.json"), JSON.stringify({
    lastScanCommit: head, lastRunAt: null, lastBatchId: null, bootstrap: scenarioOptions.bootstrap ?? "done", rollback: null,
    nextAttemptAt: null, failureStreak: 0,
  }));
  await mkdir(paths.wechat, { recursive: true });
  await writeFile(join(paths.wechat, "credentials.json"), JSON.stringify({ token: "tok", accountId: "bot1", baseUrl: ilink.baseUrl, userId: "owner1" }));
  faux.setResponses(responses);
  const config: VexConfig = {
    model: { provider: faux.getModel().provider, id: faux.getModel().id },
    backgroundModel: { provider: faux.getModel().provider, id: faux.getModel().id },
    providers: {}, web: { host: "127.0.0.1", port: 0 }, workspace: join(dir, "workspace"),
    toolPolicy: scenarioOptions.toolPolicy ?? {}, bashEnvPassthrough: [], wechat: { enabled: true, baseUrl: ilink.baseUrl, ownerId: "owner1" },
    ...(scenarioOptions.mcpServers ? { mcpServers: scenarioOptions.mcpServers } : {}),
    vault: { path: join(dir, "vault"), url: remote },
    wiki: { enabled: true, every: scenarioOptions.scheduled ? "5s" : "1d", notify: true, maxNotesPerRun: 20 },
  };
  const localGit = (args: string[], options: Parameters<typeof runGit>[1]) => {
    if (scenarioOptions.failPush && args[0] === "push") return Promise.reject(new Error("simulated local push failure"));
    return runGit(args, { ...options, env: { ...options.env, GIT_ALLOW_PROTOCOL: "file:http:https" } });
  };
  if (!scenarioOptions.deferOwnerMessage) ilink.queueUpdates(textMessage("owner1", scenarioOptions.ownerMessage ?? "Please ingest this article", { message_id: "m1" }));
  const articleHtml: PageRequest = async () => ({ status: 200, headers: { "content-type": "text/html" }, body: '<html><head><meta property="og:title" content="Article"></head><body><div id="js_content"><p>An original article body.</p></div></body></html>' });
  daemon = await startDaemon({ paths, config, log: createLogger(), models: createModelRegistry({}, fauxModels(faux)), wikiGitRunner: localGit,
    ...(scenarioOptions.decisionJudge ? { decisionJudge: scenarioOptions.decisionJudge } : {}),
    ...(scenarioOptions.webPageRequest ? { webPageRequest: scenarioOptions.webPageRequest } : {}),
    wikiSourceResolver: scenarioOptions.wikiSourceResolver ?? ((url, signal) => readOriginalSource(url, { signal, request: articleHtml })) });
  return { remote, head, identity };
}

describe("daemon Wiki notifications", () => {
  it("restores a real pending bootstrap preview and keeps its original owner approval", async () => {
    const { remote, work } = makeRemote(join(dir, "preview-seed"));
    commit(work, { "wiki/Existing.md": "# Existing\n", "notes/Pending.md": "# Pending\n" }, "2026-10-01T10:00:00+0000");
    const localGit = (args: string[], options: Parameters<typeof runGit>[1]) => runGit(args, { ...options, env: { ...options.env, GIT_ALLOW_PROTOCOL: "file:http:https" } });
    const previewWriter = new Wiki({
      home: paths.home, vault: { url: remote }, maxNotesPerRun: 20, notifyEnabled: false,
      notify: async () => {}, run: localGit,
      runAgent: async (_prompt, context) => {
        const abs = join(context.repo.root, "wiki/Recovered.md");
        await context.marker.recordIntent("wiki/Recovered.md", await fingerprint(abs));
        await writeFile(abs, "# Recovered\n");
        await context.marker.recordAfter("wiki/Recovered.md", await fingerprint(abs));
        return "compiled";
      },
    });
    await previewWriter.init();
    const generated = await previewWriter.run({ kind: "bootstrap" }, new AbortController().signal);
    expect(generated.publication).toBe("preview");
    const unpublishedHead = git(remote, ["rev-parse", "main"]);
    await previewWriter.close();

    await mkdir(paths.wechat, { recursive: true });
    await writeFile(join(paths.wechat, "credentials.json"), JSON.stringify({ token: "tok", accountId: "bot1", baseUrl: ilink.baseUrl, userId: "owner1" }));
    await writeFile(join(paths.wechat, "state.json"), JSON.stringify({ contextToken: "ctx-owner1" }));
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("wiki_bootstrap", { action: "approve" }, { id: "model-approve" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("The preview remains pending until you approve it."),
    ]);
    const config: VexConfig = {
      model: { provider: faux.getModel().provider, id: faux.getModel().id },
      backgroundModel: { provider: faux.getModel().provider, id: faux.getModel().id },
      providers: {}, web: { host: "127.0.0.1", port: 0 }, workspace: join(dir, "workspace"),
      toolPolicy: {}, bashEnvPassthrough: [], wechat: { enabled: true, baseUrl: ilink.baseUrl, ownerId: "owner1" },
      vault: { path: join(dir, "vault"), url: remote },
      wiki: { enabled: true, every: "1d", notify: true, maxNotesPerRun: 20 },
    };
    daemon = await startDaemon({ paths, config, log: createLogger(), models: createModelRegistry({}, fauxModels(faux)), wikiGitRunner: localGit });
    await vi.waitFor(() => expect(ilink.sentTexts()).toEqual(expect.arrayContaining([expect.stringContaining("Wiki bootstrap")])), { timeout: 5000 });
    ilink.queueUpdates(textMessage("owner1", "Approve the Wiki preview.", { message_id: "review-attempt" }));
    await vi.waitFor(() => expect(ilink.sentTexts()).toContain("The preview remains pending until you approve it."), { timeout: 5000 });
    expect(git(remote, ["rev-parse", "main"])).toBe(unpublishedHead);
    expect(ilink.sentTexts().filter((text) => text.includes("[Approval needed]") && text.includes("Wiki bootstrap"))).toHaveLength(1);

    ilink.queueUpdates(textMessage("owner1", "/y", { message_id: "review-yes" }));
    await vi.waitFor(() => expect(git(remote, ["rev-parse", "main"])).not.toBe(unpublishedHead), { timeout: 5000 });
    await vi.waitFor(() => expect(ilink.sentTexts()).toEqual(expect.arrayContaining([expect.stringContaining("preview approved and pushed")])), { timeout: 5000 });
    expect(git(remote, ["show", "main:wiki/Recovered.md"])).toContain("# Recovered");
  });

  it("archives WeChat share URLs without a main-model wiki_ingest call", async () => {
    const sourceUrl = "https://mp.weixin.qq.com/s?__biz=TEST&mid=123&idx=1&sn=TOKEN";
    const rawPath = `raw/link-${createHash("sha256").update(sourceUrl).digest("hex")}.md`;
    const mcpStarts = join(dir, "mcp-starts.txt");
    const mcpServer = `import { appendFileSync } from 'node:fs'; import { Server } from '@modelcontextprotocol/sdk/server/index.js'; import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'; import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'; appendFileSync(${JSON.stringify(mcpStarts)}, 'start\\n'); const server = new Server({ name: 'refresh-test', version: '1' }, { capabilities: { tools: {} } }); server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'probe', inputSchema: { type: 'object', properties: {} } }] })); await server.connect(new StdioServerTransport()); setTimeout(() => process.exit(0), 100);`;
    let sawReceipt = false;
    let mainCalledIngest = false;
    let compilerToolsAfterRefresh: string[] = [];
    const response: FauxResponseFactory = async (context) => {
      const tools = getCurrentTools(context.messages).map((tool) => tool.name);
      if (tools.includes("wiki_write") && !tools.includes("wiki_ingest")) {
        if (context.messages.some((message) => message.role === "toolResult" && message.toolName === "wiki_write")) {
          compilerToolsAfterRefresh = tools;
          return fauxAssistantMessage("The Wiki page was compiled.");
        }
        await new Promise((resolve) => setTimeout(resolve, 1_400));
        return fauxAssistantMessage(fauxToolCall("wiki_write", { path: "wiki/WeChat.md", content: `# WeChat\n\nAn original article body.\n\nSource: ${rawPath}\n` }, { id: "write" }), { stopReason: "toolUse" });
      }
      if (tools.includes("wiki_ingest")) {
        const receipt = context.messages.find((message) => message.role === "toolResult" && message.toolName === "wiki_ingest") as ToolResultMessage | undefined;
        const text = receipt?.content.map((part) => part.type === "text" ? part.text : "").join("") ?? "";
        sawReceipt = JSON.parse(text).requestedUrl === sourceUrl;
        const reply = fauxAssistantMessage("The article was read, archived, compiled, and published.");
        mainCalledIngest ||= reply.content.some((part) => part.type === "toolCall" && part.name === "wiki_ingest");
        return reply;
      }
      return fauxAssistantMessage("Conversation title");
    };
    const { remote } = await startScenario(Array.from({ length: 12 }, () => response), {
      ownerMessage: `Please read this article: ${sourceUrl}`,
      mcpServers: { local: { command: process.execPath, args: ["--input-type=module", "-e", mcpServer], cwd: process.cwd() } },
      decisionJudge: { route: async () => ({ tool: null, confidence: 0 }), unsupported: async () => 0,
        classifyLinks: async (_input, urls) => urls.map((url) => ({ url, intent: "archive", confidence: 0.99 })) },
    });
    await vi.waitFor(() => expect(ilink.sentTexts()).toContain("The article was read, archived, compiled, and published."), { timeout: 8000 });
    expect(sawReceipt).toBe(true);
    expect(mainCalledIngest).toBe(false);
    expect((await readFile(mcpStarts, "utf8")).trim().split("\n").length).toBeGreaterThanOrEqual(2);
    expect(compilerToolsAfterRefresh).not.toContain("mcp__local__probe");
    expect(git(remote, ["show", `main:${rawPath}`])).toContain("An original article body.");
    expect(git(remote, ["show", "main:wiki/WeChat.md"])).toContain(rawPath);
  });

  it("checks assembled opt-out, metadata, read failure, denial, and bootstrap-review outcomes", async () => {
    const cases = [
      { name: "explicit read-only", intent: "read" as const, url: "https://example.test/read", body: "<html><head><title>Readable</title></head><body><p>Original readable text.</p></body></html>", status: 200 },
      { name: "metadata only", intent: "archive" as const, url: "https://example.test/metadata", body: "<html><head><title>Metadata only</title></head><body></body></html>", status: 200 },
      { name: "unreadable", intent: "archive" as const, url: "https://example.test/unreadable", body: "unavailable", status: 503 },
      { name: "denied", intent: "archive" as const, url: "https://example.test/denied", body: "<html><body><p>Must not be read.</p></body></html>", status: 200, policy: { wiki_ingest: "deny" as const } },
      { name: "awaiting bootstrap review", intent: "archive" as const, url: "https://example.test/review", body: "<html><body><p>Must wait for review.</p></body></html>", status: 200, bootstrap: "awaiting-review" as const },
    ];
    for (const scenario of cases) {
      const requestUrls: string[] = [];
      const receipts: { tool: string; receipt: Record<string, unknown> }[] = [];
      const request: PageRequest = async (url) => {
        requestUrls.push(url.href);
        return { status: scenario.status, headers: { "content-type": "text/html" }, body: scenario.body };
      };
      const judge: DecisionJudge = {
        route: async () => ({ tool: null, confidence: 0 }), unsupported: async () => 0,
        classifyLinks: async (_input, urls) => urls.map((url) => ({ url, intent: scenario.intent, confidence: 0.99 })),
      };
      const response: FauxResponseFactory = (context) => {
        const results = context.messages.filter((message) => message.role === "toolResult");
        for (const result of results) {
          if (result.role !== "toolResult" || !result.details || typeof result.details !== "object" || !("receipt" in result.details)) continue;
          const receipt = result.details.receipt;
          if (receipt && typeof receipt === "object") receipts.push({ tool: result.toolName, receipt: receipt as Record<string, unknown> });
        }
        if (results.length) return fauxAssistantMessage("I checked the operation result and will report its status accurately.");
        return fauxAssistantMessage("I could not complete the requested operation.");
      };
      const { remote, head } = await startScenario(Array.from({ length: 8 }, () => response), {
        seed: `seed-${scenario.name.replaceAll(" ", "-")}`,
        ownerMessage: `${scenario.intent === "read" ? "Read this without saving" : "Please save this link"}: ${scenario.url}`,
        decisionJudge: judge, webPageRequest: request,
        wikiSourceResolver: (url, signal) => readOriginalSource(url, { signal, request }),
        ...(scenario.policy ? { toolPolicy: scenario.policy } : {}),
        ...(scenario.bootstrap ? { bootstrap: scenario.bootstrap } : {}),
      });
      await vi.waitFor(() => expect(ilink.sentTexts().some((text) => text.includes("operation result") || text.includes("complete the requested operation"))).toBe(true), { timeout: 8000 });
      const fileList = git(remote, ["ls-tree", "-r", "--name-only", "main"]).split("\n");
      expect(fileList).not.toContain(`raw/link-${createHash("sha256").update(scenario.url).digest("hex")}.md`);
      expect(git(remote, ["rev-parse", "refs/heads/main"])).toBe(head);
      if (scenario.name === "explicit read-only") expect(receipts).toEqual(expect.arrayContaining([expect.objectContaining({ tool: "web_fetch", receipt: expect.objectContaining({ sourceAvailable: true }) })]));
      if (scenario.name === "metadata only") expect(receipts).toEqual(expect.arrayContaining([expect.objectContaining({ tool: "wiki_ingest", receipt: expect.objectContaining({ metadataOnly: true }) })]));
      if (scenario.name === "unreadable") expect(receipts).toEqual(expect.arrayContaining([expect.objectContaining({ tool: "wiki_ingest", receipt: expect.objectContaining({ status: "failed-read" }) })]));
      if (scenario.name === "awaiting bootstrap review") expect(receipts).toEqual(expect.arrayContaining([expect.objectContaining({ tool: "wiki_ingest", receipt: expect.objectContaining({ status: "bootstrap-pending" }) })]));
      if (scenario.name === "explicit read-only" || scenario.name === "metadata only" || scenario.name === "unreadable") expect(requestUrls).toContain(scenario.url);
      if (scenario.name === "denied" || scenario.name === "awaiting bootstrap review") expect(requestUrls).not.toContain(scenario.url);
      await daemon?.stop(); daemon = undefined;
      await ilink.stop();
      ilink = new FakeIlink();
      await ilink.start();
    }
  });

  it("lets a real WeChat wiki_ingest turn finish before delivering its notification", async () => {
    const rawPath = `raw/link-${createHash("sha256").update("https://example.com/article").digest("hex")}.md`;
    let compilerPrompt = "";
    let compilerTools: string[] = [];
    const { remote, head, identity } = await startScenario([
      fauxAssistantMessage(fauxToolCall("wiki_ingest", { url: "https://example.com/article" }, { id: "ingest" }), { stopReason: "toolUse" }),
      (context) => {
        compilerPrompt = getCurrentSystemPrompt(context.messages);
        compilerTools = getCurrentTools(context.messages).map((tool) => tool.name);
        return fauxAssistantMessage(fauxToolCall("wiki_write", { path: "wiki/Article.md", content: `# Article\n\nAn original article body.\n\nSource: ${rawPath}\n` }, { id: "write" }), { stopReason: "toolUse" });
      },
      fauxAssistantMessage("Compiled the Wiki page."),
      (context) => {
        const toolResult = context.messages.find((message) => message.role === "toolResult" && message.toolName === "wiki_ingest") as ToolResultMessage | undefined;
        const receiptText = toolResult?.content.map((part) => part.type === "text" ? part.text : "").join("") ?? "";
        expect(JSON.parse(receiptText)).toMatchObject({ version: 1, requestedUrl: "https://example.com/article", canonicalUrl: "https://example.com/article", sourceAvailable: true, rawPath });
        return fauxAssistantMessage("The article was archived and compiled.");
      },
    ]);
    await vi.waitFor(() => expect(ilink.sentTexts()).toEqual(expect.arrayContaining([
      "The article was archived and compiled.",
      expect.stringContaining("Compiled Wiki pages: wiki/Article.md."),
    ])), { timeout: 8000 });
    await vi.waitFor(() => expect(faux.getPendingResponseCount()).toBe(0));
    expect(compilerTools).toEqual(["vault_search", "vault_read", "wiki_write", "wiki_edit"]);
    expect(compilerPrompt).toContain("# LLM Wiki");
    expect(compilerPrompt).toContain("vault_search, vault_read, wiki_write, wiki_edit");
    expect(compilerPrompt).not.toMatch(/read tool|bash|delegate|web_fetch|\bMCP\b/i);
    expect(git(join(paths.home, "wiki", identity), ["rev-parse", "HEAD"])).not.toBe(head);
    expect(git(remote, ["show", "main:wiki/Article.md"])).toContain("An original article body.");
    expect(git(remote, ["show", `main:${rawPath}`])).toContain("An original article body.");
    expect(await readFile(join(paths.sessions, "wechat.jsonl"), "utf8")).toContain(`"rawPath":"${rawPath}"`);
  });

  it("terminates the owner turn when publication fails after a local Wiki commit", async () => {
    const { remote, head, identity } = await startScenario([
      fauxAssistantMessage(fauxToolCall("wiki_ingest", { title: "Article", text: "An original article body." }, { id: "ingest" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("wiki_write", { path: "wiki/Article.md", content: "# Article\n\nAn original article body.\n" }, { id: "write" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Compiled the Wiki page."),
      (context) => {
        const toolResult = context.messages.find((message) => message.role === "toolResult" && message.toolName === "wiki_ingest") as ToolResultMessage | undefined;
        const resultText = toolResult?.content.map((part) => part.type === "text" ? part.text : "").join("") ?? "";
        expect(JSON.parse(resultText)).toMatchObject({ status: "completed", publication: "pending", sourceAvailable: true, batchId: expect.any(String), commit: expect.any(String) });
        return fauxAssistantMessage("Compilation succeeded; publication is pending.");
      },
    ], { failPush: true });
    await vi.waitFor(() => expect(ilink.sentTexts()).toEqual(expect.arrayContaining([
      "Compilation succeeded; publication is pending.", expect.stringContaining("Committed locally; publication is pending."),
    ])), { timeout: 8000 });
    expect(git(join(paths.home, "wiki", identity), ["rev-parse", "HEAD"])).not.toBe(head);
    expect(git(remote, ["rev-parse", "refs/heads/main"])).toBe(head);
  });

  it("rejects a compiler narration after a failed Wiki write and preserves the successful read receipt", async () => {
    const sourceUrl = "https://example.com/article";
    const rawPath = `raw/link-${createHash("sha256").update(sourceUrl).digest("hex")}.md`;
    let failureReceipt: unknown;
    const { remote, head, identity } = await startScenario([
      fauxAssistantMessage(fauxToolCall("wiki_ingest", { url: sourceUrl }, { id: "ingest" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("wiki_write", { path: "outside/Article.md", content: "# Article" }, { id: "failed-write" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("The Wiki page was compiled successfully."),
      fauxAssistantMessage("Compilation failed because the Wiki write returned an error."),
      (context) => {
        const result = context.messages.find((message) => message.role === "toolResult" && message.toolName === "wiki_ingest") as ToolResultMessage | undefined;
        const receiptText = result?.content.map((part) => part.type === "text" ? part.text : "").join("") ?? "";
        failureReceipt = JSON.parse(receiptText);
        return fauxAssistantMessage("The source was read, but Wiki compilation failed.");
      },
    ]);
    await vi.waitFor(() => expect(ilink.sentTexts()).toEqual(expect.arrayContaining([
      "The source was read, but Wiki compilation failed.", expect.stringContaining("wiki: run failed"),
    ])), { timeout: 8000 });
    expect(failureReceipt).toMatchObject({ status: "failed-run", sourceAvailable: true, rawPath: null, compiledPages: [] });
    expect(git(remote, ["rev-parse", "refs/heads/main"])).toBe(head);
    expect(git(join(paths.home, "wiki", identity), ["rev-parse", "HEAD"])).toBe(head);
    await expect(readFile(join(paths.home, "wiki", identity, rawPath), "utf8")).rejects.toThrow();
  });

  it("runs scheduled Wiki work while the owner ingestion notification is queued", async () => {
    faux = createFaux();
    const ownerRequest = "Please ingest this article";
    let scheduledObserved = false;
    let scheduledOverlapped = false;
    let scheduledWriteCompleted = false;
    let ownerToolCallIssued = false;
    let ownerCompilationObserved = false;
    let ownerFinalStarted = false;
    const response: FauxResponseFactory = (context, options) => {
      const prompt = lastUserText(context);
      const hasToolResult = (name: string) => context.messages.some((message) => message.role === "toolResult" && message.toolName === name);
      if (prompt === ownerRequest) {
        if (hasToolResult("wiki_ingest")) {
          ownerFinalStarted = true;
          return new Promise((resolve) => {
            const signal = options?.signal;
            if (signal?.aborted) return resolve(fauxAssistantMessage(""));
            signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("")), { once: true });
          });
        }
        ownerToolCallIssued = true;
        return fauxAssistantMessage(fauxToolCall("wiki_ingest", { title: "Article", text: "An original article body." }, { id: "ingest" }), { stopReason: "toolUse" });
      }
      if (prompt.includes("Apply these vault changes") && prompt.includes("notes/Pending.md")) {
        scheduledObserved = true;
        scheduledOverlapped = ownerFinalStarted;
        if (hasToolResult("wiki_write")) {
          scheduledWriteCompleted = true;
          return fauxAssistantMessage("Scheduled compilation finished.");
        }
        return fauxAssistantMessage(fauxToolCall("wiki_write", { path: "wiki/Pending.md", content: "# Pending\n\nScheduled note.\n" }, { id: "scheduled-write" }), { stopReason: "toolUse" });
      }
      if (prompt.includes("Source text:") && prompt.includes("An original article body.")) {
        if (hasToolResult("wiki_write")) {
          ownerCompilationObserved = true;
          return fauxAssistantMessage("Compiled the Wiki page.");
        }
        return fauxAssistantMessage(fauxToolCall("wiki_write", { path: "wiki/Article.md", content: "# Article\n\nAn original article body.\n" }, { id: "write" }), { stopReason: "toolUse" });
      }
      return fauxAssistantMessage("Scheduled work settled.");
    };
    const { remote } = await startScenario(Array.from({ length: 12 }, () => response), { scheduled: true });
    await vi.waitFor(() => expect(ownerFinalStarted).toBe(true), { timeout: 8000 });
    await vi.waitFor(() => expect(scheduledObserved).toBe(true), { timeout: 8000 });
    expect(scheduledOverlapped).toBe(true);
    await vi.waitFor(() => expect(ownerCompilationObserved).toBe(true), { timeout: 5000 });
    await vi.waitFor(() => expect(scheduledWriteCompleted).toBe(true), { timeout: 5000 });
    await vi.waitFor(() => expect(git(remote, ["ls-tree", "-r", "--name-only", "main"]).split("\n")).toContain("wiki/Pending.md"), { timeout: 5000 });
    expect(git(remote, ["show", "main:wiki/Pending.md"])).toContain("Scheduled note.");
    expect(git(remote, ["show", "main:wiki/Article.md"])).toContain("An original article body.");
    const started = Date.now();
    await daemon!.stop(); daemon = undefined;
    expect(Date.now() - started).toBeLessThan(5000);
    expect(ilink.sentTexts()).not.toEqual(expect.arrayContaining([expect.stringContaining("wiki: ingested")]));
  });

  it("terminates the owner turn after the Wiki compiler provider fails", async () => {
    const { remote, head } = await startScenario([
      fauxAssistantMessage(fauxToolCall("wiki_ingest", { title: "Article", text: "An original article body." }, { id: "ingest" }), { stopReason: "toolUse" }),
      ...Array.from({ length: 4 }, () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "compiler provider failed" })),
      fauxAssistantMessage("The Wiki compilation failed."),
    ]);
    await vi.waitFor(() => expect(ilink.sentTexts()).toEqual(expect.arrayContaining([
      "The Wiki compilation failed.", expect.stringContaining("wiki: run failed"),
    ])), { timeout: 15000 });
    expect(git(remote, ["rev-parse", "refs/heads/main"])).toBe(head);
  });
});
