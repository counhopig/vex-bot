/** Advice on the next tool for the current owner request; `tool` is null when no tool is needed. */
export interface ToolRoute { tool: string | null; confidence: number }
/** The owner's intent for one shared URL. */
export interface LinkIntent { url: string; intent: "archive" | "read" | "defer"; confidence: number }

/** An external decision service: tool routing, unsupported-claim scoring and link intent. */
export interface DecisionJudge {
  route(state: unknown, tools: { name: string; description: string }[], signal?: AbortSignal): Promise<ToolRoute>;
  unsupported(state: unknown, signal?: AbortSignal): Promise<number>;
  classifyLinks?(input: string, urls: string[], signal?: AbortSignal): Promise<LinkIntent[]>;
}
