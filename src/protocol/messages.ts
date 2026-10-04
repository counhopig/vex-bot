import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { HistoryItem, SessionEvent } from "../core/events.js";
import type { WebSessionMeta } from "../core/webSessions.js";
import type { ApprovalRequest } from "../policy/approvals.js";

const SessionId = Type.String({ minLength: 1, maxLength: 100 });

const WorkspaceFileName = Type.Union([
  Type.Literal("SOUL.md"),
  Type.Literal("USER.md"),
  Type.Literal("MEMORY.md"),
  Type.Literal("HEARTBEAT.md"),
  Type.Literal("prompts/consolidation.md"),
  Type.Literal("prompts/outreach.md"),
]);
export type WorkspaceFile = Static<typeof WorkspaceFileName>;

export const ClientMessageSchema = Type.Union([
  Type.Object({ type: Type.Literal("open"), sessionId: SessionId }),
  Type.Object({ type: Type.Literal("send"), sessionId: SessionId, text: Type.String({ minLength: 1, maxLength: 100_000 }) }),
  Type.Object({ type: Type.Literal("stop"), sessionId: SessionId }),
  Type.Object({ type: Type.Literal("create_session") }),
  Type.Object({
    type: Type.Literal("rename_session"),
    sessionId: SessionId,
    title: Type.String({ minLength: 1, maxLength: 100 }),
  }),
  Type.Object({ type: Type.Literal("delete_session"), sessionId: SessionId }),
  Type.Object({
    type: Type.Literal("approve"),
    id: Type.String({ minLength: 1 }),
    answer: Type.Union([Type.Literal("allow"), Type.Literal("allow_session"), Type.Literal("deny")]),
  }),
  Type.Object({ type: Type.Literal("get_file"), name: WorkspaceFileName }),
  Type.Object({ type: Type.Literal("save_file"), name: WorkspaceFileName, text: Type.String({ maxLength: 200_000 }) }),
  Type.Object({ type: Type.Literal("get_status") }),
  Type.Object({ type: Type.Literal("get_settings") }),
  Type.Object({
    type: Type.Literal("save_settings"),
    set: Type.Optional(Type.Record(Type.String({ maxLength: 100 }), Type.Union([Type.String({ maxLength: 2000 }), Type.Number(), Type.Boolean(), Type.Array(Type.String({ maxLength: 100 }), { maxItems: 10 })]), { maxProperties: 60 })),
    unset: Type.Optional(Type.Array(Type.String({ maxLength: 100 }), { maxItems: 60 })),
  }),
  Type.Object({ type: Type.Literal("get_config") }),
  Type.Object({ type: Type.Literal("save_config"), text: Type.String({ maxLength: 1_000_000 }) }),
]);

export type ClientMessage = Static<typeof ClientMessageSchema>;

export interface StatusInfo {
  model: string;
  wechat: "connected" | "connecting" | "unlinked" | "expired" | "disabled";
  persona: { energy: number; mood: number; social: number; resting: boolean };
  reloadError?: string;
}

export type ServerMessage =
  | { type: "sessions"; sessions: WebSessionMeta[] }
  | { type: "session_created"; session: WebSessionMeta }
  | { type: "history"; sessionId: string; items: HistoryItem[]; busy: boolean; streaming?: string }
  | { type: "event"; sessionId: string; event: SessionEvent }
  | { type: "approvals"; pending: ApprovalRequest[] }
  | { type: "file"; name: WorkspaceFile; text: string }
  | { type: "file_saved"; name: WorkspaceFile; ok: boolean; error?: string; warning?: string }
  | { type: "status"; status: StatusInfo }
  | { type: "settings"; values: Record<string, string | number | boolean | string[]>; secrets: string[]; catalog: { providers: string[]; models: Record<string, string[]> } }
  | { type: "settings_saved"; ok: boolean; error?: string; restartRequired?: boolean; restarting?: boolean }
  | { type: "config"; text: string }
  | { type: "config_saved"; ok: boolean; error?: string; restarting?: boolean }
  | { type: "error"; message: string };

export function parseClientMessage(raw: string): ClientMessage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return Value.Check(ClientMessageSchema, value) ? value : undefined;
}
