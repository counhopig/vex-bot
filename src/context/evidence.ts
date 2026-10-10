import type { AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent, type Message, type TranscriptContext } from "@earendil-works/pi-ai";
import { redactSecrets } from "../config/secrets.js";
import type { TurnAdvisor } from "../policy/advice.js";
import { addUsage, zeroUsage } from "../providers/usage.js";
import { CONTEXT_BUDGET_ERROR, ContextBudgetError } from "./budget.js";
import { describeOutcomes, extractUrls, unsupportedClaim, type EvidenceProfiles, type Receipt } from "./claims.js";

export const TOOL_EVIDENCE_ERROR = "The reply could not be verified against tool results. Please retry the request.";
const MAX_EXCERPT = 1000;
const MAX_EVIDENCE = 12;
const MAX_RECEIPT_FIELDS = 30;

function text(message: Message): string {
  return typeof message.content === "string" ? message.content : message.content.map((part) => part.type === "text" ? part.text : "").join("\n");
}

/** The owner's current request and the bounded, redacted calls and results that answer it. */
function currentTurn(context: TranscriptContext, profiles: EvidenceProfiles, secrets: string[] = [], activeRun = false): { request: string; evidence: unknown[]; hasResults: boolean; urls: string[]; blockedUrls: string[] } {
  const messages = context.messages.slice(-200).filter((message) => message.role !== "system");
  const latestUserIndex = messages.findLastIndex((message) => message.role === "user");
  const scopedMessages = activeRun ? messages : messages.slice(Math.max(0, latestUserIndex));
  const request = redactSecrets(scopedMessages.filter((message) => message.role === "user").map(text).join("\n"), secrets).slice(-4000);
  const urls = extractUrls(request);
  const results = scopedMessages.filter((message) => message.role === "toolResult");
  const calls = scopedMessages.flatMap((message) => message.role === "assistant" ? message.content.filter((part) => part.type === "toolCall") : []);
  const paired = calls.flatMap((call) => {
    const result = results.find((candidate) => candidate.role === "toolResult" && candidate.toolCallId === call.id && candidate.toolName === call.name);
    return result && result.role === "toolResult" ? [{ call, result }] : [];
  });
  const blockedUrls = urls.filter((url) => paired.some(({ call, result }) => profiles[call.name]?.endsLinkOnFailure && JSON.stringify(call.arguments).includes(url) && result.isError));
  const evidence = paired.slice(-MAX_EVIDENCE).flatMap(({ call, result }) => {
    const hasReceipt = Boolean(result.details && typeof result.details === "object" && "receipt" in result.details);
    const receipt = hasReceipt ? receiptSummary((result.details as { receipt: unknown }).receipt, secrets) : undefined;
    const own = {
      tool: call.name, id: call.id, arguments: redactSecrets(JSON.stringify(call.arguments), secrets).slice(0, MAX_EXCERPT),
      error: result.isError,
      result: hasReceipt ? undefined : redactSecrets(text(result), secrets).slice(0, MAX_EXCERPT),
      receipt,
    };
    const nested = profiles[call.name]?.nestedEvidence && Array.isArray(receipt?.evidence)
      ? receipt.evidence.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object")).map((entry) => ({ ...entry, id: `${call.name}:${call.id}:${String(entry.callId ?? entry.id ?? "unknown")}` })) : [];
    return [own, ...nested];
  }).slice(-MAX_EVIDENCE);
  return { request, urls, blockedUrls, hasResults: paired.some(({ call }) => !profiles[call.name]?.bookkeeping), evidence };
}

export function boundedEvidenceReceipt(value: unknown, secrets: string[] = []): Record<string, unknown> | undefined {
  return receiptSummary(value, secrets);
}

/**
 * A bounded, redacted copy of a receipt: scalar fields, short lists of scalars, and the nested
 * calls of a child agent (`evidence`, `checkedReply`, `usage`). Unknown nested objects are dropped.
 */
