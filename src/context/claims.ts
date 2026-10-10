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
  /**
   * The call acts on the link in its `url` argument (and its receipt's requestedUrl/canonicalUrl).
   * Only such tools can support a claim about one of the owner's links, and only for that exact link.
   */
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

function normalizedUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

/** The links a call acted on: its parsed `url` argument and the URLs its receipt reports. */
export function linkTargets(entry: { arguments?: string | Record<string, unknown>; receipt?: Receipt }): string[] {
  let args: unknown = entry.arguments;
  if (typeof args === "string") {
    try { args = JSON.parse(args); } catch { args = undefined; }
  }
  const argumentUrl = args && typeof args === "object" ? (args as { url?: unknown }).url : undefined;
  return [argumentUrl, entry.receipt?.requestedUrl, entry.receipt?.canonicalUrl].flatMap((value) => normalizedUrl(value) ?? []);
}

/** Whether a call acted on exactly this link; a longer URL sharing its prefix is a different link. */
export function actsOnLink(entry: { arguments?: string | Record<string, unknown>; receipt?: Receipt }, url: string): boolean {
  const wanted = normalizedUrl(url);
  return wanted !== undefined && linkTargets(entry).includes(wanted);
}

/** Whether a call's arguments name exactly this link as a whole URL, not as the prefix of a longer one. */
export function mentionsLink(args: unknown, url: string): boolean {
  const wanted = normalizedUrl(url);
  return wanted !== undefined && extractUrls(JSON.stringify(args ?? {}).replace(/\\"/g, " ")).some((found) => normalizedUrl(found) === wanted);
}

/** Claims about obtaining a link's source, which only a call on that link can support. */
const SOURCE_CLAIMS = new Set<ClaimKind>(["read", "archived"]);

export function extractUrls(text: string): string[] {
  return [...new Set((text.match(/https?:\/\/[^\s<>"']+/g) ?? []).map((url) => url.replace(/[),.!?。；，]+$/, "")))];
}

/** One clause of a reply that claims operations, bound to the links that clause names. */
interface Statement { text: string; urls: string[] }

const CLAUSE_BREAK = /(?<=[.!?;])\s+|[。！？；，、]|,\s*|\bbut\b|\bhowever\b|\bwhile\b|但是?|不过|然而|而/i;
const PROSPECTIVE = /^\s*(?:i(?:'ll| will| am going to)|let me|we(?:'ll| will)|going to)\b|^\s*(?:我(?:会|将|来|准备|正在)|正在|准备|稍后)/i;
// A clause opening with the verb is an instruction ("Read the README first"), not a report.
const IMPERATIVE = /^\s*(?:read|save|archive|publish|push|compile|download|retrieve)\b/i;
// A negated or failed operation is not a completion claim, whatever its verb.
const NEGATED = /\b(?:not|never|no|failed|fails|unable|cannot|can't|couldn't|didn't|haven't|hasn't|wasn't|weren't|won't)\b|未|没有|没能|无法|不能|失败|尚未/i;

/**
 * The reply's affirmative clauses, each with the links it names. Binding an operation to the links
 * in its own clause keeps "I read A. I did not read B." from being checked as a claim about B.
 */
function statements(reply: string): Statement[] {
  return reply.split(CLAUSE_BREAK).flatMap((clause) => {
    if (!clause?.trim() || PROSPECTIVE.test(clause) || IMPERATIVE.test(clause) || NEGATED.test(clause)) return [];
    return [{ text: clause, urls: extractUrls(clause) }];
  });
}

/**
 * Whether the reply claims a completed operation that no recorded result supports. A claim about the
 * turn's links needs, for every named link, the newest supporting call that acted on that link.
 * Without links, a claim is checked only when the turn called a tool that can support it: wording
 * with no operation behind it is left to the evidence advisor rather than judged by keyword.
 */
export function unsupportedClaim(reply: string, turn: { urls: string[]; evidence: unknown[] }, profiles: EvidenceProfiles): boolean {
  const entries = turn.evidence.filter((item): item is EvidenceEntry => Boolean(item && typeof item === "object" && typeof (item as EvidenceEntry).tool === "string"));
  const sameLink = (a: string, b: string) => normalizedUrl(a) !== undefined && normalizedUrl(a) === normalizedUrl(b);
  return statements(reply).some((statement) => CLAIMS.some(({ kind, pattern }) => {
    if (!pattern.test(statement.text)) return false;
    if (!turn.urls.length && !entries.some((entry) => profiles[entry.tool]?.supports?.[kind])) return false;
    // A clause naming some of the owner's links claims only those; one naming none claims them all.
    const described = turn.urls.filter((url) => statement.urls.some((named) => sameLink(named, url)));
    const targets = described.length ? described : turn.urls;
    const candidate = (entry: EvidenceEntry, url?: string): boolean => {
      const profile = profiles[entry.tool];
      if (!profile?.supports?.[kind]) return false;
      if (!url) return true;
      // A tool that acts on links supports a claim only for the exact link it acted on.
      if (profile.linkArgument) return actsOnLink(entry, url);
      // Reading or archiving a link needs a call on that link: a local file read proves nothing about a web page.
      // Compiling and publishing concern the Wiki, which tools without a link target also change.
      return !SOURCE_CLAIMS.has(kind);
    };
    const supported = (url?: string): boolean => {
      const latest = [...entries].reverse().find((entry) => candidate(entry, url));
      if (!latest || latest.error !== false) return false;
      const rule = profiles[latest.tool]!.supports![kind]!;
      return rule === true || rule(latest.receipt);
    };
    return targets.length === 0 ? !supported() : !targets.every((url) => supported(url));
  }));
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
    if (turn.urls.length && url && !turn.urls.some((requested) => actsOnLink(entry, requested))) continue;
    newest.set(`${entry.tool}:${url}`, { tool: entry.tool, receipt: entry.receipt });
  }
  return [...newest.values()].flatMap(({ tool, receipt }) => profiles[tool]!.describe!(receipt) ?? []);
}
