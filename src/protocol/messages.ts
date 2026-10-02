import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { HistoryItem, SessionEvent } from "../core/events.js";
import type { WebSessionMeta } from "../core/webSessions.js";
import type { ApprovalRequest } from "../policy/approvals.js";

const SessionId = Type.String({ minLength: 1, maxLength: 100 });

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
  Type.Object({ type: Type.Literal("get_config") }),
  Type.Object({ type: Type.Literal("save_config"), text: Type.String({ maxLength: 1_000_000 }) }),
]);

export type ClientMessage = Static<typeof ClientMessageSchema>;

export type ServerMessage =
  | { type: "sessions"; sessions: WebSessionMeta[] }
  | { type: "session_created"; session: WebSessionMeta }
  | { type: "history"; sessionId: string; items: HistoryItem[]; busy: boolean; streaming?: string }
  | { type: "event"; sessionId: string; event: SessionEvent }
  | { type: "approvals"; pending: ApprovalRequest[] }
  | { type: "config"; text: string }
  | { type: "config_saved"; ok: boolean; error?: string }
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
