/**
 * Built-in tools — System (current_time, calculator, delay).
 *
 * Ported from _archive/src/tools/builtin/system.ts.
 * The delay tool respects AbortSignal for cancellation — this matters
 * because pi-coding-agent passes a signal when the user presses Escape.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { Tool } from "../types.js";
import { readStringParam, readNumberParam, jsonResult } from "../common.js";

// ---------------------------------------------------------------------------
// current_time
// ---------------------------------------------------------------------------

export function createCurrentTimeTool(): Tool {
  const parameters = Type.Object({
    timezone: Type.Optional(
      Type.String({ description: "Timezone (e.g., 'Asia/Shanghai', 'UTC')" }),
    ),
    format: Type.Optional(
      Type.String({ description: "Format: 'iso', 'locale', or 'unix'" }),
    ),
  });

  return {
    name: "current_time",
    label: "Current Time",
    description: "Get the current date and time.",
    parameters,
    execute: async (_toolCallId, args, _signal, _onUpdate, _ctx) => {
      const params = args as Static<typeof parameters>;
      const timezone = params.timezone ?? "Asia/Shanghai";
      const format = params.format ?? "locale";

      const now = new Date();

      let formatted: string | number;
      switch (format) {
        case "unix":
          formatted = Math.floor(now.getTime() / 1000);
          break;
        case "iso":
          formatted = now.toISOString();
          break;
        case "locale":
        default:
          formatted = now.toLocaleString("en-US", { timeZone: timezone });
      }

      return jsonResult({
        status: "success",
        time: formatted,
        timezone,
        timestamp: now.getTime(),
        iso: now.toISOString(),
      });
    },
  };
}

// ---------------------------------------------------------------------------
// calculator
// ---------------------------------------------------------------------------

/** Safe mathematical expression evaluator — only numeric literals, operators,
 *  parentheses, and a whitelist of Math functions are allowed. Uses `new
 *  Function()` with strict mode (no global access). The regex gate runs
 *  BEFORE the function constructor to reject attempted code injection. */
function evaluateMathExpression(expr: string): number {
  // Replace constants first so they participate in the character gate.
  let sanitized = expr
    .replace(/\bPI\b/gi, String(Math.PI))
    .replace(/\bE\b/g, String(Math.E));

  // Replace whitelisted functions recursively.
  const mathFunctions: Record<string, (x: number) => number> = {
    sqrt: Math.sqrt,
    abs: Math.abs,
    sin: Math.sin,
    cos: Math.cos,
    tan: Math.tan,
    asin: Math.asin,
    acos: Math.acos,
    atan: Math.atan,
    log: Math.log,
    log10: Math.log10,
    exp: Math.exp,
    floor: Math.floor,
    ceil: Math.ceil,
    round: Math.round,
  };

  for (const [name, fn] of Object.entries(mathFunctions)) {
    const regex = new RegExp(`\\b${name}\\s*\\(([^)]+)\\)`, "gi");
    sanitized = sanitized.replace(regex, (_match, arg) => {
      const value = evaluateMathExpression(arg);
      return String(fn(value));
    });
  }

  // Gate: only digits, whitespace, operators, and parentheses.
  if (!/^[\d\s+\-*/().]+$/.test(sanitized)) {
    throw new Error("Invalid expression: contains disallowed characters");
  }

  // Safe evaluation via strict-mode Function (no global scope access).
  const result = Function(`"use strict"; return (${sanitized})`)();

  if (typeof result !== "number" || !Number.isFinite(result)) {
    throw new Error("Result is not a valid number");
  }

  return result;
}

export function createCalculatorTool(): Tool {
  const parameters = Type.Object({
    expression: Type.String({
      description:
        "Mathematical expression to evaluate (e.g., '2 + 2', 'sqrt(16)', 'sin(PI/2)')",
    }),
  });

  return {
    name: "calculator",
    label: "Calculator",
    description:
      "Perform mathematical calculations. Supports basic arithmetic and common functions.",
    parameters,
    execute: async (_toolCallId, args, _signal, _onUpdate, _ctx) => {
      const params = args as Static<typeof parameters>;
      const expression = params.expression;

      try {
        const result = evaluateMathExpression(expression);
        return jsonResult({
          status: "success",
          expression,
          result,
        });
      } catch (error) {
        return jsonResult(
          {
            status: "error",
            expression,
            error: error instanceof Error ? error.message : String(error),
          },
          true,
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// delay
// ---------------------------------------------------------------------------

export function createDelayTool(): Tool {
  const parameters = Type.Object({
    seconds: Type.Number({
      description: "Duration to wait in seconds (max 30)",
      minimum: 0,
      maximum: 30,
    }),
  });

  return {
    name: "delay",
    label: "Delay",
    description:
      "Wait for a specified duration. Useful for testing or rate limiting.",
    parameters,
    execute: async (_toolCallId, args, signal, _onUpdate, _ctx) => {
      const params = args as Static<typeof parameters>;
      const seconds = params.seconds;

      const ms = seconds * 1000;
      const start = Date.now();

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(resolve, ms);

        signal?.addEventListener("abort", () => {
          clearTimeout(timeout);
          reject(new Error("aborted"));
        });
      });

      return jsonResult({
        status: "success",
        requested: seconds,
        actual: (Date.now() - start) / 1000,
      });
    },
  };
}
