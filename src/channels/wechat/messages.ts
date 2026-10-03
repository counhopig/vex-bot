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
        parts.push("[图片]");
        break;
      case 3: {
        const text = item.voice_item?.text ?? "";
        parts.push(text.trim() ? text : "[语音]");
        break;
      }
      case 4:
        parts.push("[文件]");
        break;
      case 5:
        parts.push("[视频]");
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
    const cut = newline > max / 2 ? newline : max;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export function formatClock(ms: number, timeZone?: string): string {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(ms);
}

export function formatApprovalPrompt(request: ApprovalRequest, pendingCount: number, timeZone?: string): string {
  const detail =
    request.detail.length > MAX_APPROVAL_DETAIL_CHARS
      ? `${request.detail.slice(0, MAX_APPROVAL_DETAIL_CHARS)}\n…（内容过长，完整内容请在网页查看）`
      : request.detail;
  const lines = [
    `【需要你批准】${request.windowLabel}想执行 ${request.toolName}：`,
    detail,
    `回复 /y 允许，/ya 本会话总是允许，/n 拒绝（${formatClock(request.expiresAt, timeZone)} 前不回复将自动拒绝）`,
  ];
  if (pendingCount > 1) lines.push(`（共有 ${pendingCount} 条待批准，按先后顺序处理）`);
  return lines.join("\n");
}
