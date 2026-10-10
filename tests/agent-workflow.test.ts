import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getCurrentTools, type FauxProviderHandle, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VexConfig } from "../src/config/schema.js";
import { startDaemon, type Daemon } from "../src/daemon.js";
import { createLogger } from "../src/logger.js";
import { resolvePaths, type VexPaths } from "../src/paths.js";
import { createModelRegistry } from "../src/providers/models.js";
import { readOriginalSource } from "../src/links/source.js";
import type { PageRequest } from "../src/tools/web.js";
import { runGit } from "../src/vault/git.js";
import { TestClient } from "./helpers/client.js";
import { createFaux, fauxModels } from "./helpers/faux.js";
import { commit, makeRemote } from "./helpers/gitRemote.js";
import { makeTmpDir, removeTmpDir } from "./helpers/tmp.js";

let dir: string;
let paths: VexPaths;
let faux: FauxProviderHandle;
let daemon: Daemon | undefined;
let client: TestClient | undefined;

beforeEach(async () => {
  dir = await makeTmpDir();
  paths = resolvePaths(dir);
  faux = createFaux();
});
afterEach(async () => {
  client?.close();
  client = undefined;
  await daemon?.stop();
  daemon = undefined;
  await removeTmpDir(dir);
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } }).trim();
}

