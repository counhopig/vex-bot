/** A tool result's `details.receipt`, as bounded for evidence checks. */
export type Receipt = Record<string, unknown>;

/**
 * Completed operations on the owner's links that a reply may claim only with a matching successful
 * tool result. Only operations whose tools return structured receipts are listed: wording alone is
 * no evidence, and a tool succeeding proves nothing about an operation it does not report.
 */
export type ClaimKind = "archived" | "published" | "compiled" | "read";

/**
 * What one tool's results prove. Each module declares this for the tools it owns, so the evidence
 * boundary checks claims without knowing any tool or receipt format itself.
 */
export interface ToolEvidence {
  /** Claims a successful call supports; a function also requires its receipt to back the claim. */
  supports?: Partial<Record<ClaimKind, true | ((receipt: Receipt | undefined) => boolean)>>;
  /** The call's `url` argument names the link it acts on, so a claim about a link needs this link's call. */
  linkArgument?: boolean;
  /** A failed call that mentions a shared link ends that link's action. */
  endsLinkOnFailure?: boolean;
  /** Runtime bookkeeping that proves no operation. */
  bookkeeping?: boolean;
  /** The receipt carries the calls of a child agent in `evidence`. */
  nestedEvidence?: boolean;
  /** One sentence about a receipt, used when a reply has to be replaced by the recorded facts. */
  describe?: (receipt: Receipt) => string | undefined;
}

export type EvidenceProfiles = Readonly<Record<string, ToolEvidence>>;

/** One bounded tool call and its result, as the boundary records it. */
export interface EvidenceEntry { tool: string; arguments?: string; error?: unknown; receipt?: Receipt }

const CLAIMS: { kind: ClaimKind; pattern: RegExp }[] = [
  { kind: "archived", pattern: /\b(saved|archived)\b|已(?:保存|归档)/i },
  { kind: "published", pattern: /\b(published|pushed)\b|已(?:发布|推送)/i },
  { kind: "compiled", pattern: /\b(compiled)\b|已编译/i },
  { kind: "read", pattern: /\b(read|retrieved|downloaded)\b|已(?:读取|读完|获取)/i },
];

export function extractUrls(text: string): string[] {
  return [...new Set((text.match(/https?:\/\/[^\s<>"']+/g) ?? []).map((url) => url.replace(/[),.!?。；，]+$/, "")))];
}

/** Prospective ("I'll read"), imperative ("Read the README") and negated ("not saved") clauses claim nothing. */
function claimedText(reply: string): string {
  return reply.split(/(?<=[.!?;])\s+|\bbut\b|\bhowever\b|,\s*/i).map((clause) => {
    if (/^\s*(?:i(?:'ll| will| am going to)|let me|we(?:'ll| will)|going to)\b/i.test(clause)) return "";
    if (/^\s*(?:read|save|archive|publish|push|compile|download|retrieve)\b/i.test(clause)) return "";
    return clause.replace(/\b(?:not|never|haven't|didn't|won't)\s+(?:been\s+)?(?:saved|archived|published|pushed|searched|read|retrieved|downloaded|executed|run|updated|deleted|sent)\b/gi, "");
  }).join(" ");
}

/**
 * Whether the reply claims a completed operation that no recorded result supports. A claim about the
 * turn's links needs, for every named link, the newest supporting call that acted on that link.
 * Without links, a claim is checked only when the turn called a tool that can support it: wording
 * with no operation behind it is left to the evidence advisor rather than judged by keyword.
 */
export function unsupportedClaim(reply: string, turn: { urls: string[]; evidence: unknown[] }, profiles: EvidenceProfiles): boolean {
  const text = claimedText(reply);
  const entries = turn.evidence.filter((item): item is EvidenceEntry => Boolean(item && typeof item === "object" && typeof (item as EvidenceEntry).tool === "string"));
  return CLAIMS.some(({ kind, pattern }) => {
    if (!pattern.test(text)) return false;
    if (!turn.urls.length && !entries.some((entry) => profiles[entry.tool]?.supports?.[kind])) return false;
    const described = extractUrls(text).filter((url) => turn.urls.includes(url));
    const targets = described.length ? described : turn.urls;
    const candidate = (entry: EvidenceEntry, url?: string): boolean => {
      const profile = profiles[entry.tool];
      if (!profile?.supports?.[kind]) return false;
      if (!url || !profile.linkArgument) return true;
      return `${entry.arguments ?? ""} ${String(entry.receipt?.requestedUrl ?? "")} ${String(entry.receipt?.canonicalUrl ?? "")}`.includes(url);
    };
    const supported = (url?: string): boolean => {
      const latest = [...entries].reverse().find((entry) => candidate(entry, url));
      if (!latest || latest.error !== false) return false;
      const rule = profiles[latest.tool]!.supports![kind]!;
      return rule === true || rule(latest.receipt);
    };
    return targets.length === 0 ? !supported() : !targets.every((url) => supported(url));
  });
}

/** Sentences describing the newest receipt per tool and link of this turn, for a replacement reply. */
export function describeOutcomes(turn: { urls: string[]; evidence: unknown[] }, profiles: EvidenceProfiles): string[] {
  const newest = new Map<string, { tool: string; receipt: Receipt }>();
  for (const item of turn.evidence) {
    if (!item || typeof item !== "object") continue;
    const entry = item as EvidenceEntry;
    if (!entry.receipt || !profiles[entry.tool]?.describe) continue;
    let argumentUrl = "";
    try {
      const args = JSON.parse(entry.arguments ?? "{}") as { url?: unknown };
      if (typeof args.url === "string") argumentUrl = args.url;
    } catch { /* bounded evidence may not contain parseable arguments */ }
    const url = typeof entry.receipt.requestedUrl === "string" ? entry.receipt.requestedUrl : argumentUrl;
    if (turn.urls.length && url && !turn.urls.includes(url)) continue;
    newest.set(`${entry.tool}:${url}`, { tool: entry.tool, receipt: entry.receipt });
  }
  return [...newest.values()].flatMap(({ tool, receipt }) => profiles[tool]!.describe!(receipt) ?? []);
}
