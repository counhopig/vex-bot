import { judgeAdvisor } from "../../src/policy/advice.js";
import type { DecisionJudge } from "../../src/policy/judge.js";
import type { EvidenceProfiles } from "../../src/context/claims.js";
import { CORE_TOOL_EVIDENCE } from "../../src/tools/evidence.js";
import { VAULT_TOOL_EVIDENCE } from "../../src/vault/evidence.js";
import { WIKI_TOOL_EVIDENCE } from "../../src/vault/wiki/evidence.js";

/** The daemon's evidence profiles, for sessions and boundaries built directly in tests. */
export const TOOL_EVIDENCE: EvidenceProfiles = { ...CORE_TOOL_EVIDENCE, ...VAULT_TOOL_EVIDENCE, ...WIKI_TOOL_EVIDENCE };
export const evidence = { profiles: TOOL_EVIDENCE };

/** The evidence options a session gets when a decision judge advises it. */
export function judged(options: { judge: DecisionJudge; confidence?: number; warn?: (error: unknown) => void; secrets?: () => string[] }) {
  return {
    profiles: TOOL_EVIDENCE,
    advisor: judgeAdvisor(options.judge, { confidence: options.confidence ?? 0.8, fallbackTools: ["bash", "delegate"] }),
    ...(options.warn ? { warn: options.warn } : {}),
    ...(options.secrets ? { secrets: options.secrets } : {}),
  };
}
