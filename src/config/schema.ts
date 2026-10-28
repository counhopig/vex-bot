import { Type, type Static, type TProperties } from "typebox";

/** Configuration objects reject unknown keys, so a misspelt setting fails validation instead of being ignored. */
const StrictObject = <T extends TProperties>(properties: T) => Type.Object(properties, { additionalProperties: false });

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

const ModelRefSchema = StrictObject({
  provider: Type.String({ minLength: 1 }),
  id: Type.String({ minLength: 1 }),
  thinking: Type.Optional(ThinkingSchema),
});

const CustomModelSchema = StrictObject({
  id: Type.String({ minLength: 1 }),
  contextWindow: Type.Optional(Type.Integer({ minimum: 1 })),
  maxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
  reasoning: Type.Optional(Type.Boolean()),
  input: Type.Optional(Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]))),
});

const ProviderSchema = StrictObject({
  apiKey: Type.Optional(Type.String()),
  api: Type.Optional(Type.Union([Type.Literal("openai-completions"), Type.Literal("anthropic-messages")])),
  baseUrl: Type.Optional(Type.String({ minLength: 1 })),
  models: Type.Optional(Type.Array(CustomModelSchema)),
});

export const WikiSchema = StrictObject({
  enabled: Type.Optional(Type.Boolean()),
  every: Type.Optional(Type.String()),
  notify: Type.Optional(Type.Boolean()),
  maxNotesPerRun: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});

export const ConfigSchema = StrictObject({
  model: ModelRefSchema,
  backgroundModel: Type.Optional(ModelRefSchema),
  providers: Type.Optional(Type.Record(Type.String(), ProviderSchema)),
  web: Type.Optional(
    StrictObject({
      host: Type.Optional(Type.String({ minLength: 1 })),
      port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
      token: Type.Optional(Type.String()),
    }),
  ),
  workspace: Type.Optional(Type.String({ minLength: 1 })),
  tools: Type.Optional(StrictObject({
    policy: Type.Optional(Type.Record(Type.String(), DecisionSchema)),
    sandbox: Type.Optional(StrictObject({
      mode: Type.Optional(Type.Union([Type.Literal("off"), Type.Literal("workspace")])),
      readable: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
      writable: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
      helper: Type.Optional(Type.String({ minLength: 1 })),
    })),
  })),
  bashEnvPassthrough: Type.Optional(Type.Array(Type.String())),
  compaction: Type.Optional(StrictObject({ threshold: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 1 })) })),
  memory: Type.Optional(StrictObject({ consolidateAt: Type.Optional(Type.String({ pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$" })) })),
  heartbeat: Type.Optional(StrictObject({
    every: Type.Optional(Type.String({ pattern: "^[1-9][0-9]*(s|m|h|d)$" })),
    activeHours: Type.Optional(Type.Tuple([Type.String({ pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$" }), Type.String({ pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$" })])),
  })),
  persona: Type.Optional(StrictObject({
    sleep: Type.Optional(Type.Tuple([Type.String({ pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$" }), Type.String({ pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$" })])),
    outreach: Type.Optional(StrictObject({
      enabled: Type.Optional(Type.Boolean()),
      checkEvery: Type.Optional(Type.String({ pattern: "^[1-9][0-9]*(s|m|h|d)$" })),
      socialThreshold: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
      quietHours: Type.Optional(Type.Number({ minimum: 0 })),
      dailyLimit: Type.Optional(Type.Integer({ minimum: 0 })),
    })),
  })),
  webSearch: Type.Optional(StrictObject({ provider: Type.Union([Type.Literal("brave"), Type.Literal("tavily"), Type.Literal("searxng"), Type.Literal("deepseek")]), apiKey: Type.Optional(Type.String()), baseUrl: Type.Optional(Type.String({ minLength: 1 })) })),
  stt: Type.Optional(StrictObject({
    provider: Type.Optional(Type.Union([Type.Literal("openai"), Type.Literal("mimo")])),
    baseUrl: Type.String({ minLength: 1 }),
    model: Type.String({ minLength: 1 }),
    apiKey: Type.Optional(Type.String()),
    language: Type.Optional(Type.String({ minLength: 1 })),
    chunkMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
    maxMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 600 })),
  })),
  links: Type.Optional(StrictObject({
    defaultIntent: Type.Optional(Type.Union([Type.Literal("archive"), Type.Literal("read")])),
    bilibili: Type.Optional(StrictObject({ sessdata: Type.Optional(Type.String()) })),
  })),
  vault: Type.Optional(StrictObject({
    path: Type.Optional(Type.String({ minLength: 1 })),
    url: Type.Optional(Type.String({ pattern: "^https?://\\S+$" })),
    branch: Type.Optional(Type.String({ minLength: 1 })),
    username: Type.Optional(Type.String({ minLength: 1 })),
    token: Type.Optional(Type.String()),
    wiki: Type.Optional(WikiSchema),
  })),
  jev: Type.Optional(StrictObject({
    enabled: Type.Optional(Type.Boolean()),
    apiKey: Type.Optional(Type.String()),
    model: Type.Optional(Type.String({ minLength: 1 })),
    confidence: Type.Optional(Type.Number({ minimum: 0.5, maximum: 1 })),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 30000 })),
  })),
  mcpServers: Type.Optional(Type.Record(Type.String({ pattern: "^[A-Za-z0-9-]{1,32}$" }), Type.Union([
    StrictObject({ command: Type.String({ minLength: 1 }), args: Type.Optional(Type.Array(Type.String())), env: Type.Optional(Type.Record(Type.String(), Type.String())), cwd: Type.Optional(Type.String()) }),
    StrictObject({ url: Type.String({ minLength: 1 }), headers: Type.Optional(Type.Record(Type.String(), Type.String())) }),
  ]), { additionalProperties: false })),
  wechat: Type.Optional(
    StrictObject({
      enabled: Type.Optional(Type.Boolean()),
      ownerId: Type.Optional(Type.String({ minLength: 1 })),
      baseUrl: Type.Optional(Type.String({ minLength: 1 })),
    }),
  ),
  device: Type.Optional(
    StrictObject({
      token: Type.Optional(Type.String()),
      label: Type.Optional(Type.String({ minLength: 1, maxLength: 60 })),
    }),
  ),
});

