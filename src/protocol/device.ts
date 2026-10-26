import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const RequestId = Type.String({ minLength: 1, maxLength: 100 });

export const DeviceClientMessageSchema = Type.Union([
  Type.Object({ type: Type.Literal("send"), id: RequestId, text: Type.String({ minLength: 1, maxLength: 4000 }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("stop") }, { additionalProperties: false }),
]);

export type DeviceClientMessage = Static<typeof DeviceClientMessageSchema>;

export type ReplyStatus = "ok" | "interrupted" | "error";

export type DeviceServerMessage =
  | { type: "hello"; busy: boolean }
  | { type: "accepted"; id: string }
  | { type: "busy"; busy: boolean }
  /** `ids` lists the owner messages the reply answers; it is empty for a message the runtime started. */
  | { type: "reply"; ids: string[]; text: string; status: ReplyStatus }
  | { type: "needs_approval"; tool: string; summary: string }
  | { type: "error"; message: string };

export function parseDeviceMessage(raw: string): DeviceClientMessage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return Value.Check(DeviceClientMessageSchema, value) ? value : undefined;
}
