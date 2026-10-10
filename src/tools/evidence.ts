import type { EvidenceProfiles, Receipt } from "../context/claims.js";

const readSource = (receipt: Receipt | undefined): boolean => receipt === undefined || receipt.sourceAvailable === true;

/** What the built-in tools' results prove for the evidence boundary. */
export const CORE_TOOL_EVIDENCE: EvidenceProfiles = {
  read: { supports: { read: true } },
  write: { supports: { updated: true, deleted: true } },
  edit: { supports: { updated: true, deleted: true } },
  bash: { supports: { executed: true, deleted: true }, endsLinkOnFailure: true },
  web_fetch: {
    supports: { read: readSource }, linkArgument: true, endsLinkOnFailure: true,
    describe: (receipt) => {
      const url = typeof receipt.requestedUrl === "string" ? ` for ${receipt.requestedUrl}` : "";
      return receipt.sourceAvailable === true ? `Reading succeeded${url}.` : `Reading did not return source text${url}${receipt.error ? `: ${String(receipt.error)}` : ""}.`;
    },
  },
  web_search: { supports: { searched: true } },
  memory_search: { supports: { searched: true } },
  schedule: { supports: { updated: true, sent: true } },
  delegate: { nestedEvidence: true },
  request_action_outcome: { bookkeeping: true },
};
