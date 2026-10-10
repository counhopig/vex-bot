import type { AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent, type Message, type TranscriptContext } from "@earendil-works/pi-ai";
import type { DecisionJudge } from "../policy/judge.js";
import { addUsage, zeroUsage } from "../providers/usage.js";
import { CONTEXT_BUDGET_ERROR, ContextBudgetError } from "./budget.js";

export const TOOL_EVIDENCE_ERROR = "The reply could not be verified against tool results. Please retry the request.";
const MAX_EXCERPT = 1000;
const MAX_EVIDENCE = 12;

function text(message: Message): string {
  return typeof message.content === "string" ? message.content : message.content.map((part) => part.type === "text" ? part.text : "").join("\n");
}

function currentTurn(context: TranscriptContext, secrets: string[] = [], activeRun = false): { request: string; evidence: unknown[]; results: Message[]; hasResults: boolean; urls: string[]; blockedUrls: string[] } {
  const messages = context.messages.slice(-200).filter((message) => message.role !== "system");
  const latestUserIndex = messages.findLastIndex((message) => message.role === "user");
  const scopedMessages = activeRun ? messages : messages.slice(Math.max(0, latestUserIndex));
  const ownerMessages = scopedMessages.filter((message) => message.role === "user");
  const request = String(redact(ownerMessages.map(text).join("\n"), secrets)).slice(-4000);
  const urls = [...new Set((request.match(/https?:\/\/[^\s<>"']+/g) ?? []).map((url) => url.replace(/[),.!?。；，]+$/, "")))];
  const results = scopedMessages.filter((message) => message.role === "toolResult");
  const calls = scopedMessages.flatMap((message) => message.role === "assistant" ? message.content.filter((part) => part.type === "toolCall") : []);
  const activeCallIds = new Set(calls.map((part) => part.id));
  const paired = calls.flatMap((call) => {
    const result = results.find((candidate) => candidate.role === "toolResult" && candidate.toolCallId === call.id && candidate.toolName === call.name);
    return result ? [{ call, result }] : [];
  });
  const blockedUrls = urls.filter((url) => paired.some(({ call, result }) => activeCallIds.has(call.id) && ["bash", "web_fetch", "wiki_ingest"].includes(call.name) && JSON.stringify(call.arguments).includes(url) && result.role === "toolResult" && result.isError));
  const evidence = paired.slice(-MAX_EVIDENCE).flatMap(({ call, result }) => {
    const receipt = result.role === "toolResult" && result.details && typeof result.details === "object" && "receipt" in result.details
      ? receiptSummary(result.details.receipt, secrets) : undefined;
    const own = {
    tool: call.name, id: call.id, arguments: String(redact(JSON.stringify(call.arguments), secrets)).slice(0, MAX_EXCERPT),
    error: result.role === "toolResult" && result.isError,
    result: result.details && typeof result.details === "object" && "receipt" in result.details
      ? undefined : String(redact(text(result), secrets)).slice(0, MAX_EXCERPT),
    receipt,
    };
    const nested = call.name === "delegate" && Array.isArray(receipt?.evidence)
      ? receipt.evidence.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object")).map((entry) => ({ ...entry, id: `delegate:${call.id}:${String(entry.callId ?? entry.id ?? "unknown")}` })) : [];
    return [own, ...nested];
  }).slice(-MAX_EVIDENCE);
  return { request, urls, blockedUrls, results, hasResults: paired.some(({ call }) => call.name !== "request_action_outcome"), evidence };
}

function redact(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") {
    let output = value;
    for (const secret of secrets.filter(Boolean)) output = output.split(secret).join("[redacted]");
    return output.replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/gi, "$1[redacted]")
      .replace(/((?:api[_-]?key|token|cookie|sessdata)\s*[:=]\s*)[^\s,;"']+/gi, "$1[redacted]");
  }
  if (Array.isArray(value)) return value.slice(0, MAX_EVIDENCE).map((item) => redact(item, secrets));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 30).map(([key, item]) => [key, redact(item, secrets)]));
  return value;
}

export function redactForExternalEvaluation<T>(value: T, secrets: string[]): T {
  return redact(value, secrets) as T;
}

export function boundedEvidenceReceipt(value: unknown, secrets: string[] = []): Record<string, unknown> | undefined {
  return receiptSummary(value, secrets);
}

function receiptSummary(value: unknown, secrets: string[]): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const receipt = value as Record<string, unknown>;
  const fields = ["version", "status", "requestedUrl", "canonicalUrl", "title", "textKind", "sourceAvailable", "metadataOnly", "truncated", "rawPath", "batchId", "commit", "publication", "compiledPages", "excerpt", "error"];
  const summary: Record<string, unknown> = Object.fromEntries(fields.flatMap((key) => {
    const item = receipt[key];
    if (item === undefined) return [];
    if (key === "compiledPages" && Array.isArray(item)) return [[key, item.slice(0, 12).map((page) => String(redact(String(page), secrets)).slice(0, 200))]];
    if (typeof item === "string") return [[key, String(redact(item, secrets)).slice(0, MAX_EXCERPT)]];
    return [[key, item]];
  }));
  if (Array.isArray(receipt.evidence)) summary.evidence = receipt.evidence.slice(-MAX_EVIDENCE).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const child = entry as Record<string, unknown>;
    if (typeof child.tool !== "string" || typeof child.callId !== "string" || typeof child.error !== "boolean") return [];
    return [{ tool: child.tool.slice(0, 100), callId: child.callId.slice(0, 200), arguments: typeof child.arguments === "string" ? String(redact(child.arguments, secrets)).slice(0, MAX_EXCERPT) : "{}",
      error: child.error, result: typeof child.result === "string" ? String(redact(child.result, secrets)).slice(0, MAX_EXCERPT) : "",
      receipt: receiptSummary(child.receipt, secrets) }];
  });
  if (typeof receipt.checkedReply === "string") summary.checkedReply = String(redact(receipt.checkedReply, secrets)).slice(0, 4000);
  if (receipt.usage && typeof receipt.usage === "object") summary.usage = redact(receipt.usage, secrets);
  return summary;
}

