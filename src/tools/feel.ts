import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { Persona } from "../persona/index.js";

const FeelParams = Type.Object({
  mood: Type.Number({ minimum: -30, maximum: 30, description: "Change in mood" }),
  energy: Type.Optional(Type.Number({ minimum: -30, maximum: 30, description: "Change in energy" })),
  reason: Type.String({ minLength: 1, description: "Reason for the mood change" }),
  hours: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 24, default: 2, description: "Duration in hours" })),
});

export function createFeelTool(persona: Persona): AgentTool<typeof FeelParams> {
  return {
    name: "feel", label: "Record feeling", description: "Records a short-lived mood change whose strength fades linearly over time.",
    parameters: FeelParams,
    async execute(_id, params) {
      persona.feel(params);
      await persona.save();
      return { content: [{ type: "text", text: persona.describe() }], details: {} };
    },
  };
}
