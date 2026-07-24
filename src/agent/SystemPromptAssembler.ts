/**
 * SystemPromptAssembler — assembles the 5-section system prompt.
 *
 * Architecture doc (§11):
 *   Section 1: PERSONA (BASE) — always first. The LLM sees identity first,
 *              capabilities second.
 *   Section 2: ENVIRONMENT    — working directory, platform, time
 *   Section 3: TOOL RULES     — file ops, bash, browser, memory guides
 *   Section 4: SKILLS         — injected skill content
 *   Section 5: OUTPUT FORMAT  — markdown, concise, code over description
 *
 * Key rule: Persona is Section 1. Always.
 *
 * When persona is set, DEFAULT_IDENTITY is excluded — persona owns identity
 * exclusively. When persona is absent/falsy, DEFAULT_IDENTITY is used.
 * This is the fix for the 2026-07-17 competing-identity incident.
 */

// ---------------------------------------------------------------------------
// Default identity
// ---------------------------------------------------------------------------

/** Used when no persona is configured (bare tool executor mode). */
export const DEFAULT_IDENTITY =
  "You are a helpful AI assistant. Be concise, accurate, and polite.";

// ---------------------------------------------------------------------------
// Section headers
// ---------------------------------------------------------------------------

const SECTION_LABELS: Record<string, string> = {
  persona: "【角色身份】",
  environment: "【环境信息】",
  toolRules: "【工具使用规则】",
  skills: "【技能模板】",
  outputFormat: "【输出格式】",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SystemPromptSections {
  persona?: string;
  environment?: string;
  toolRules?: string;
  skills?: string;
  outputFormat?: string;
}

// ---------------------------------------------------------------------------
// Assembler
// ---------------------------------------------------------------------------

/**
 * Assemble the system prompt from sections.
 *
 * Section order is always: persona → environment → toolRules → skills →
 * outputFormat. Any section can be omitted — only provided sections are
 * included (except for Section 1: if persona is absent/falsy,
 * DEFAULT_IDENTITY is used so there is always a base identity).
 */
export function assembleSystemPrompt(sections: SystemPromptSections): string {
  const parts: string[] = [];

  // Section 1: persona or DEFAULT_IDENTITY (mutually exclusive)
  if (sections.persona) {
    parts.push(`${SECTION_LABELS.persona}\n${sections.persona}`);
  } else {
    parts.push(DEFAULT_IDENTITY);
  }

  // Section 2: environment
  if (sections.environment) {
    parts.push(`${SECTION_LABELS.environment}\n${sections.environment}`);
  }

  // Section 3: tool rules
  if (sections.toolRules) {
    parts.push(`${SECTION_LABELS.toolRules}\n${sections.toolRules}`);
  }

  // Section 4: skills
  if (sections.skills) {
    parts.push(`${SECTION_LABELS.skills}\n${sections.skills}`);
  }

  // Section 5: output format
  if (sections.outputFormat) {
    parts.push(`${SECTION_LABELS.outputFormat}\n${sections.outputFormat}`);
  }

  return parts.join("\n\n---\n\n");
}