function instruction(context: TranscriptContext, message: string): TranscriptContext {
  const messages = [...context.messages];
  const first = messages[0];
  if (first?.role === "system") messages[0] = { ...first, content: `${text(first)}\n\n${message}` };
  else messages.unshift({ role: "system", content: message, timestamp: Date.now() });
  return { ...context, messages };
}

function localUnsupported(reply: string, state: ReturnType<typeof currentTurn>): boolean {
  const normalized = reply.split(/(?<=[.!?;])\s+|\bbut\b|\bhowever\b|,\s*/i).map((clause) => {
    if (/^\s*(?:i(?:'ll| will| am going to)|let me|we(?:'ll| will)|going to)\b/i.test(clause)) return "";
    return clause.replace(/\b(?:not|never|haven't|didn't|won't)\s+(?:been\s+)?(?:saved|archived|published|pushed|searched|read|retrieved|downloaded|executed|run|updated|deleted|sent)\b/gi, "");
  }).join(" ");
  const claims: { pattern: RegExp; tools: string[]; check: (receipt: Record<string, unknown> | undefined, success: boolean) => boolean }[] = [
    { pattern: /\b(saved|archived)\b|已(?:保存|归档)/i, tools: ["wiki_ingest"], check: (r) => Boolean(r && r.sourceAvailable === true && typeof r.rawPath === "string" && r.rawPath && !["failed-read", "failed-run", "bootstrap-pending"].includes(String(r.status))) },
    { pattern: /\b(published|pushed)\b|已(?:发布|推送)/i, tools: ["wiki_ingest"], check: (r) => Boolean(r && r.publication === "published") },
    { pattern: /\b(compiled)\b|已编译/i, tools: ["wiki_ingest", "wiki_write", "wiki_edit"], check: (r, success) => success && (r === undefined || Array.isArray(r.compiledPages) && r.compiledPages.length > 0) },
    { pattern: /\b(read|retrieved|downloaded)\b|已(?:读取|读完|获取)/i, tools: ["web_fetch", "wiki_ingest", "read", "vault_read"], check: (r, success) => success && (r?.sourceAvailable === true || r === undefined) },
    { pattern: /\bsearched\b|已搜索/i, tools: ["web_search", "memory_search", "vault_search"], check: (_r, success) => success },
    { pattern: /\b(executed|ran)\b|已(?:执行|运行)/i, tools: ["bash"], check: (_r, success) => success },
    { pattern: /\bupdated\b|已更新/i, tools: ["write", "edit", "schedule", "wiki_write", "wiki_edit"], check: (_r, success) => success },
    { pattern: /\bdeleted\b|已删除/i, tools: ["write", "edit", "bash", "wiki_edit"], check: (_r, success) => success },
    { pattern: /\bsent\b|已发送/i, tools: ["schedule", "wechat_send"], check: (_r, success) => success },
  ];
  return claims.some(({ pattern, tools, check }) => {
    if (!pattern.test(normalized)) return false;
    const describedUrls = [...new Set((normalized.match(/https?:\/\/[^\s<>"']+/g) ?? []).map((url) => url.replace(/[),.!?。；，]+$/, "")))].filter((url) => state.urls.includes(url));
    const targetUrls = describedUrls.length ? describedUrls : state.urls;
    const candidateMatches = (item: unknown, url?: string): item is { tool: string; arguments?: string; error?: unknown; receipt?: Record<string, unknown> } => {
      if (!item || typeof item !== "object") return false;
      const entry = item as { tool?: string; arguments?: string; error?: unknown; receipt?: Record<string, unknown> };
      if (!tools.includes(entry.tool ?? "")) return false;
      if (!url || !["web_fetch", "wiki_ingest"].includes(entry.tool ?? "")) return true;
      const matchText = `${entry.arguments ?? ""} ${String(entry.receipt?.requestedUrl ?? "")} ${String(entry.receipt?.canonicalUrl ?? "")}`;
      return matchText.includes(url);
    };
    const supportsLatest = (url?: string): boolean => {
      const latest = [...state.evidence].reverse().find((item) => candidateMatches(item, url));
      return Boolean(latest && latest.error === false && check(latest.receipt, true));
    };
    if (targetUrls.length === 0) return !supportsLatest();
    return !targetUrls.every((url) => supportsLatest(url));
  });
}

function assistantOutput(message: AssistantMessage, content: AssistantMessage["content"], usage = message.usage): AssistantMessage {
  return { ...message, content, usage };
}

function fallback(message: AssistantMessage, state: ReturnType<typeof currentTurn>): AssistantMessage {
  const records = state.evidence.flatMap((item) => item && typeof item === "object" ? [item as { tool?: string; error?: unknown; arguments?: string; receipt?: Record<string, unknown> }] : []);
  const newestReceipt = new Map<string, Record<string, unknown>>();
  for (const entry of records) {
    if (!entry.receipt || !["wiki_ingest", "web_fetch"].includes(entry.tool ?? "")) continue;
    let argumentUrl = "";
    try {
      const args = JSON.parse(entry.arguments ?? "{}") as { url?: unknown };
      if (typeof args.url === "string") argumentUrl = args.url;
    } catch { /* bounded evidence may not contain parseable arguments */ }
    const url = typeof entry.receipt.requestedUrl === "string" ? entry.receipt.requestedUrl : argumentUrl;
    newestReceipt.set(`${entry.tool}:${url}`, entry.receipt);
  }
  const currentReceipts = [...newestReceipt.entries()].filter(([key]) => {
    const url = key.slice(key.indexOf(":") + 1);
    return !state.urls.length || !url || state.urls.includes(url);
  }).map(([, receipt]) => receipt);
  const wikiReceipts = currentReceipts.filter((receipt) => typeof receipt.status === "string" || "publication" in receipt);
  const webReceipts = currentReceipts.filter((receipt) => "textKind" in receipt || "excerpt" in receipt);
  const outcomes: string[] = [];
  for (const wiki of wikiReceipts) {
    const url = typeof wiki.requestedUrl === "string" ? ` for ${wiki.requestedUrl}` : "";
    if (wiki.status === "bootstrap-pending") outcomes.push(`Archival is awaiting review${url}.`);
    else if (wiki.status === "failed-read" && wiki.sourceAvailable === true && wiki.truncated === true) outcomes.push(`Reading returned a truncated source${url}; complete archival was refused.`);
    else if (wiki.status === "failed-read") outcomes.push(`Reading failed${url}: ${String(wiki.error ?? "the source could not be retrieved")}.`);
    else if (wiki.status === "failed-run") outcomes.push(`${wiki.sourceAvailable === true ? "Reading succeeded" : "Reading did not complete"}${url}, but Wiki compilation failed: ${String(wiki.error ?? "the transaction did not complete")}.`);
    else {
      const facts: string[] = [];
      if (wiki.sourceAvailable === true && wiki.rawPath) facts.push("source archived");
      else if (wiki.sourceAvailable === true) facts.push("source read");
      if (Array.isArray(wiki.compiledPages) && wiki.compiledPages.length > 0) facts.push("Wiki compiled");
      if (wiki.publication === "published") facts.push("published");
      else if (wiki.publication === "pending") facts.push("publication pending");
      else if (wiki.publication === "preview") facts.push("awaiting review");
      if (facts.length) outcomes.push(`${facts.join(", ")}${url}.`);
    }
  }
  for (const web of webReceipts) {
    const url = typeof web.requestedUrl === "string" ? ` for ${web.requestedUrl}` : "";
    outcomes.push(web.sourceAvailable === true ? `Reading succeeded${url}.` : `Reading did not return source text${url}${web.error ? `: ${web.error}` : ""}.`);
  }
  let body = "I could not verify that the requested operation was performed, so I cannot report it as complete.";
  if (outcomes.length) body = outcomes.join(" ");
  else if (records.some((entry) => entry.error === true)) body = "The requested operation failed; its matching tool result records the failure.";
  return assistantOutput(message, [{ type: "text", text: body }]);
}

export interface EvidenceBoundaryOptions {
  judge?: DecisionJudge;
  tools?: () => AgentTool<any>[];
  confidence?: number;
  warn?: (error: unknown) => void;
  secrets?: () => string[];
  messages?: () => TranscriptContext["messages"];
  takeUsage?: () => AssistantMessage["usage"] | undefined;
  returnUsage?: (usage: AssistantMessage["usage"]) => void;
}

/** Buffers every assistant generation until operation claims have passed the shared evidence check. */
export function withEvidenceBoundary(stream: StreamFn, options: EvidenceBoundaryOptions = {}): StreamFn {
  return async (model, originalContext, callOptions) => {
    let context = originalContext;
    const secretValues = options.secrets?.() ?? [];
    const state = currentTurn({ ...context, messages: options.messages?.() ?? context.messages }, secretValues, options.messages !== undefined);
    let routeRequired = false;
    const confidence = options.confidence ?? 0.8;
    if (options.judge && state.request) {
      try {
        const route = await options.judge.route(redact({ request: state.request, evidence: state.evidence }, secretValues), (options.tools?.() ?? []).map(({ name, description }) => ({ name, description: String(redact(description, secretValues)).slice(0, 500) })).slice(0, 254), callOptions?.signal);
        routeRequired = route.tool !== null && route.confidence >= confidence && !state.hasResults;
        if (state.blockedUrls.length && (route.tool === "bash" || route.tool === "delegate")) {
          context = instruction(context, `A link action was denied for ${JSON.stringify(state.blockedUrls)}. That action is terminal. Report the denial accurately.`);
        } else if (routeRequired) {
          context = instruction(context, `Tool routing: use ${route.tool} next through the normal permission gate. Do not claim an operation without its matching tool result.`);
        }
      } catch (error) {
        callOptions?.signal?.throwIfAborted();
        options.warn?.(error);
      }
    }
    callOptions?.signal?.throwIfAborted();
    let accumulatedUsage = addUsage(zeroUsage(), options.takeUsage?.() ?? zeroUsage());
    let lastProviderMessage: AssistantMessage | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (callOptions?.signal?.aborted) {
        options.returnUsage?.(accumulatedUsage);
        callOptions.signal.throwIfAborted();
      }
      let upstream;
      try {
        upstream = await stream(model, context, callOptions);
      } catch (error) {
        if (!lastProviderMessage) {
          options.returnUsage?.(accumulatedUsage);
          throw error;
        }
        if (callOptions?.signal?.aborted) {
          options.returnUsage?.(accumulatedUsage);
          throw error;
        }
        if (!(error instanceof ContextBudgetError)) {
          options.returnUsage?.(accumulatedUsage);
          throw error;
        }
        const safe = assistantOutput({ ...lastProviderMessage, stopReason: "error", errorMessage: CONTEXT_BUDGET_ERROR }, [], accumulatedUsage);
        const output = createAssistantMessageEventStream();
        output.push({ type: "error", reason: "error", error: safe });
        output.end(safe);
        return output;
      }
      const events: AssistantMessageEvent[] = [];
      for await (const event of upstream) events.push(event);
      const message = await upstream.result();
      accumulatedUsage = addUsage(accumulatedUsage, message.usage);
      lastProviderMessage = message;
      const output = createAssistantMessageEventStream();
      if (message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "length") {
        const safe = assistantOutput({ ...message, ...(message.stopReason === "error" ? { errorMessage: message.errorMessage === CONTEXT_BUDGET_ERROR ? CONTEXT_BUDGET_ERROR : "Provider generation failed before a checked reply was available." } : message.stopReason === "aborted" ? { errorMessage: "Generation was cancelled before a checked reply was available." } : {}) }, message.stopReason === "length" ? message.content.filter((part) => part.type === "toolCall") : [], accumulatedUsage);
        if (safe.stopReason === "error" || safe.stopReason === "aborted") output.push({ type: "error", reason: safe.stopReason, error: safe });
        else { output.push({ type: "done", reason: safe.stopReason === "length" ? "length" : safe.stopReason === "toolUse" ? "toolUse" : safe.stopReason === "deferred" ? "deferred" : "stop", message: safe }); }
        output.end(safe);
        return output;
      }

      const reply = text(message);
      let unsupported = localUnsupported(reply, state) || (routeRequired && !state.hasResults && !message.content.some((part) => part.type === "toolCall"));
      if (options.judge && reply) {
        try {
          const score = await options.judge.unsupported(redact({ request: state.request, evidence: state.evidence, reply: String(redact(reply, secretValues)).slice(0, 4000) }, secretValues), callOptions?.signal);
          unsupported ||= score >= confidence;
        } catch (error) {
          callOptions?.signal?.throwIfAborted();
          options.warn?.(error);
        }
      }
      const toolCalls = message.content.filter((part) => part.type === "toolCall");
      if (unsupported && toolCalls.length) {
        const safe = assistantOutput(message, toolCalls, accumulatedUsage);
        output.push({ type: "start", partial: safe });
        output.push({ type: "done", reason: safe.stopReason === "toolUse" ? "toolUse" : safe.stopReason === "deferred" ? "deferred" : "stop", message: safe });
        output.end(safe);
        return output;
      }
      if (!unsupported) {
        const safe = assistantOutput(message, message.content, accumulatedUsage);
        for (const event of events) output.push(event);
        output.end(safe);
        return output;
      }
      if (attempt === 0) {
        context = instruction(context, "Your previous operation claims were withheld because they lacked matching tool results. Give an honest answer from the recorded receipts, or use an available tool through its normal gate. Do not repeat the rejected claim or repeat a completed side effect.");
        continue;
      }
      const safe = fallback(assistantOutput(message, message.content, accumulatedUsage), state);
      output.push({ type: "start", partial: safe });
      safe.content.forEach((part, index) => { if (part.type === "text") { output.push({ type: "text_start", contentIndex: index, partial: safe }); output.push({ type: "text_delta", contentIndex: index, delta: part.text, partial: safe }); output.push({ type: "text_end", contentIndex: index, content: part.text, partial: safe }); } });
      output.push({ type: "done", reason: "stop", message: safe });
      output.end(safe);
      return output;
    }
    throw new Error("Evidence check did not complete.");
  };
}
