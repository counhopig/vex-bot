import type { DecisionJudge } from "./judge.js";

/** The current request and its bounded, redacted evidence, as an advisor sees them. */
export interface AdvisedTurn {
  request: string;
  evidence: unknown[];
  /** Shared links whose action already failed in this turn. */
  blockedUrls: string[];
  /** Whether any operation result has been recorded in this turn. */
  hasResults: boolean;
}

export interface TurnAdvice {
  /** An instruction added to the model request. */
  instruction?: string;
  /** The reply must call a tool; a reply without one is treated as unsupported. */
  requireTool: boolean;
}

/** Optional outside advice for the evidence boundary: which tool to use next, and whether a reply overclaims. */
export interface TurnAdvisor {
  advise(turn: AdvisedTurn, tools: { name: string; description: string }[], signal?: AbortSignal): Promise<TurnAdvice>;
  unsupported(turn: AdvisedTurn & { reply: string }, signal?: AbortSignal): Promise<boolean>;
}

/**
 * Adapts a decision judge: a confident route to a tool is required until the turn has results, and
 * a failed link is not retried through a general tool such as the shell.
 */
export function judgeAdvisor(judge: DecisionJudge, options: { confidence: number; fallbackTools: string[] }): TurnAdvisor {
  return {
    async advise(turn, tools, signal) {
      const route = await judge.route({ request: turn.request, evidence: turn.evidence }, tools, signal);
      const requireTool = route.tool !== null && route.confidence >= options.confidence && !turn.hasResults;
      if (turn.blockedUrls.length && route.tool !== null && options.fallbackTools.includes(route.tool)) {
        return { requireTool, instruction: `A link action was denied for ${JSON.stringify(turn.blockedUrls)}. That action is terminal. Report the denial accurately.` };
      }
      return requireTool
        ? { requireTool, instruction: `Tool routing: use ${route.tool} next through the normal permission gate. Do not claim an operation without its matching tool result.` }
        : { requireTool };
    },
    async unsupported(turn, signal) {
      return await judge.unsupported({ request: turn.request, evidence: turn.evidence, reply: turn.reply }, signal) >= options.confidence;
    },
  };
}
