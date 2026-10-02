import { Type, type Static } from "typebox";

export const DecisionSchema = Type.Union([Type.Literal("allow"), Type.Literal("ask"), Type.Literal("deny")]);

const ThinkingSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);

const ModelRefSchema = Type.Object({
  provider: Type.String({ minLength: 1 }),
  id: Type.String({ minLength: 1 }),
  thinking: Type.Optional(ThinkingSchema),
});

const CustomModelSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  contextWindow: Type.Optional(Type.Integer({ minimum: 1 })),
  maxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
  reasoning: Type.Optional(Type.Boolean()),
  input: Type.Optional(Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]))),
});

const ProviderSchema = Type.Object({
  apiKey: Type.Optional(Type.String()),
  api: Type.Optional(Type.Union([Type.Literal("openai-completions"), Type.Literal("anthropic-messages")])),
  baseUrl: Type.Optional(Type.String({ minLength: 1 })),
  models: Type.Optional(Type.Array(CustomModelSchema)),
});

export const ConfigSchema = Type.Object({
  model: ModelRefSchema,
  backgroundModel: Type.Optional(ModelRefSchema),
  providers: Type.Optional(Type.Record(Type.String(), ProviderSchema)),
  web: Type.Optional(
    Type.Object({
      host: Type.Optional(Type.String({ minLength: 1 })),
      port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
      token: Type.Optional(Type.String()),
    }),
  ),
  workspace: Type.Optional(Type.String({ minLength: 1 })),
  tools: Type.Optional(Type.Object({ policy: Type.Optional(Type.Record(Type.String(), DecisionSchema)) })),
  bashEnvPassthrough: Type.Optional(Type.Array(Type.String())),
});

export type Decision = Static<typeof DecisionSchema>;
export type ThinkingSetting = Static<typeof ThinkingSchema>;
export type ModelRef = Static<typeof ModelRefSchema>;
export type CustomModelConfig = Static<typeof CustomModelSchema>;
export type ProviderConfig = Static<typeof ProviderSchema>;

export interface VexConfig {
  model: ModelRef;
  backgroundModel: ModelRef;
  providers: Record<string, ProviderConfig>;
  web: { host: string; port: number; token?: string };
  workspace: string;
  toolPolicy: Record<string, Decision>;
  bashEnvPassthrough: string[];
}