export type Decision = Static<typeof DecisionSchema>;
export type ThinkingSetting = Static<typeof ThinkingSchema>;
export type ModelRef = Static<typeof ModelRefSchema>;
export type CustomModelConfig = Static<typeof CustomModelSchema>;
export type ProviderConfig = Static<typeof ProviderSchema>;

/** The notes vault; `wiki` is present only when the wiki is enabled, which requires a git `url`. */
export interface VaultConfig { path?: string; url?: string; branch?: string; username?: string; token?: string; wiki?: WikiConfig }

export interface WikiConfig { every: string; notify: boolean; maxNotesPerRun: number }

export interface VexConfig {
  model: ModelRef;
  backgroundModel: ModelRef;
  providers: Record<string, ProviderConfig>;
  web: { host: string; port: number; token?: string };
  workspace: string;
  toolPolicy: Record<string, Decision>;
  /** Absent when `tools.sandbox` is not configured, which leaves bash unconfined. */
  sandbox?: import("../tools/sandbox.js").SandboxConfig;
  bashEnvPassthrough: string[];
  wechat: { enabled: boolean; ownerId?: string; baseUrl: string };
  /** The device connection is on only with a token, which `VEX_DEVICE_TOKEN` can also supply. */
  device?: { token?: string; label: string };
  compaction?: { threshold: number };
  memory?: { consolidateAt?: string };
  heartbeat?: { every?: string; activeHours?: [string, string] };
  persona?: { sleep?: [string, string]; outreach?: { enabled?: boolean; checkEvery?: string; socialThreshold?: number; quietHours?: number; dailyLimit?: number } };
  webSearch?: { provider: "brave" | "tavily" | "searxng" | "deepseek"; apiKey?: string; baseUrl?: string };
  stt?: { provider?: "openai" | "mimo"; baseUrl: string; model: string; apiKey?: string; language?: string; chunkMinutes?: number; maxMinutes?: number };
  links?: { defaultIntent?: "archive" | "read"; bilibili?: { sessdata?: string } };
  vault?: VaultConfig;
  jev?: import("../providers/jev.js").JevConfig;
  mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string>; cwd?: string } | { url: string; headers?: Record<string, string> }>;
}

export const DEFAULT_WECHAT_BASE_URL = "https://ilinkai.weixin.qq.com";
