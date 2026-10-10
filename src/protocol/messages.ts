import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { HistoryItem, SessionEvent } from "../core/events.js";
import type { WebSessionMeta } from "../core/webSessions.js";
import type { ApprovalRequest } from "../policy/approvals.js";
import type { ScheduledTask } from "../scheduler/index.js";

const SessionId = Type.String({ minLength: 1, maxLength: 100 });

const WorkspaceFileName = Type.Union([
  Type.Literal("SOUL.md"),
  Type.Literal("USER.md"),
  Type.Literal("MEMORY.md"),
  Type.Literal("HEARTBEAT.md"),
  Type.String({ pattern: "^memory/[0-9]{4}-[0-9]{2}-[0-9]{2}\\.md$" }),
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
  Type.Object({ type: Type.Literal("list_notes") }),
  // base is the text the editor loaded; a save is refused when the file has changed since.
  Type.Object({ type: Type.Literal("save_file"), name: WorkspaceFileName, text: Type.String({ maxLength: 200_000 }), base: Type.Optional(Type.String({ maxLength: 200_000 })) }),
  Type.Object({ type: Type.Literal("get_status") }),
  Type.Object({ type: Type.Literal("get_settings") }),
  Type.Object({
    type: Type.Literal("save_settings"),
    set: Type.Optional(Type.Record(Type.String({ maxLength: 100 }), Type.Union([Type.String({ maxLength: 2000 }), Type.Number(), Type.Boolean(), Type.Array(Type.String({ maxLength: 100 }), { maxItems: 10 })]), { maxProperties: 60 })),
    unset: Type.Optional(Type.Array(Type.String({ maxLength: 100 }), { maxItems: 60 })),
  }),
  Type.Object({ type: Type.Literal("get_schedules") }),
  Type.Object({
    type: Type.Literal("save_schedule"),
    id: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    name: Type.String({ minLength: 1, maxLength: 100 }),
    prompt: Type.String({ minLength: 1, maxLength: 4000 }),
    target: Type.String({ minLength: 1, maxLength: 100 }),
    enabled: Type.Boolean(),
    schedule: Type.Union([
      Type.Object({ cron: Type.String({ minLength: 1, maxLength: 100 }) }),
      Type.Object({ every: Type.String({ minLength: 1, maxLength: 20 }) }),
      Type.Object({ once: Type.String({ minLength: 1, maxLength: 40 }) }),
    ]),
  }),
  Type.Object({ type: Type.Literal("delete_schedule"), id: Type.String({ minLength: 1, maxLength: 100 }) }),
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
  | { type: "notes"; names: string[] }
  | { type: "file_saved"; name: WorkspaceFile; ok: boolean; error?: string; warning?: string }
  | { type: "status"; status: StatusInfo }
  | { type: "settings"; values: Record<string, string | number | boolean | string[]>; secrets: string[]; catalog: { providers: string[]; models: Record<string, string[]> } }
  | { type: "settings_saved"; ok: boolean; error?: string; restartRequired?: boolean; restarting?: boolean }
  | { type: "schedules"; tasks: ScheduledTask[]; targets: { id: string; label: string }[] }
  | { type: "schedule_saved"; ok: boolean; error?: string }
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