function receiptSummary(value: unknown, secrets: string[]): Receipt | undefined {
  if (!value || typeof value !== "object") return undefined;
  const receipt = value as Record<string, unknown>;
  const summary: Receipt = Object.fromEntries(Object.entries(receipt).filter(([key]) => !["evidence", "checkedReply", "usage"].includes(key)).slice(0, MAX_RECEIPT_FIELDS).flatMap(([key, item]): [string, unknown][] => {
    if (typeof item === "string") return [[key, redactSecrets(item, secrets).slice(0, MAX_EXCERPT)]];
    if (typeof item === "number" || typeof item === "boolean" || item === null) return [[key, item]];
    if (Array.isArray(item)) return [[key, item.slice(0, MAX_EVIDENCE).map((entry) => redactSecrets(String(entry), secrets).slice(0, 200))]];
    return [];
  }));
  if (Array.isArray(receipt.evidence)) summary.evidence = receipt.evidence.slice(-MAX_EVIDENCE).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const child = entry as Record<string, unknown>;
    if (typeof child.tool !== "string" || typeof child.callId !== "string" || typeof child.error !== "boolean") return [];
    return [{ tool: child.tool.slice(0, 100), callId: child.callId.slice(0, 200), arguments: typeof child.arguments === "string" ? redactSecrets(child.arguments, secrets).slice(0, MAX_EXCERPT) : "{}",
      error: child.error, result: typeof child.result === "string" ? redactSecrets(child.result, secrets).slice(0, MAX_EXCERPT) : "",
      receipt: receiptSummary(child.receipt, secrets) }];
  });
  if (typeof receipt.checkedReply === "string") summary.checkedReply = redactSecrets(receipt.checkedReply, secrets).slice(0, 4000);
  if (receipt.usage && typeof receipt.usage === "object") summary.usage = redactSecrets(receipt.usage, secrets);
  return summary;
}

function instruction(context: TranscriptContext, message: string): TranscriptContext {
  const messages = [...context.messages];
  const first = messages[0];
  if (first?.role === "system") messages[0] = { ...first, content: `${text(first)}\n\n${message}` };
  else messages.unshift({ role: "system", content: message, timestamp: Date.now() });
  return { ...context, messages };
}

function assistantOutput(message: AssistantMessage, content: AssistantMessage["content"], usage = message.usage): AssistantMessage {
  return { ...message, content, usage };
}

/** Replaces an unsupported reply with what the recorded receipts establish. */
function fallback(message: AssistantMessage, state: ReturnType<typeof currentTurn>, profiles: EvidenceProfiles): AssistantMessage {
  const outcomes = describeOutcomes(state, profiles);
  let body = "I could not verify that the requested operation was performed, so I cannot report it as complete.";
  if (outcomes.length) body = outcomes.join(" ");
  else if (state.evidence.some((entry) => Boolean(entry && typeof entry === "object" && (entry as { error?: unknown }).error === true))) body = "The requested operation failed; its matching tool result records the failure.";
  return assistantOutput(message, [{ type: "text", text: body }]);
}

function safeTerminal(message: AssistantMessage, usage: AssistantMessage["usage"]): AssistantMessage {
  if (message.stopReason === "error") return assistantOutput({ ...message, errorMessage: message.errorMessage === CONTEXT_BUDGET_ERROR ? CONTEXT_BUDGET_ERROR : "Provider generation failed before a checked reply was available." }, [], usage);
  if (message.stopReason === "aborted") return assistantOutput({ ...message, errorMessage: "Generation was cancelled before a checked reply was available." }, [], usage);
  return assistantOutput(message, message.content, usage);
}

