import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { Persona } from "../persona/index.js";

const FeelParams = Type.Object({
  mood: Type.Number({ minimum: -30, maximum: 30, description: "心情变化量" }),
  energy: Type.Optional(Type.Number({ minimum: -30, maximum: 30, description: "精力变化量" })),
  reason: Type.String({ minLength: 1, description: "情绪波动的原因" }),
  hours: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 24, default: 2, description: "持续小时数" })),
});

export function createFeelTool(persona: Persona): AgentTool<typeof FeelParams> {
  return {
    name: "feel", label: "记录情绪", description: "记录短时情绪波动，强度随时间线性消退。",
    parameters: FeelParams,
    async execute(_id, params) {
      persona.feel(params);
      await persona.save();
      return { content: [{ type: "text", text: persona.describe() }], details: {} };
    },
  };
}
