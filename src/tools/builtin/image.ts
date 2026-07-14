/**
 * Built-in tool - Image analysis
 */

import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { jsonResult, errorResult, readStringParam } from "../common.js";
import { resolveModel, getApiKeyForProvider, isProviderAvailable } from "../../providers/index.js";
import { resolveUserPath, isRealPathAllowed } from "./filesystem.js";
import type { ProviderId } from "../../types/index.js";
import { readFileSync, existsSync } from "fs";
import { extname } from "path";
import { completeSimple } from "@mariozechner/pi-ai";
import type { TextContent, ImageContent } from "@mariozechner/pi-ai";

/** Image analysis tool options */
export interface ImageAnalyzeToolOptions {
  defaultProvider?: ProviderId;
  defaultModel?: string;
  /** Sandbox roots for local-file image sources (defaults to process.cwd()). */
  allowedPaths?: string[];
}

/** Get MIME type for an image */
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

/** Build the multimodal user-message content: the prompt plus the image itself
 *  as a real image block, so the vision model actually receives the pixels
 *  (the old code sent a text placeholder and the "analysis" was hallucinated). */
export function buildImageAnalysisContent(
  prompt: string,
  base64: string,
  mimeType: string,
): (TextContent | ImageContent)[] {
  return [
    { type: "text", text: prompt },
    { type: "image", data: base64, mimeType },
  ];
}

/** Image analysis tool */
export function createImageAnalyzeTool(options?: ImageAnalyzeToolOptions): AgentTool {
  const allowedPaths = options?.allowedPaths ?? [process.cwd()];
  return {
    name: "image_analyze",
    label: "Image Analyze",
    description: "Analyze a local image (file path, data URL, or base64) using a vision-capable model. To analyze a remote image, download it first.",
    parameters: Type.Object({
      image: Type.String({ description: "Image source: local file path, data URL, or base64 data" }),
      prompt: Type.Optional(Type.String({ description: "Question or instruction about the image (default: 'Describe this image')" })),
      provider: Type.Optional(Type.String({ description: "Model provider to use" })),
      model: Type.Optional(Type.String({ description: "Specific model to use" })),
    }),
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const image = readStringParam(params, "image", { required: true })!;
      const prompt = readStringParam(params, "prompt") ?? "Please describe this image in detail.";
      const providerParam = readStringParam(params, "provider") as ProviderId | undefined;
      const modelParam = readStringParam(params, "model");

      try {
        // Resolve the image into base64 + media type. Remote URLs are rejected:
        // pi-ai carries images as base64 only, so a URL would mean fetching it
        // here — a second, unguarded SSRF surface. Callers must download first.
        let base64: string;
        let mediaType: string;

        if (image.startsWith("http://") || image.startsWith("https://")) {
          return errorResult("Remote URLs are not supported. Download the image first (e.g. via web_fetch) and pass a file path or base64 data.");
        } else if (image.startsWith("data:")) {
          const match = image.match(/^data:([^;]+);base64,(.+)$/);
          if (!match) return errorResult("Invalid data URL format");
          mediaType = match[1]!;
          base64 = match[2]!;
        } else if (existsSync(image)) {
          const resolved = resolveUserPath(allowedPaths, image);
          if (!(await isRealPathAllowed(resolved, allowedPaths))) {
            return errorResult(`Access denied: ${image}`);
          }
          base64 = readFileSync(resolved).toString("base64");
          mediaType = getMimeType(resolved);
        } else if (/^[A-Za-z0-9+/=]+$/.test(image) && image.length > 100) {
          base64 = image;
          mediaType = "image/jpeg";
        } else {
          return errorResult("Invalid image source. Provide a local file path, data URL, or base64 data.");
        }

        // Find vision-capable models
        const visionCandidates: Array<{ provider: ProviderId; model: string }> = [
          { provider: "kimi", model: "kimi-latest" },
          { provider: "minimax", model: "MiniMax-VL-01" },
          { provider: "stepfun", model: "step-1v-8k" },
        ];

        let selectedProvider = providerParam ?? options?.defaultProvider;
        let selectedModel = modelParam ?? options?.defaultModel;

        if (!selectedProvider || !selectedModel) {
          for (const vm of visionCandidates) {
            if (isProviderAvailable(vm.provider)) {
              selectedProvider = vm.provider;
              selectedModel = vm.model;
              break;
            }
          }
        }

        if (!selectedProvider || !selectedModel) {
          return errorResult("No vision-capable model provider available");
        }

        const piModel = resolveModel(selectedProvider, selectedModel);
        if (!piModel) {
          return errorResult(`Cannot resolve model ${selectedProvider}/${selectedModel}`);
        }

        const apiKey = getApiKeyForProvider(selectedProvider);

        const response = await completeSimple(piModel, {
          messages: [{ role: "user" as const, content: buildImageAnalysisContent(prompt, base64, mediaType), timestamp: Date.now() }],
          tools: [],
        }, {
          apiKey,
          maxTokens: 2048,
        });

        const assistantText = response.content
          ?.filter((c): c is { type: "text"; text: string } => c.type === "text")
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
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