/** Forwards a reply that needs no evidence check as it is generated, adding the usage spent before it. */
function passThrough(upstream: AsyncIterable<AssistantMessageEvent> & { result(): Promise<AssistantMessage> }, priorUsage: AssistantMessage["usage"]) {
  const output = createAssistantMessageEventStream();
  let partial: AssistantMessage | undefined;
  void (async () => {
    try {
      for await (const event of upstream) {
        if (event.type === "done") output.push({ ...event, message: safeTerminal(event.message, addUsage(priorUsage, event.message.usage)) });
        else if (event.type === "error") output.push({ ...event, error: safeTerminal(event.error, addUsage(priorUsage, event.error.usage)) });
        else {
          if ("partial" in event) partial = event.partial;
          output.push(event);
        }
      }
      const message = await upstream.result();
      output.end(safeTerminal(message, addUsage(priorUsage, message.usage)));
    } catch (error) {
      const base = partial ?? ({ role: "assistant", content: [], api: "unknown", provider: "unknown", model: "unknown", usage: zeroUsage(), timestamp: Date.now() } as unknown as AssistantMessage);
      const failed = safeTerminal({ ...base, stopReason: "error", errorMessage: error instanceof Error ? error.message : String(error) }, priorUsage);
      output.push({ type: "error", reason: "error", error: failed });
      output.end(failed);
    }
  })();
  return output;
}

export interface EvidenceBoundaryOptions {
  /** What each tool's results prove; tools without a profile prove nothing. */
  profiles: EvidenceProfiles;
  advisor?: TurnAdvisor;
  tools?: () => AgentTool<any>[];
  warn?: (error: unknown) => void;
  secrets?: () => string[];
  messages?: () => TranscriptContext["messages"];
  takeUsage?: () => AssistantMessage["usage"] | undefined;
  returnUsage?: (usage: AssistantMessage["usage"]) => void;
}

/**
 * When the run involves the owner's links, tool results or a required tool, holds back each
 * generation until its operation claims pass the evidence check, retries once with a correction,
 * and otherwise replaces the reply with what the receipts establish. Every other reply streams to
 * the owner as it is generated.
 */
export function withEvidenceBoundary(stream: StreamFn, options: EvidenceBoundaryOptions): StreamFn {
  return async (model, originalContext, callOptions) => {
    let context = originalContext;
    const secretValues = options.secrets?.() ?? [];
    const state = currentTurn({ ...context, messages: options.messages?.() ?? context.messages }, options.profiles, secretValues, options.messages !== undefined);
    const advised = { request: state.request, evidence: redactSecrets(state.evidence, secretValues), blockedUrls: state.blockedUrls, hasResults: state.hasResults };
    let routeRequired = false;
    if (options.advisor && state.request) {
      try {
        const tools = (options.tools?.() ?? []).map(({ name, description }) => ({ name, description: redactSecrets(description, secretValues).slice(0, 500) })).slice(0, 254);
        const advice = await options.advisor.advise(advised, tools, callOptions?.signal);
        routeRequired = advice.requireTool;
        if (advice.instruction) context = instruction(context, advice.instruction);
      } catch (error) {
        callOptions?.signal?.throwIfAborted();
        options.warn?.(error);
      }
    }
    callOptions?.signal?.throwIfAborted();
    let accumulatedUsage = addUsage(zeroUsage(), options.takeUsage?.() ?? zeroUsage());
    if (!state.urls.length && !state.hasResults && !routeRequired) {
      try {
        return passThrough(await stream(model, context, callOptions), accumulatedUsage);
      } catch (error) {
        options.returnUsage?.(accumulatedUsage);
        throw error;
      }
    }
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
      let unsupported = unsupportedClaim(reply, state, options.profiles) || (routeRequired && !state.hasResults && !message.content.some((part) => part.type === "toolCall"));
      if (options.advisor && reply) {
        try {
          // Always consult the advisor, even when the local check already rejected the reply.
          const overclaims = await options.advisor.unsupported({ ...advised, reply: redactSecrets(reply, secretValues).slice(0, 4000) }, callOptions?.signal);
          unsupported ||= overclaims;
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
      const safe = fallback(assistantOutput(message, message.content, accumulatedUsage), state, options.profiles);
      output.push({ type: "start", partial: safe });
      safe.content.forEach((part, index) => { if (part.type === "text") { output.push({ type: "text_start", contentIndex: index, partial: safe }); output.push({ type: "text_delta", contentIndex: index, delta: part.text, partial: safe }); output.push({ type: "text_end", contentIndex: index, content: part.text, partial: safe }); } });
      output.push({ type: "done", reason: "stop", message: safe });
      output.end(safe);
      return output;
    }
    throw new Error("Evidence check did not complete.");
  };
}
