/**
 * Tool system - common utility functions
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";

export type VexToolResult<T = unknown> = AgentToolResult<T> & {
  isError?: boolean;
};

/** Create a JSON result */
export function jsonResult(payload: unknown, isError = false): VexToolResult<unknown> {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
    details: payload,
    isError,
  };
}

/** Create a text result */
export function textResult(text: string, details?: unknown, isError = false): VexToolResult<unknown> {
  return {
    content: [{ type: "text", text }],
    details: details ?? {},
    isError,
  };
}

/** Create an error result */
export function errorResult(error: string | Error): VexToolResult<unknown> {
  const message = error instanceof Error ? error.message : error;
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ status: "error", error: message }, null, 2),
      },
    ],
    details: { status: "error", error: message },
    isError: true,
  };
}

/** Create an image result */
export function imageResult(params: {
  label: string;
  base64: string;
  mimeType: string;
  extraText?: string;
  details?: Record<string, unknown>;
}): AgentToolResult<unknown> {
  const content = [
    { type: "text" as const, text: params.extraText ?? `[Image: ${params.label}]` },
    { type: "image" as const, data: params.base64, mimeType: params.mimeType },
  ];
  return {
    content,
    details: params.details ?? {},
  };
}

/** Read a string parameter */
export function readStringParam(
  params: Record<string, unknown>,
  key: string,
  options: { required?: boolean; trim?: boolean; label?: string } = {}
): string | undefined {
  const raw = params[key];
  if (typeof raw !== "string") {
    if (options.required) {
      throw new Error(`${options.label ?? key} is required`);
    }
    return undefined;
  }
  const value = options.trim !== false ? raw.trim() : raw;
  if (!value && options.required) {
    throw new Error(`${options.label ?? key} is required`);
  }
  return value || undefined;
}

/** Read a number parameter */
export function readNumberParam(
  params: Record<string, unknown>,
  key: string,
  options: { required?: boolean; min?: number; max?: number; label?: string } = {}
): number | undefined {
  const raw = params[key];
  if (raw === undefined || raw === null) {
    if (options.required) {
      throw new Error(`${options.label ?? key} is required`);
    }
    return undefined;
  }

  const value = typeof raw === "number" ? raw : Number(raw);
  if (Number.isNaN(value)) {
    throw new Error(`${options.label ?? key} must be a number`);
  }

  if (options.min !== undefined && value < options.min) {
    throw new Error(`${options.label ?? key} must be >= ${options.min}`);
  }
  if (options.max !== undefined && value > options.max) {
    throw new Error(`${options.label ?? key} must be <= ${options.max}`);
  }

  return value;
}

/** Read a boolean parameter */
export function readBooleanParam(
  params: Record<string, unknown>,
  key: string,
  options: { defaultValue?: boolean } = {}
): boolean {
  const raw = params[key];
  if (raw === undefined || raw === null) {
    return options.defaultValue ?? false;
  }
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") {
    return raw.toLowerCase() === "true" || raw === "1";
  }
  return Boolean(raw);
}

/** Read a string array parameter */
export function readStringArrayParam(
  params: Record<string, unknown>,
  key: string,
  options: { required?: boolean; label?: string } = {}
): string[] | undefined {
  const raw = params[key];
  if (raw === undefined || raw === null) {
    if (options.required) {
      throw new Error(`${options.label ?? key} is required`);
    }
    return undefined;
  }

  if (Array.isArray(raw)) {
    return raw.map((item) => String(item));
  }

  if (typeof raw === "string") {
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  }

  throw new Error(`${options.label ?? key} must be an array`);
}

/** Truncate text */
export function truncateToolText(text: string, maxLength = 8000): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "\n...[truncated]";
}
