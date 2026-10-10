import type { EvidenceProfiles, Receipt } from "../../context/claims.js";

const FAILED = ["failed-read", "failed-run", "bootstrap-pending"];

/** The sentence a wiki_ingest receipt supports when a reply has to be replaced by the facts. */
function describeIngest(wiki: Receipt): string | undefined {
  const url = typeof wiki.requestedUrl === "string" ? ` for ${wiki.requestedUrl}` : "";
  if (wiki.status === "bootstrap-pending") return `Archival is awaiting review${url}.`;
  if (wiki.status === "failed-read" && wiki.sourceAvailable === true && wiki.truncated === true) return `Reading returned a truncated source${url}; complete archival was refused.`;
  if (wiki.status === "failed-read") return `Reading failed${url}: ${String(wiki.error ?? "the source could not be retrieved")}.`;
  if (wiki.status === "failed-run") return `${wiki.sourceAvailable === true ? "Reading succeeded" : "Reading did not complete"}${url}, but Wiki compilation failed: ${String(wiki.error ?? "the transaction did not complete")}.`;
  const facts: string[] = [];
  if (wiki.sourceAvailable === true && wiki.rawPath) facts.push("source archived");
  else if (wiki.sourceAvailable === true) facts.push("source read");
  if (Array.isArray(wiki.compiledPages) && wiki.compiledPages.length > 0) facts.push("Wiki compiled");
  if (wiki.publication === "published") facts.push("published");
  else if (wiki.publication === "pending") facts.push("publication pending");
  else if (wiki.publication === "preview") facts.push("awaiting review");
  return facts.length ? `${facts.join(", ")}${url}.` : undefined;
}

const published = (receipt: Receipt | undefined): boolean => receipt?.publication === "published";

/** What the wiki tools' results and receipts prove for the evidence boundary. */
export const WIKI_TOOL_EVIDENCE: EvidenceProfiles = {
  wiki_ingest: {
    supports: {
      archived: (r) => Boolean(r && r.sourceAvailable === true && typeof r.rawPath === "string" && r.rawPath && !FAILED.includes(String(r.status))),
      published,
      compiled: (r) => r === undefined || (Array.isArray(r.compiledPages) && r.compiledPages.length > 0),
      read: (r) => r === undefined || r.sourceAvailable === true,
    },
    linkArgument: true, endsLinkOnFailure: true, describe: describeIngest,
  },
  wiki_write: { supports: { compiled: true } },
  wiki_edit: { supports: { compiled: true } },
  wiki_bootstrap: { supports: { published } },
};