describe("assembled shared-link workflow", () => {
  it("archives multiple shared links through the WebChat Session while the main model omits wiki_ingest", async () => {
    const { remote, work } = makeRemote(join(dir, "seed"));
    commit(work, { "wiki/Existing.md": "# Existing\n" }, "2026-10-01T10:00:00+0000");
    const initialHead = git(work, ["rev-parse", "HEAD"]);
    const identity = createHash("sha256").update(`${remote}\n`).digest("hex").slice(0, 12);
    await mkdir(join(paths.home, "state"), { recursive: true });
    await writeFile(join(paths.home, "state", "wiki.json"), JSON.stringify({
      lastScanCommit: initialHead, lastRunAt: null, lastBatchId: null, bootstrap: "done", rollback: null,
      nextAttemptAt: null, failureStreak: 0,
    }));

    const xhsUrl = "https://www.xiaohongshu.com/explore/64a1b2c3d4e5f60718293a4b";
    const articleUrl = "https://mp.weixin.qq.com/s?__biz=TEST&mid=123&idx=1&sn=TOKEN";
    const bodies = new Map([[xhsUrl, "Xiaohongshu original body from share text."], [articleUrl, "WeChat original article body."]]);
    const xhsId = "64a1b2c3d4e5f60718293a4b";
    const pageRequest: PageRequest = async (url) => {
      if (url.hostname === "www.xiaohongshu.com") {
        const state = { note: { noteDetailMap: { [xhsId]: { note: { title: "Xiaohongshu note", desc: bodies.get(xhsUrl), type: "normal" } } } } };
        return { status: 200, headers: { "content-type": "text/html" }, body: `<script>window.__INITIAL_STATE__=${JSON.stringify(state)}</script>` };
      }
      return { status: 200, headers: { "content-type": "text/html" }, body: `<html><head><meta property="og:title" content="WeChat article"></head><body><div id="js_content"><p>${bodies.get(articleUrl)}</p></div></body></html>` };
    };
    const sourceReads: string[] = [];
    let mainSawReceipts = false;
    let mainCalledIngest = false;
    let writeIndex = 0;
    const response: FauxResponseFactory = (context) => {
      const tools = getCurrentTools(context.messages).map((tool) => tool.name);
      const current = context.messages.filter((message) => message.role === "user").at(-1);
      const prompt = current?.role === "user" ? String(current.content) : "";
      if (tools.includes("wiki_write") && !tools.includes("wiki_ingest")) {
        const source = [...bodies.values()].find((body) => prompt.includes(body));
        if (!source) return fauxAssistantMessage("Compilation completed.");
        const url = [...bodies.entries()].find(([, body]) => body === source)![0];
        const rawPath = `raw/link-${createHash("sha256").update(url).digest("hex")}.md`;
        const page = url === xhsUrl ? "wiki/Xiaohongshu.md" : "wiki/WeChat.md";
        if (!context.messages.some((message) => message.role === "toolResult" && message.toolName === "wiki_write")) {
          return fauxAssistantMessage(fauxToolCall("wiki_write", { path: page, content: `# Shared source\n\n${source}\n\nSource: ${rawPath}\n` }, { id: `write-${writeIndex++}` }), { stopReason: "toolUse" });
        }
        return fauxAssistantMessage(`Compiled ${page}.`);
      }
      if (tools.includes("wiki_ingest")) {
        const receipts = context.messages.filter((message) => message.role === "toolResult" && message.toolName === "wiki_ingest");
        mainSawReceipts = receipts.length === 2;
        const answer = fauxAssistantMessage("Both shared links were read, archived, compiled, and published.");
        mainCalledIngest ||= answer.content.some((part) => part.type === "toolCall" && part.name === "wiki_ingest");
        return answer;
      }
      return fauxAssistantMessage("Conversation title");
    };
    faux.setResponses(Array.from({ length: 20 }, () => response));

    const config: VexConfig = {
      model: { provider: faux.getModel().provider, id: faux.getModel().id },
      backgroundModel: { provider: faux.getModel().provider, id: faux.getModel().id },
      providers: {}, web: { host: "127.0.0.1", port: 0 }, workspace: join(dir, "workspace"),
      toolPolicy: {}, bashEnvPassthrough: [], wechat: { enabled: false, baseUrl: "http://127.0.0.1:1" },
      vault: { url: remote, wiki: { every: "1d", notify: false, maxNotesPerRun: 20 } },
    };
    const localGit = (args: string[], options: Parameters<typeof runGit>[1]) => runGit(args, { ...options, env: { ...options.env, GIT_ALLOW_PROTOCOL: "file:http:https" } });
    daemon = await startDaemon({
      paths, config, log: createLogger(), models: createModelRegistry({}, fauxModels(faux)), wikiGitRunner: localGit,
      decisionJudge: { route: async () => ({ tool: null, confidence: 0 }), unsupported: async () => 0,
        classifyLinks: async (_input, urls) => urls.map((url) => ({ url, intent: "archive" as const, confidence: 0.99 })) },
      wikiSourceResolver: async (url, signal) => { sourceReads.push(url); return readOriginalSource(url, { signal, request: pageRequest }); },
    });

    client = await TestClient.connect(`ws://127.0.0.1:${daemon.port}/ws`);
    client.send({ type: "create_session" });
    const created = await client.waitFor((message) => message.type === "session_created");
    if (created.type !== "session_created") throw new Error("WebChat session creation failed");
    const shareText = `2.36 复制打开小红书，看看这条笔记 ${xhsUrl}\n请也读这篇公众号文章：${articleUrl}`;
    client.send({ type: "send", sessionId: created.session.id, text: shareText });
    await client.waitFor((message) => message.type === "event" && message.event.kind === "busy" && !message.event.busy);
    await client.waitFor((message) => message.type === "event" && message.event.kind === "assistant_message" && message.event.text.includes("Both shared links"));

    const rawXhs = `raw/link-${createHash("sha256").update(xhsUrl).digest("hex")}.md`;
    const rawArticle = `raw/link-${createHash("sha256").update(articleUrl).digest("hex")}.md`;
    const localRoot = join(paths.home, "wiki", identity);
    expect(mainSawReceipts).toBe(true);
    expect(mainCalledIngest).toBe(false);
    expect(sourceReads).toEqual([xhsUrl, articleUrl]);
    expect(git(localRoot, ["rev-parse", "HEAD"])).not.toBe(initialHead);
    expect(git(remote, ["show", `main:${rawXhs}`])).toContain("Xiaohongshu original body from share text.");
    expect(git(remote, ["show", `main:${rawArticle}`])).toContain("WeChat original article body.");
    expect(git(remote, ["show", "main:wiki/Xiaohongshu.md"])).toContain(rawXhs);
    expect(git(remote, ["show", "main:wiki/WeChat.md"])).toContain(rawArticle);
    const transcript = await readFile(join(paths.webSessions, `${created.session.id}.jsonl`), "utf8");
    expect(transcript).toContain(`"requestedUrl":"${xhsUrl}"`);
    expect(transcript).toContain(`"requestedUrl":"${articleUrl}"`);
  });
});
