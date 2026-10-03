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
  compaction: Type.Optional(Type.Object({ threshold: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 1 })) })),
  memory: Type.Optional(Type.Object({ consolidateAt: Type.Optional(Type.String({ pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$" })) })),
  heartbeat: Type.Optional(Type.Object({
    every: Type.Optional(Type.String({ pattern: "^[1-9][0-9]*(ms|s|m|h|d)$" })),
    activeHours: Type.Optional(Type.Tuple([Type.String({ pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$" }), Type.String({ pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$" })])),
  })),
  persona: Type.Optional(Type.Object({
    sleep: Type.Optional(Type.Tuple([Type.String({ pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$" }), Type.String({ pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$" })])),
    outreach: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean()),
      checkEvery: Type.Optional(Type.String({ pattern: "^[1-9][0-9]*(ms|s|m|h|d)$" })),
      socialThreshold: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
      quietHours: Type.Optional(Type.Number({ minimum: 0 })),
      dailyLimit: Type.Optional(Type.Integer({ minimum: 0 })),
    })),
  })),
  webSearch: Type.Optional(Type.Object({ provider: Type.Literal("brave"), apiKey: Type.Optional(Type.String()) })),
  mcpServers: Type.Optional(Type.Record(Type.String(), Type.Union([
    Type.Object({ command: Type.String({ minLength: 1 }), args: Type.Optional(Type.Array(Type.String())), env: Type.Optional(Type.Record(Type.String(), Type.String())), cwd: Type.Optional(Type.String()) }),
    Type.Object({ url: Type.String({ minLength: 1 }), headers: Type.Optional(Type.Record(Type.String(), Type.String())) }),
  ]))),
  wechat: Type.Optional(
    Type.Object({
      enabled: Type.Optional(Type.Boolean()),
      ownerId: Type.Optional(Type.String({ minLength: 1 })),
      baseUrl: Type.Optional(Type.String({ minLength: 1 })),
    }),
  ),
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
  wechat: { enabled: boolean; ownerId?: string; baseUrl: string };
  compaction?: { threshold: number };
  memory?: { consolidateAt?: string };
  heartbeat?: { every?: string; activeHours?: [string, string] };
  persona?: { sleep?: [string, string]; outreach?: { enabled?: boolean; checkEvery?: string; socialThreshold?: number; quietHours?: number; dailyLimit?: number } };
  webSearch?: { provider: "brave"; apiKey?: string };
  mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string>; cwd?: string } | { url: string; headers?: Record<string, string> }>;
}

export const DEFAULT_WECHAT_BASE_URL = "https://ilinkai.weixin.qq.com";
