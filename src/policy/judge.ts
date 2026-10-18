/** Advice on the next tool for the current owner request; `tool` is null when no tool is needed. */
export interface ToolRoute { tool: string | null; confidence: number }

/** An external decision service: tool routing and unsupported-claim scoring. */
export interface DecisionJudge {
  route(state: unknown, tools: { name: string; description: string }[], signal?: AbortSignal): Promise<ToolRoute>;
  unsupported(state: unknown, signal?: AbortSignal): Promise<number>;
}
