import type { EvidenceProfiles } from "../context/claims.js";

/** What the vault tools' results prove for the evidence boundary. */
export const VAULT_TOOL_EVIDENCE: EvidenceProfiles = {
  vault_read: { supports: { read: true } },
};
