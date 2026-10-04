import type { ApprovalAnswer, ApprovalRequest } from "../../policy/approvals.js";
import type { InboundItem } from "./client.js";

export const MAX_MESSAGE_CHARS = 2000;
const MAX_APPROVAL_DETAIL_CHARS = 1500;

export type OwnerCommand =
  | { kind: "stop" }
  | { kind: "approve"; answer: ApprovalAnswer }
  | { kind: "chat"; text: string };

const COMMANDS: Record<string, OwnerCommand> = {
  "/stop": { kind: "stop" },
  "/y": { kind: "approve", answer: "allow" },
  "/ya": { kind: "approve", answer: "allow_session" },
  "/n": { kind: "approve", answer: "deny" },
};

// Move back if cutting between a high and low surrogate pair.
function safeCutPoint(text: string, cut: number): number {
  if (cut > 0) {
    const codeUnit = text.charCodeAt(cut - 1);
    if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
      return cut - 1;
    }
  }
  return cut;
}

export function extractText(items: InboundItem[]): string {
  const parts: string[] = [];
  for (const item of items) {
    switch (item.type) {
      case 1: {
        const text = item.text_item?.text ?? "";
        if (text.trim()) parts.push(text);
        break;
      }
      case 2:
        parts.push("[image]");
        break;
      case 3: {
        const text = item.voice_item?.text ?? "";
        parts.push(text.trim() ? text : "[voice]");
        break;
      }
      case 4:
        parts.push("[file]");
        break;
      case 5:
        parts.push("[video]");
        break;
      default:
        break;
    }
  }
  return parts.join("\n").trim();
}

export function parseCommand(text: string): OwnerCommand {
  // Chinese input methods often produce a full-width slash.
  const normalized = text.trim().replace(/^／/, "/").toLowerCase();
  return COMMANDS[normalized] ?? { kind: "chat", text };
}

export function splitMessage(text: string, max = MAX_MESSAGE_CHARS): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const newline = rest.lastIndexOf("\n", max);
    let cut = newline > max / 2 ? newline : max;
    // Fall back to one whole code point so every pass consumes input.
    cut = safeCutPoint(rest, cut) || safeCutPoint(rest, 1) || 2;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export function formatClock(ms: number, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(ms);
}

export function formatApprovalPrompt(request: ApprovalRequest, pendingCount: number, timeZone?: string): string {
  let detail = request.detail;
  if (detail.length > MAX_APPROVAL_DETAIL_CHARS) {
    const cut = safeCutPoint(detail, MAX_APPROVAL_DETAIL_CHARS);
    detail = `${detail.slice(0, cut)}\n… (content too long; see the full text in WebChat)`;
  }
  const lines = [
    `[Approval needed] ${request.windowLabel} wants to run ${request.toolName}:`,
    detail,
    `Reply /y to allow, /ya to always allow in this conversation, /n to deny (denied automatically if there is no answer by ${formatClock(request.expiresAt, timeZone)})`,
  ];
  if (pendingCount > 1) lines.push(`(${pendingCount} approvals are pending; they are handled in order)`);
  return lines.join("\n");
}
