import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createModels,
  fauxProvider,
  type FauxProviderHandle,
  type MutableModels,
  type TranscriptContext,
} from "@earendil-works/pi-ai";

export function createFaux(tokensPerSecond?: number): FauxProviderHandle {
  return fauxProvider(tokensPerSecond ? { tokensPerSecond } : {});
}

export function fauxModels(faux: FauxProviderHandle): MutableModels {
  const models = createModels();
  models.setProvider(faux.provider);
  return models;
}

export function fauxStreamFn(faux: FauxProviderHandle): StreamFn {
  const models = fauxModels(faux);
  return (model, context, options) => models.streamSimple(model, context, options);
}

export function lastUserText(context: TranscriptContext): string {
  const last = [...context.messages].reverse().find((m) => m.role === "user");
  if (!last || last.role !== "user") return "";
  return typeof last.content === "string"
    ? last.content
    : last.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}
