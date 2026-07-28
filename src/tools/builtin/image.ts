/**
 * Built-in tools — Image analysis (vision-capable models).
 *
 * Ported from _archive/src/tools/builtin/image.ts. Key changes:
 *   - Uses Tool type from ../types.js (not AgentTool from pi-agent-core).
 *   - Accepts options with defaultProvider/defaultModel/allowedPaths.
 *   - File path resolution uses simplified sandbox (no filesystem.js dependency).
 *   - Vision model invocation uses process.env API keys for each provider.
 *   - Falls back gracefully with error result when no API key is configured.
 */

import { Type, type Static } from "@sinclair/typebox";
import { readFileSync, existsSync } from "fs";
import { resolve, extname } from "path";
import { realpathSync } from "fs";
import type { Tool } from "../types.js";
import { jsonResult, errorResult, readStringParam } from "../common.js";
import { completeSimple } from "@mariozechner/pi-ai";
import type { Model, Api } from "@mariozechner/pi-ai";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ImageAnalyzeToolOptions {
  /** Default provider id (e.g. "kimi", "minimax", "zhipu"). */
  defaultProvider?: string;
  /** Default model id. */
  defaultModel?: string;
  /** Sandbox roots for local-file image sources. */
  allowedPaths?: string[];
}

// ---------------------------------------------------------------------------
// Vision model resolution
// ---------------------------------------------------------------------------

/** Known vision-capable providers and their model keys. */
interface VisionCandidate {
  provider: string;
  model: string;
  envKey: string;
}

const VISION_CANDIDATES: VisionCandidate[] = [
  { provider: "kimi", model: "kimi-latest", envKey: "KIMI_API_KEY" },
  { provider: "minimax", model: "MiniMax-VL-01", envKey: "MINIMAX_API_KEY" },
];

// ---------------------------------------------------------------------------
// Image MIME type resolution
// ---------------------------------------------------------------------------

function getMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
  };
  return mimeTypes[ext] ?? "image/jpeg";
}

// ---------------------------------------------------------------------------
// Path sandbox helpers (self-contained — no filesystem.js dependency)
// ---------------------------------------------------------------------------

function resolveUserPath(allowedPaths: string[], filePath: string): string {
  return resolve(allowedPaths[0] ?? process.cwd(), filePath);
}

function isPathWithinRoot(resolved: string, roots: string[]): boolean {
  for (const root of roots) {
    const resolvedRoot = resolve(root);
    if (resolved === resolvedRoot || resolved.startsWith(resolvedRoot + "/")) {
      return true;
    }
  }
  return false;
}

/** Resolve the real path (follow symlinks) for sandbox enforcement. */
function resolveRealPathSafe(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return resolve(filePath);
  }
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createImageAnalyzeTool(
  options?: ImageAnalyzeToolOptions,
): Tool {
  const allowedPaths = options?.allowedPaths ?? [process.cwd()];

  const parameters = Type.Object({
    image: Type.String({
      description:
        "Image source: local file path, data URL, or base64 data",
    }),
    prompt: Type.Optional(
      Type.String({
        description:
          "Question or instruction about the image (default: 'Describe this image')",
      }),
    ),
    provider: Type.Optional(
      Type.String({ description: "Model provider to use" }),
    ),
    model: Type.Optional(Type.String({ description: "Specific model to use" })),
  });

  return {
    name: "image_analyze",
    label: "Image Analyze",
    description:
      "Analyze a local image (file path, data URL, or base64) using a vision-capable model. To analyze a remote image, download it first.",
    parameters,
    execute: async (_toolCallId, args, _signal, _onUpdate, _ctx) => {
      const params = args as Static<typeof parameters>;
      const image = params.image;
      const prompt =
        params.prompt ?? "Please describe this image in detail.";
      const providerParam = params.provider;
      const modelParam = params.model;

      try {
        // ── Resolve image into base64 + mediaType ──
        let base64: string;
        let mediaType: string;

        if (image.startsWith("http://") || image.startsWith("https://")) {
          return errorResult(
            "Remote URLs are not supported. Download the image first (e.g. via web_fetch) and pass a file path or base64 data.",
          );
        } else if (image.startsWith("data:")) {
          const match = image.match(/^data:([^;]+);base64,(.+)$/);
          if (!match) return errorResult("Invalid data URL format");
          mediaType = match[1]!;
          base64 = match[2]!;
        } else if (existsSync(image)) {
          const resolved = resolveUserPath(allowedPaths, image);
          const real = resolveRealPathSafe(resolved);
          if (!isPathWithinRoot(real, allowedPaths)) {
            return errorResult(`Access denied: ${image}`);
          }
          base64 = readFileSync(real).toString("base64");
          mediaType = getMimeType(real);
        } else if (/^[A-Za-z0-9+/=]+$/.test(image) && image.length > 100) {
          // Looks like raw base64
          base64 = image;
          mediaType = "image/jpeg";
        } else {
          return errorResult(
            "Invalid image source. Provide a local file path, data URL, or base64 data.",
          );
        }

        // ── Resolve vision model ──
        let selectedProvider = providerParam ?? options?.defaultProvider;
        let selectedModel = modelParam ?? options?.defaultModel;

        if (!selectedProvider || !selectedModel) {
          for (const vc of VISION_CANDIDATES) {
            if (process.env[vc.envKey]) {
              selectedProvider = vc.provider;
              selectedModel = vc.model;
              break;
            }
          }
        }

        if (!selectedProvider || !selectedModel) {
          return errorResult(
            "No vision-capable model provider configured. Set KIMI_API_KEY or MINIMAX_API_KEY environment variable.",
          );
        }

        const apiKey = process.env[`${selectedProvider.toUpperCase()}_API_KEY`];
        if (!apiKey) {
          // Map known providers to their env var name
          const envKeyMap: Record<string, string> = {
            kimi: "KIMI_API_KEY",
            minimax: "MINIMAX_API_KEY",
          };
          const key = envKeyMap[selectedProvider] ?? `${selectedProvider.toUpperCase()}_API_KEY`;
          return errorResult(
            `Missing API key for provider "${selectedProvider}". Set ${key} environment variable.`,
          );
        }

        // ── Build a minimal pi-ai model descriptor ──
        const piModel: Model<Api> = {
          id: selectedModel,
          name: selectedModel,
          api: "openai-completions" as Api,
          provider: selectedProvider as never,
          baseUrl: "",
          reasoning: false,
          input: ["text", "image"] as Array<"text" | "image">,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 8192,
        };

        // ── Call vision model ──
        const response = await completeSimple(
          piModel,
          {
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: prompt },
                  { type: "image", data: base64, mimeType: mediaType },
                ],
                timestamp: Date.now(),
              },
            ],
            tools: [],
          },
          {
            apiKey,
            maxTokens: 2048,
          },
        );

        const assistantText =
          response.content
            ?.filter(
              (c): c is { type: "text"; text: string } => c.type === "text",
            )
            .map((c) => c.text)
            .join("") ?? "";

        return jsonResult({
          status: "success",
          provider: selectedProvider,
          model: selectedModel,
          prompt,
          analysis: assistantText,
        });
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  };
}
