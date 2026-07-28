/**
 * Tool system — common utility functions.
 *
 * Result builders (jsonResult, textResult, errorResult, imageResult),
 * typed param readers (readStringParam, readNumberParam, readBooleanParam,
 * readStringArrayParam), and truncation helpers. Every built-in tool
 * imports from here instead of hand-rolling its own result packing.
 */

import type { ToolResult } from "./types.js";

// ---------------------------------------------------------------------------
// Result builders
// ---------------------------------------------------------------------------

/** Create a JSON-formatted success/error result. */
export function jsonResult(
  payload: unknown,
  isError = false,
): ToolResult<unknown> {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
    isError,
  } as ToolResult<unknown>;
}

/** Create a plain-text result. */
export function textResult(
  text: string,
  details?: unknown,
  isError = false,
): ToolResult<unknown> {
  return {
    content: [{ type: "text", text }],
    details: details ?? {},
    isError,
  } as ToolResult<unknown>;
}

/** Create a structured error result. */
export function errorResult(error: string | Error): ToolResult<unknown> {
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
  } as ToolResult<unknown>;
}

/** Create an image result with a text prefix block. */
export function imageResult(params: {
  label: string;
  base64: string;
  mimeType: string;
  extraText?: string;
  details?: Record<string, unknown>;
}): ToolResult<unknown> {
  const content: ToolResult["content"] = [
    {
      type: "text",
      text: params.extraText ?? `[Image: ${params.label}]`,
    },
    { type: "image", data: params.base64, mimeType: params.mimeType },
  ];
  return {
    content,
    details: params.details ?? {},
  } as ToolResult<unknown>;
}

// ---------------------------------------------------------------------------
// Param readers
// ---------------------------------------------------------------------------

/** Read a required/optional string parameter with validation. */
export function readStringParam(
  params: Record<string, unknown>,
  key: string,
  options: { required?: boolean; trim?: boolean; label?: string } = {},
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

/** Read a required/optional number parameter with range validation. */
export function readNumberParam(
  params: Record<string, unknown>,
  key: string,
  options: { required?: boolean; min?: number; max?: number; label?: string } = {},
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

/** Read a boolean parameter with coercion. */
export function readBooleanParam(
  params: Record<string, unknown>,
  key: string,
  options: { defaultValue?: boolean } = {},
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

/** Read a string array parameter — accepts real arrays or comma-separated strings. */
export function readStringArrayParam(
  params: Record<string, unknown>,
  key: string,
  options: { required?: boolean; label?: string } = {},
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

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------

/** Truncate text to maxLength characters, appending a truncation marker. */
export function truncateToolText(text: string, maxLength = 8000): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "\n...[truncated]";
}
